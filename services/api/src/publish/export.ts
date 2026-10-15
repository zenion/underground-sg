// The private full export of HEAD (docs/head-export-format.md): every row of every HEAD table,
// anchors and private columns included, in the diff format's row format with its id and rev. The
// publish transaction builds it inside the transaction, so it is exactly the HEAD the version
// publishes, and uploads it to the private exports bucket before it inserts map_versions.

import {
  HEAD_EXPORT_SCHEMA_VERSION,
  type HeadAnchor,
  type HeadEdge,
  type HeadExport,
  type HeadLevel,
  type HeadNode,
  type HeadPoi,
  type HeadSpace,
  type HeadVenue,
  type LineStringGeometry,
  type MultiPolygonGeometry,
  type PointGeometry,
  type PolygonGeometry,
} from "@usg/contracts";
import { validateHeadExport } from "@usg/contracts/validators";
import { type Kysely, sql } from "kysely";
import type { Database } from "../database.ts";
import { singaporeDateTime } from "../time.ts";

/** The export would fail its schema or checks; nothing may be uploaded. */
export class ExportInvalidError extends Error {
  override name = "ExportInvalidError";
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `The HEAD export fails validation (${problems.length} problems): ${problems.slice(0, 5).join("; ")}`,
    );
    this.problems = problems;
  }
}

export interface HeadExportInput {
  /** map_versions.id of the version being published. */
  readonly version: number;
  /** map_versions.published_at. */
  readonly publishedAt: Date;
  readonly snapshotSha256: string;
}

function parse<G>(geometry: string | null): G | null {
  if (geometry === null) return null;
  const parsed = JSON.parse(geometry) as { type: string; coordinates: unknown };
  return { type: parsed.type, coordinates: parsed.coordinates } as G;
}

function byId<T extends { id: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** GeoJSON with 7 decimals, as the diff format writes it. */
const geo = (column: string) => sql<string | null>`ST_AsGeoJSON(${sql.ref(column)}, 7)`;
/** Absent text is null, never "". */
const text = (column: string) => sql<string | null>`NULLIF(${sql.ref(column)}, '')`;

/**
 * Reads HEAD into an export and validates it (`validateHeadExport`). Run it inside the publish
 * transaction, after the change sets are applied. Throws ExportInvalidError if it fails.
 */
export async function buildHeadExport(
  db: Kysely<Database>,
  input: HeadExportInput,
): Promise<HeadExport> {
  const venues = await db
    .selectFrom("venues")
    .select([
      "id",
      "rev",
      "name",
      "kind",
      text("operator").as("operator"),
      text("permission").as("permission"),
      geo("footprint").as("footprint"),
    ])
    .execute();
  const levels = await db
    .selectFrom("levels")
    .select(["id", "rev", "venue_id", "ordinal", "name", "elevation_m", "sort_key"])
    .execute();
  const spaces = await db
    .selectFrom("spaces")
    .select(["id", "rev", "level_id", "kind", text("name").as("name"), geo("geom").as("geom")])
    .execute();
  const nodes = await db
    .selectFrom("nodes")
    .select([
      "id",
      "rev",
      "level_id",
      "kind",
      text("name").as("name"),
      text("street_name").as("street_name"),
      "connector_id",
      "elevation_m",
      geo("geom").as("geom"),
    ])
    .execute();
  const edges = await db
    .selectFrom("edges")
    .select([
      "id",
      "rev",
      "from_node",
      "to_node",
      "kind",
      "oneway",
      "access",
      text("opening_hours").as("opening_hours"),
      "level_id",
      "connector_id",
      "length_m",
      "step_free",
      "sheltered",
      "outdoor",
      geo("geom").as("geom"),
    ])
    .execute();
  const pois = await db
    .selectFrom("pois")
    .select(["id", "rev", "space_id", "level_id", "name", "category", geo("geom").as("geom")])
    .execute();
  const anchors = await db
    .selectFrom("anchors")
    .select([
      "id",
      "rev",
      "node_id",
      "kind",
      "name",
      "level_id",
      "facing_deg",
      geo("surveyed_geom").as("surveyed_geom"),
      "prior_source",
      "prior_sigma_m",
      text("photo_uri").as("photo_uri"),
    ])
    .execute();

  const document: HeadExport = {
    schema_version: HEAD_EXPORT_SCHEMA_VERSION,
    version: input.version,
    published_at: singaporeDateTime(input.publishedAt),
    snapshot_sha256: input.snapshotSha256,
    venues: byId(
      venues.map(
        (r): HeadVenue => ({
          id: r.id,
          rev: r.rev,
          permission: r.permission,
          row: {
            name: r.name,
            kind: r.kind,
            operator: r.operator,
            footprint: parse<MultiPolygonGeometry>(r.footprint),
          },
        }),
      ),
    ),
    levels: byId(
      levels.map(
        (r): HeadLevel => ({
          id: r.id,
          rev: r.rev,
          row: {
            venue_id: r.venue_id,
            ordinal: r.ordinal,
            name: r.name,
            elevation_m: r.elevation_m,
            sort_key: r.sort_key,
          },
        }),
      ),
    ),
    spaces: byId(
      spaces.map(
        (r): HeadSpace => ({
          id: r.id,
          rev: r.rev,
          row: {
            level_id: r.level_id,
            kind: r.kind,
            name: r.name,
            geom: parse<PolygonGeometry>(r.geom) as PolygonGeometry,
          },
        }),
      ),
    ),
    nodes: byId(
      nodes.map(
        (r): HeadNode => ({
          id: r.id,
          rev: r.rev,
          row: {
            level_id: r.level_id,
            kind: r.kind,
            name: r.name,
            street_name: r.street_name,
            connector_id: r.connector_id,
            elevation_m: r.elevation_m,
            geom: parse<PointGeometry>(r.geom) as PointGeometry,
          },
        }),
      ),
    ),
    edges: byId(
      edges.map(
        (r): HeadEdge => ({
          id: r.id,
          rev: r.rev,
          row: {
            from_node: r.from_node,
            to_node: r.to_node,
            kind: r.kind,
            oneway: r.oneway,
            access: r.access,
            opening_hours: r.opening_hours,
            level_id: r.level_id,
            connector_id: r.connector_id,
            length_m: r.length_m,
            step_free: r.step_free,
            sheltered: r.sheltered,
            outdoor: r.outdoor,
            geom: parse<LineStringGeometry>(r.geom),
          },
        }),
      ),
    ),
    pois: byId(
      pois.map(
        (r): HeadPoi => ({
          id: r.id,
          rev: r.rev,
          row: {
            space_id: r.space_id,
            level_id: r.level_id,
            name: r.name,
            category: r.category,
            geom: parse<PointGeometry>(r.geom) as PointGeometry,
          },
        }),
      ),
    ),
    anchors: byId(
      anchors.map(
        (r): HeadAnchor => ({
          id: r.id,
          rev: r.rev,
          row: {
            node_id: r.node_id,
            kind: r.kind,
            name: r.name,
            level_id: r.level_id,
            facing_deg: r.facing_deg,
            surveyed_geom: parse<PointGeometry>(r.surveyed_geom),
            prior_source: r.prior_source,
            prior_sigma_m: r.prior_sigma_m,
            photo_uri: r.photo_uri,
          },
        }),
      ),
    ),
  };

  const validation = validateHeadExport(document);
  if (!validation.valid) throw new ExportInvalidError(validation.problems);
  return document;
}

/** The export as stored before compression: compact UTF-8 JSON. */
export function serialiseExport(document: HeadExport): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(document));
}
