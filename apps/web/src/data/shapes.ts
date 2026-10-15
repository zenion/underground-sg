// Defensive shape checks for the public map files the webapp reads (docs/snapshot-format.md). The
// snapshot builder validates every file against its JSON Schema before it publishes it, but the
// browser can still be handed something else: an HTML page from a misconfigured proxy or host, a
// file in a newer format than this build understands, or a truncated response. Ajv and the Node
// validators (@usg/contracts/validators) stay out of the browser bundle, so these checks are
// written by hand: every field the webapp or the style reads, with its type, its enum and its
// geometry. A file that passes has the shape of the generated @usg/contracts types. The checks
// across features that the schemas leave to code (checkIndoorSnapshot and the others) don't block
// drawing; loadMap reports them as warnings.

import {
  checkLatestPointer,
  checkStatusOverlay,
  EDGE_ACCESS_VALUES,
  EDGE_KINDS,
  INDOOR_FEATURE_TYPES,
  type IndoorSnapshot,
  type LatestPointer,
  NODE_KINDS,
  POI_CATEGORIES,
  SNAPSHOT_SCHEMA_VERSION,
  SPACE_KINDS,
  type StatusOverlay,
  type StreetSnapshot,
  VENUE_KINDS,
} from "@usg/contracts";

/** A public file that doesn't have the shape this build expects. */
export class DataShapeError extends Error {
  readonly file: string;

  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = "DataShapeError";
    this.file = file;
  }
}

/**
 * A public file in a newer format than this build reads (an integer `schema_version` above
 * SNAPSHOT_SCHEMA_VERSION): the published map is newer than the page, so a reload should help.
 * Any other wrong `schema_version` (missing, text, lower) is a plain DataShapeError.
 */
export class UnsupportedFormatError extends DataShapeError {
  constructor(file: string, version: number) {
    super(file, `schema_version ${version} is newer than ${SNAPSHOT_SCHEMA_VERSION}`);
    this.name = "UnsupportedFormatError";
  }
}

type Json = Record<string, unknown>;

const SHA256 = /^[0-9a-f]{64}$/;

/** Reads one file's values, throwing a DataShapeError that names the file and the path. */
class Reader {
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  fail(at: string, message: string): never {
    throw new DataShapeError(this.file, at === "" ? message : `${at}: ${message}`);
  }

  object(value: unknown, at: string): Json {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.fail(at, "is not an object");
    }
    return value as Json;
  }

  array(value: unknown, at: string): unknown[] {
    if (!Array.isArray(value)) this.fail(at, "is not an array");
    return value;
  }

  string(value: unknown, at: string): string {
    if (typeof value !== "string") this.fail(at, "is not a string");
    return value;
  }

  nullableString(value: unknown, at: string): void {
    if (value !== null) this.string(value, at);
  }

  number(value: unknown, at: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) this.fail(at, "is not a number");
    return value;
  }

  nullableNumber(value: unknown, at: string): void {
    if (value !== null) this.number(value, at);
  }

  integer(value: unknown, at: string): number {
    if (!Number.isInteger(value)) this.fail(at, "is not an integer");
    return value as number;
  }

  boolean(value: unknown, at: string): void {
    if (typeof value !== "boolean") this.fail(at, "is not a boolean");
  }

  constant(value: unknown, expected: string, at: string): void {
    if (value !== expected) this.fail(at, `is not "${expected}"`);
  }

  oneOf(value: unknown, values: readonly string[], at: string): void {
    if (typeof value !== "string" || !values.includes(value)) {
      this.fail(at, `is not one of ${values.join(", ")}`);
    }
  }

  dateTime(value: unknown, at: string): void {
    if (Number.isNaN(Date.parse(this.string(value, at)))) this.fail(at, "is not a date-time");
  }

  nullableDateTime(value: unknown, at: string): void {
    if (value !== null) this.dateTime(value, at);
  }

  /**
   * Only a higher integer is a newer format, which a reload can fix. Anything else (missing, text,
   * lower, or a JSON body that isn't a map file at all) is a file this page can't read.
   */
  schemaVersion(document: Json): void {
    const version = document["schema_version"];
    if (version === SNAPSHOT_SCHEMA_VERSION) return;
    if (
      typeof version === "number" &&
      Number.isInteger(version) &&
      version > SNAPSHOT_SCHEMA_VERSION
    ) {
      throw new UnsupportedFormatError(this.file, version);
    }
    this.fail("schema_version", `is not ${SNAPSHOT_SCHEMA_VERSION}`);
  }

  position(value: unknown, at: string): void {
    const position = this.array(value, at);
    if (position.length !== 2) this.fail(at, "is not a [longitude, latitude] pair");
    const lon = this.number(position[0], `${at}[0]`);
    const lat = this.number(position[1], `${at}[1]`);
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) this.fail(at, "is not on the globe");
  }

  positions(value: unknown, at: string, min: number): void {
    const positions = this.array(value, at);
    if (positions.length < min) this.fail(at, `has fewer than ${min} positions`);
    positions.forEach((position, i) => {
      this.position(position, `${at}[${i}]`);
    });
  }

  polygonRings(value: unknown, at: string): void {
    const rings = this.array(value, at);
    if (rings.length === 0) this.fail(at, "has no rings");
    rings.forEach((ring, i) => {
      this.positions(ring, `${at}[${i}]`, 4);
    });
  }

  /** A geometry of `type` (or null, when `nullable`). */
  geometry(
    value: unknown,
    type: "Point" | "LineString" | "Polygon" | "MultiPolygon",
    at: string,
    nullable = false,
  ): void {
    if (value === null && nullable) return;
    const geometry = this.object(value, at);
    this.constant(geometry["type"], type, `${at}.type`);
    const coordinates = geometry["coordinates"];
    switch (type) {
      case "Point":
        this.position(coordinates, `${at}.coordinates`);
        break;
      case "LineString":
        this.positions(coordinates, `${at}.coordinates`, 2);
        break;
      case "Polygon":
        this.polygonRings(coordinates, `${at}.coordinates`);
        break;
      case "MultiPolygon": {
        const polygons = this.array(coordinates, `${at}.coordinates`);
        if (polygons.length === 0) this.fail(`${at}.coordinates`, "has no polygons");
        polygons.forEach((polygon, i) => {
          this.polygonRings(polygon, `${at}.coordinates[${i}]`);
        });
        break;
      }
    }
  }
}

/**
 * latest.json: the pointer to the current version. Besides the shape, each file's path must be the
 * version's own `snapshots/<snapshot_sha256>/<file>` (checkLatestPointer), so a bad pointer can't
 * send the app to another directory or host.
 */
export function parseLatest(value: unknown): LatestPointer {
  const r = new Reader("latest.json");
  const latest = r.object(value, "");
  r.schemaVersion(latest);
  r.integer(latest["version"], "version");
  r.dateTime(latest["published_at"], "published_at");
  if (!SHA256.test(r.string(latest["snapshot_sha256"], "snapshot_sha256"))) {
    r.fail("snapshot_sha256", "is not a SHA-256 in hex");
  }
  const files = r.object(latest["files"], "files");
  for (const key of ["indoor", "street"]) {
    const file = r.object(files[key], `files.${key}`);
    r.string(file["path"], `files.${key}.path`);
    r.integer(file["bytes"], `files.${key}.bytes`);
    if (!SHA256.test(r.string(file["sha256"], `files.${key}.sha256`))) {
      r.fail(`files.${key}.sha256`, "is not a SHA-256 in hex");
    }
  }
  const attribution = r.array(latest["attribution"], "attribution");
  attribution.forEach((entry, i) => {
    const item = r.object(entry, `attribution[${i}]`);
    r.string(item["text"], `attribution[${i}].text`);
    if (!r.string(item["url"], `attribution[${i}].url`).startsWith("https://")) {
      r.fail(`attribution[${i}].url`, "is not an https URL");
    }
  });
  if (latest["demo"] !== undefined) r.boolean(latest["demo"], "demo");
  const pointer = latest as unknown as LatestPointer;
  const problems = checkLatestPointer(pointer);
  if (problems.length > 0) r.fail("", problems.join("; "));
  return pointer;
}

function readIndoorFeature(r: Reader, value: unknown, at: string): void {
  const feature = r.object(value, at);
  r.constant(feature["type"], "Feature", `${at}.type`);
  const id = r.string(feature["id"], `${at}.id`);
  const p = r.object(feature["properties"], `${at}.properties`);
  const type = p["feature_type"];
  r.oneOf(type, INDOOR_FEATURE_TYPES, `${at}.properties.feature_type`);
  if (p["id"] !== id) r.fail(`${at}.properties.id`, "differs from the feature's id");
  const prop = (name: string) => `${at}.properties.${name}`;
  const geometry = feature["geometry"];
  switch (type) {
    case "venue":
      r.string(p["name"], prop("name"));
      r.oneOf(p["kind"], VENUE_KINDS, prop("kind"));
      r.geometry(geometry, "MultiPolygon", `${at}.geometry`, true);
      break;
    case "level":
      r.string(p["venue_id"], prop("venue_id"));
      r.string(p["name"], prop("name"));
      r.integer(p["ordinal"], prop("ordinal"));
      r.integer(p["sort_key"], prop("sort_key"));
      r.nullableNumber(p["elevation_m"], prop("elevation_m"));
      if (geometry !== null) r.fail(`${at}.geometry`, "is not null");
      break;
    case "space":
      r.string(p["level_id"], prop("level_id"));
      r.integer(p["ordinal"], prop("ordinal"));
      r.oneOf(p["kind"], SPACE_KINDS, prop("kind"));
      r.nullableString(p["name"], prop("name"));
      r.geometry(geometry, "Polygon", `${at}.geometry`);
      break;
    case "node":
      r.nullableString(p["level_id"], prop("level_id"));
      r.integer(p["ordinal"], prop("ordinal"));
      r.oneOf(p["kind"], NODE_KINDS, prop("kind"));
      r.nullableString(p["name"], prop("name"));
      r.nullableString(p["street_name"], prop("street_name"));
      r.nullableString(p["connector_id"], prop("connector_id"));
      r.geometry(geometry, "Point", `${at}.geometry`);
      break;
    case "edge":
      r.string(p["from_node"], prop("from_node"));
      r.string(p["to_node"], prop("to_node"));
      r.integer(p["from_ordinal"], prop("from_ordinal"));
      r.integer(p["to_ordinal"], prop("to_ordinal"));
      r.nullableString(p["level_id"], prop("level_id"));
      r.oneOf(p["kind"], EDGE_KINDS, prop("kind"));
      r.nullableString(p["connector_id"], prop("connector_id"));
      r.boolean(p["oneway"], prop("oneway"));
      r.oneOf(p["access"], EDGE_ACCESS_VALUES, prop("access"));
      r.nullableString(p["opening_hours"], prop("opening_hours"));
      r.number(p["length_m"], prop("length_m"));
      r.boolean(p["step_free"], prop("step_free"));
      r.boolean(p["sheltered"], prop("sheltered"));
      r.boolean(p["outdoor"], prop("outdoor"));
      r.geometry(geometry, "LineString", `${at}.geometry`);
      break;
    case "poi":
      r.string(p["level_id"], prop("level_id"));
      r.integer(p["ordinal"], prop("ordinal"));
      r.nullableString(p["space_id"], prop("space_id"));
      r.string(p["name"], prop("name"));
      r.oneOf(p["category"], POI_CATEGORIES, prop("category"));
      r.geometry(geometry, "Point", `${at}.geometry`);
      break;
    case "street_connector":
      r.string(p["node_id"], prop("node_id"));
      r.integer(p["osm_node_id"], prop("osm_node_id"));
      r.integer(p["ordinal"], prop("ordinal"));
      r.number(p["length_m"], prop("length_m"));
      r.geometry(geometry, "LineString", `${at}.geometry`);
      break;
  }
}

/** indoor.json: venues, levels, spaces, nodes, edges, POIs and street connectors. */
export function parseIndoor(value: unknown): IndoorSnapshot {
  const r = new Reader("indoor.json");
  const snapshot = r.object(value, "");
  r.schemaVersion(snapshot);
  r.constant(snapshot["type"], "FeatureCollection", "type");
  r.array(snapshot["features"], "features").forEach((feature, i) => {
    readIndoorFeature(r, feature, `features[${i}]`);
  });
  return snapshot as unknown as IndoorSnapshot;
}

/** street.json: the OpenStreetMap street graph's nodes and edges. */
export function parseStreet(value: unknown): StreetSnapshot {
  const r = new Reader("street.json");
  const snapshot = r.object(value, "");
  r.schemaVersion(snapshot);
  r.constant(snapshot["type"], "FeatureCollection", "type");
  const source = r.object(snapshot["source"], "source");
  r.constant(source["name"], "OpenStreetMap", "source.name");
  r.array(snapshot["features"], "features").forEach((value, i) => {
    const at = `features[${i}]`;
    const feature = r.object(value, at);
    r.constant(feature["type"], "Feature", `${at}.type`);
    const p = r.object(feature["properties"], `${at}.properties`);
    const prop = (name: string) => `${at}.properties.${name}`;
    if (p["feature_type"] === "street_node") {
      r.integer(feature["id"], `${at}.id`);
      r.geometry(feature["geometry"], "Point", `${at}.geometry`);
    } else {
      r.constant(p["feature_type"], "street_edge", prop("feature_type"));
      r.integer(p["osm_way_id"], prop("osm_way_id"));
      r.integer(p["from_osm_node"], prop("from_osm_node"));
      r.integer(p["to_osm_node"], prop("to_osm_node"));
      r.nullableString(p["highway"], prop("highway"));
      r.nullableString(p["footway"], prop("footway"));
      r.boolean(p["covered"], prop("covered"));
      r.number(p["length_m"], prop("length_m"));
      r.geometry(feature["geometry"], "LineString", `${at}.geometry`);
    }
  });
  return snapshot as unknown as StreetSnapshot;
}

/** status.json: the status overlay, closures and reopenings of nodes and edges. */
export function parseStatus(value: unknown): StatusOverlay {
  const r = new Reader("status.json");
  const overlay = r.object(value, "");
  r.schemaVersion(overlay);
  r.dateTime(overlay["generated_at"], "generated_at");
  r.array(overlay["entries"], "entries").forEach((value, i) => {
    const at = `entries[${i}]`;
    const entry = r.object(value, at);
    r.oneOf(entry["feature_type"], ["node", "edge"], `${at}.feature_type`);
    r.string(entry["feature_id"], `${at}.feature_id`);
    r.boolean(entry["is_open"], `${at}.is_open`);
    r.nullableString(entry["note"], `${at}.note`);
    r.dateTime(entry["valid_from"], `${at}.valid_from`);
    r.nullableDateTime(entry["valid_until"], `${at}.valid_until`);
  });
  // What the schema can't say: one entry per feature, and windows that cover generated_at. Two
  // entries for one feature would leave the page to guess which wins (snapshot-format.md: a
  // status.json a client can't validate counts as one with no entries).
  const status = overlay as unknown as StatusOverlay;
  const problems = checkStatusOverlay(status);
  if (problems.length > 0) r.fail("", problems.join("; "));
  return status;
}
