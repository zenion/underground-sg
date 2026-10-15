// The snapshot builder: HEAD tables and the street graph to a version's public files, indoor.json
// and street.json, exactly as docs/snapshot-format.md sets out. A library function: the publish
// transaction calls it (from a CLI now, later from a worker or the approval path), never an HTTP
// route, since heavy work never runs in the API process.
//
// - Only the columns the format lists are selected, by name: nothing private (anchors, restricted
//   zones, permissions, operators, revs, bookkeeping times, node heights, other OSM tags) is read.
// - Deterministic: features sorted as the format says, members in its order, compact UTF-8 JSON,
//   coordinates from ST_AsGeoJSON(geom, 7), lengths and heights rounded to 2 decimals. The same
//   HEAD and street graph always give the same bytes, and so the same content-addressed directory.
// - Every line runs from its start node to its end node, with its ends set exactly to their
//   points: the stored line (reversed first if it runs the other way, compared in SVY21), or a
//   straight line when HEAD has none. Polygon rings are written counterclockwise (RFC 7946).
// - The files are parsed back and checked with validateVersion before anything uses them.

import {
  type IndoorFeature,
  type IndoorSnapshot,
  type LineStringGeometry,
  type MultiPolygonGeometry,
  type PointGeometry,
  type PolygonGeometry,
  SNAPSHOT_SCHEMA_VERSION,
  type StreetFeature,
  type StreetSnapshot,
  snapshotDirectory,
  type VersionFileName,
} from "@usg/contracts";
import {
  sha256Hex,
  snapshotSha256,
  streetConnectorId,
  validateVersion,
} from "@usg/contracts/validators";
import { type Kysely, type RawBuilder, sql } from "kysely";
import type { Database } from "../database.ts";

/** street.json's `source`: fixed by the schema, so the ODbL attribution travels with the data. */
export const STREET_SOURCE: StreetSnapshot["source"] = {
  name: "OpenStreetMap",
  licence: "ODbL-1.0",
  licence_url: "https://opendatacommons.org/licenses/odbl/1-0/",
  attribution: "© OpenStreetMap contributors",
  attribution_url: "https://www.openstreetmap.org/copyright",
};

/** One file of a version, as uploaded: its bytes (UTF-8 JSON, before any content encoding). */
export interface VersionFile {
  readonly name: VersionFileName;
  readonly bytes: Uint8Array;
  /** SHA-256 of `bytes`, as latest.json lists it. */
  readonly sha256: string;
}

export interface BuiltSnapshot {
  readonly indoor: IndoorSnapshot;
  readonly street: StreetSnapshot;
  readonly files: { readonly [Name in VersionFileName]: VersionFile };
  /** `map_versions.snapshot_sha256`: the SHA-256 of the files' `sha256sum --text` lines. */
  readonly snapshotSha256: string;
  /** `map_versions.snapshot_uri`: `snapshots/<snapshot_sha256>/`. */
  readonly directory: string;
}

/** The built files failed validateVersion; nothing may be uploaded. */
export class SnapshotInvalidError extends Error {
  override name = "SnapshotInvalidError";
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `The snapshot fails validation (${problems.length} problems): ${problems.slice(0, 5).join("; ")}`,
    );
    this.problems = problems;
  }
}

/**
 * Builds a version's files from HEAD and the street graph. Inside a transaction (the publish
 * transaction, after it has applied its change sets and rebuilt the street connectors) it reads
 * what that transaction sees; otherwise it reads one consistent snapshot in a read-only
 * REPEATABLE READ transaction of its own. Throws SnapshotInvalidError if the files would fail
 * validateVersion.
 */
export async function buildSnapshot(db: Kysely<Database>): Promise<BuiltSnapshot> {
  if (!db.isTransaction) {
    return db
      .transaction()
      .setIsolationLevel("repeatable read")
      .setAccessMode("read only")
      .execute((trx) => buildSnapshot(trx));
  }
  const indoor: IndoorSnapshot = {
    type: "FeatureCollection",
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    features: await indoorFeatures(db),
  };
  const street: StreetSnapshot = {
    type: "FeatureCollection",
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    source: STREET_SOURCE,
    features: await streetFeatures(db),
  };
  const indoorBytes = serialise(indoor);
  const streetBytes = serialise(street);

  // Validate what will be uploaded: the bytes, parsed back.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const validation = validateVersion(
    JSON.parse(decoder.decode(indoorBytes)),
    JSON.parse(decoder.decode(streetBytes)),
  );
  if (!validation.valid) throw new SnapshotInvalidError(validation.problems);

  const hash = snapshotSha256({ "indoor.json": indoorBytes, "street.json": streetBytes });
  return {
    indoor,
    street,
    files: {
      "indoor.json": { name: "indoor.json", bytes: indoorBytes, sha256: sha256Hex(indoorBytes) },
      "street.json": { name: "street.json", bytes: streetBytes, sha256: sha256Hex(streetBytes) },
    },
    snapshotSha256: hash,
    directory: snapshotDirectory(hash),
  };
}

/** Compact JSON as UTF-8, no byte order mark, no trailing newline. */
export function serialise(document: IndoorSnapshot | StreetSnapshot): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(document));
}

// ---------------------------------------------------------------- SQL helpers

/**
 * SQL for a line from `from` to `to`: `line` reversed if it runs the other way (compared in
 * SVY21), with its first and last positions set to the two points; a straight line when `line` is
 * NULL. Its ends then come out of ST_AsGeoJSON(…, 7) exactly as the points do. The arguments are
 * SQL expressions (column names), never data. The restricted-zone gate draws lines the same way.
 */
export function lineFromTo(line: string, from: string, to: string): RawBuilder<unknown> {
  const [l, f, t] = [sql.raw(line), sql.raw(from), sql.raw(to)];
  const svy21 = (g: RawBuilder<unknown>) => sql`ST_Transform(${g}, 3414)`;
  const reversed = sql`(ST_Distance(${svy21(sql`ST_StartPoint(${l})`)}, ${svy21(t)})
                      + ST_Distance(${svy21(sql`ST_EndPoint(${l})`)}, ${svy21(f)}))
                     < (ST_Distance(${svy21(sql`ST_StartPoint(${l})`)}, ${svy21(f)})
                      + ST_Distance(${svy21(sql`ST_EndPoint(${l})`)}, ${svy21(t)}))`;
  const oriented = sql`CASE WHEN ${reversed} THEN ST_Reverse(${l}) ELSE ${l} END`;
  return sql`CASE WHEN ${l} IS NULL THEN ST_MakeLine(${f}, ${t})
                  ELSE ST_SetPoint(ST_SetPoint(${oriented}, 0, ${f}), -1, ${t}) END`;
}

/** ST_AsGeoJSON with 7 decimals (about 1 cm). */
function geoJson(geometry: RawBuilder<unknown> | string): RawBuilder<string> {
  const g = typeof geometry === "string" ? sql.raw(geometry) : geometry;
  return sql<string>`ST_AsGeoJSON(${g}, 7)`;
}

/** A metre value rounded to 2 decimals, as a float8 (a JS number), or NULL. */
function metres(column: string): RawBuilder<number> {
  return sql<number>`round(${sql.raw(column)}::numeric, 2)::float8`;
}

/** Absent text is null, never "". */
function text(column: string): RawBuilder<string | null> {
  return sql<string | null>`NULLIF(${sql.raw(column)}, '')`;
}

function parse<G>(geometry: string): G {
  const parsed = JSON.parse(geometry) as { type: string; coordinates: unknown };
  // Rebuilt so the members are in the format's order whatever ST_AsGeoJSON writes.
  return { type: parsed.type, coordinates: parsed.coordinates } as G;
}

/** An OpenStreetMap id (bigint, read as text) as a JSON number; refused beyond 2^53. */
function osmId(value: string | number): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`OSM id ${value} is not a safe integer`);
  return id;
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------- indoor.json

async function indoorFeatures(db: Kysely<Database>): Promise<IndoorFeature[]> {
  const venues = await sql<{
    id: string;
    name: string;
    kind: string;
    geometry: string | null;
  }>`SELECT v.id, v.name, v.kind,
            ${geoJson("ST_ForcePolygonCCW(v.footprint)")} AS geometry
       FROM venues v`.execute(db);

  const levels = await sql<{
    id: string;
    venue_id: string;
    name: string;
    ordinal: number;
    sort_key: number;
    elevation_m: number | null;
  }>`SELECT l.id, l.venue_id, l.name, l.ordinal, l.sort_key,
            ${metres("l.elevation_m")} AS elevation_m
       FROM levels l`.execute(db);

  const spaces = await sql<{
    id: string;
    level_id: string;
    ordinal: number;
    kind: string;
    name: string | null;
    geometry: string;
  }>`SELECT s.id, s.level_id, l.ordinal, s.kind, ${text("s.name")} AS name,
            ${geoJson("ST_ForcePolygonCCW(s.geom)")} AS geometry
       FROM spaces s JOIN levels l ON l.id = s.level_id`.execute(db);

  const nodes = await sql<{
    id: string;
    level_id: string | null;
    ordinal: number;
    kind: string;
    name: string | null;
    street_name: string | null;
    connector_id: string | null;
    geometry: string;
  }>`SELECT n.id, n.level_id, n.ordinal, n.kind, ${text("n.name")} AS name,
            ${text("n.street_name")} AS street_name, n.connector_id,
            ${geoJson("n.geom")} AS geometry
       FROM nodes n`.execute(db);

  const edges = await sql<{
    id: string;
    from_node: string;
    to_node: string;
    from_ordinal: number;
    to_ordinal: number;
    level_id: string | null;
    kind: string;
    connector_id: string | null;
    oneway: boolean;
    access: string;
    opening_hours: string | null;
    length_m: number;
    step_free: boolean;
    sheltered: boolean;
    outdoor: boolean;
    geometry: string;
  }>`SELECT e.id, e.from_node, e.to_node, f.ordinal AS from_ordinal, t.ordinal AS to_ordinal,
            e.level_id, e.kind, e.connector_id, e.oneway, e.access,
            ${text("e.opening_hours")} AS opening_hours, ${metres("e.length_m")} AS length_m,
            e.step_free, e.sheltered, e.outdoor,
            ${geoJson(lineFromTo("e.geom", "f.geom", "t.geom"))} AS geometry
       FROM edges e
       JOIN nodes f ON f.id = e.from_node
       JOIN nodes t ON t.id = e.to_node`.execute(db);

  const pois = await sql<{
    id: string;
    level_id: string;
    ordinal: number;
    space_id: string | null;
    name: string;
    category: string;
    geometry: string;
  }>`SELECT p.id, p.level_id, l.ordinal, p.space_id, p.name, p.category,
            ${geoJson("p.geom")} AS geometry
       FROM pois p JOIN levels l ON l.id = p.level_id`.execute(db);

  const connectors = await sql<{
    node_id: string;
    osm_node_id: string;
    ordinal: number;
    length_m: number;
    geometry: string;
  }>`SELECT c.node_id, c.osm_node_id, n.ordinal, ${metres("c.length_m")} AS length_m,
            ${geoJson(lineFromTo("c.geom", "n.geom", "s.geom"))} AS geometry
       FROM street_connectors c
       JOIN nodes n ON n.id = c.node_id
       JOIN street_nodes s ON s.osm_node_id = c.osm_node_id`.execute(db);

  // Built in the format's type order (venue, level, space, node, edge, poi, street_connector),
  // each type sorted by id, with members in the format's order.
  const features: IndoorFeature[] = [];
  for (const r of venues.rows.sort(byId)) {
    features.push({
      type: "Feature",
      id: r.id,
      properties: { feature_type: "venue", id: r.id, name: r.name, kind: r.kind },
      geometry: r.geometry === null ? null : parse<MultiPolygonGeometry>(r.geometry),
    } as IndoorFeature);
  }
  for (const r of levels.rows.sort(byId)) {
    features.push({
      type: "Feature",
      id: r.id,
      properties: {
        feature_type: "level",
        id: r.id,
        venue_id: r.venue_id,
        name: r.name,
        ordinal: r.ordinal,
        sort_key: r.sort_key,
        elevation_m: r.elevation_m,
      },
      geometry: null,
    });
  }
  for (const r of spaces.rows.sort(byId)) {
    features.push({
      type: "Feature",
      id: r.id,
      properties: {
        feature_type: "space",
        id: r.id,
        level_id: r.level_id,
        ordinal: r.ordinal,
        kind: r.kind,
        name: r.name,
      },
      geometry: parse<PolygonGeometry>(r.geometry),
    } as IndoorFeature);
  }
  for (const r of nodes.rows.sort(byId)) {
    features.push({
      type: "Feature",
      id: r.id,
      properties: {
        feature_type: "node",
        id: r.id,
        level_id: r.level_id,
        ordinal: r.ordinal,
        kind: r.kind,
        name: r.name,
        street_name: r.street_name,
        connector_id: r.connector_id,
      },
      geometry: parse<PointGeometry>(r.geometry),
    } as IndoorFeature);
  }
  for (const r of edges.rows.sort(byId)) {
    features.push({
      type: "Feature",
      id: r.id,
      properties: {
        feature_type: "edge",
        id: r.id,
        from_node: r.from_node,
        to_node: r.to_node,
        from_ordinal: r.from_ordinal,
        to_ordinal: r.to_ordinal,
        level_id: r.level_id,
        kind: r.kind,
        connector_id: r.connector_id,
        oneway: r.oneway,
        access: r.access,
        opening_hours: r.opening_hours,
        length_m: r.length_m,
        step_free: r.step_free,
        sheltered: r.sheltered,
        outdoor: r.outdoor,
      },
      geometry: parse<LineStringGeometry>(r.geometry),
    } as IndoorFeature);
  }
  for (const r of pois.rows.sort(byId)) {
    features.push({
      type: "Feature",
      id: r.id,
      properties: {
        feature_type: "poi",
        id: r.id,
        level_id: r.level_id,
        ordinal: r.ordinal,
        space_id: r.space_id,
        name: r.name,
        category: r.category,
      },
      geometry: parse<PointGeometry>(r.geometry),
    } as IndoorFeature);
  }
  const withIds = connectors.rows.map((r) => ({ ...r, id: streetConnectorId(r.node_id) }));
  for (const r of withIds.sort(byId)) {
    features.push({
      type: "Feature",
      id: r.id,
      properties: {
        feature_type: "street_connector",
        id: r.id,
        node_id: r.node_id,
        osm_node_id: osmId(r.osm_node_id),
        ordinal: r.ordinal,
        length_m: r.length_m,
      },
      geometry: parse<LineStringGeometry>(r.geometry),
    });
  }
  return features;
}

// ---------------------------------------------------------------- street.json

async function streetFeatures(db: Kysely<Database>): Promise<StreetFeature[]> {
  const nodes = await sql<{
    osm_node_id: string;
    geometry: string;
  }>`SELECT s.osm_node_id, ${geoJson("s.geom")} AS geometry FROM street_nodes s`.execute(db);

  // Only highway and footway of the way's tags are published.
  const edges = await sql<{
    osm_way_id: string;
    from_osm_node: string;
    to_osm_node: string;
    highway: string | null;
    footway: string | null;
    covered: boolean;
    length_m: number;
    geometry: string;
  }>`SELECT e.osm_way_id, e.from_osm_node, e.to_osm_node,
            ${text("e.tags->>'highway'")} AS highway, ${text("e.tags->>'footway'")} AS footway,
            e.covered, ${metres("e.length_m")} AS length_m,
            ${geoJson(lineFromTo("e.geom", "f.geom", "t.geom"))} AS geometry
       FROM street_edges e
       JOIN street_nodes f ON f.osm_node_id = e.from_osm_node
       JOIN street_nodes t ON t.osm_node_id = e.to_osm_node`.execute(db);

  const features: StreetFeature[] = nodes.rows
    .map((r) => ({ id: osmId(r.osm_node_id), geometry: r.geometry }))
    .sort((a, b) => a.id - b.id)
    .map((r) => ({
      type: "Feature",
      id: r.id,
      properties: { feature_type: "street_node" },
      geometry: parse<PointGeometry>(r.geometry),
    }));
  const sortedEdges = edges.rows
    .map((r) => ({
      ...r,
      way: osmId(r.osm_way_id),
      from: osmId(r.from_osm_node),
      to: osmId(r.to_osm_node),
    }))
    .sort((a, b) => a.way - b.way || a.from - b.from || a.to - b.to);
  for (const r of sortedEdges) {
    features.push({
      type: "Feature",
      properties: {
        feature_type: "street_edge",
        osm_way_id: r.way,
        from_osm_node: r.from,
        to_osm_node: r.to,
        highway: r.highway,
        footway: r.footway,
        covered: r.covered,
        length_m: r.length_m,
      },
      geometry: parse<LineStringGeometry>(r.geometry),
    });
  }
  return features;
}
