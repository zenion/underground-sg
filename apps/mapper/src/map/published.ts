// The published map, as the Map tab loads it from the API: latest.json, then the version's
// indoor.json and street.json at the paths it gives (docs/snapshot-format.md). It runs in the map's
// DOM component (a WebView on the phone), so it uses the platform's fetch, and the API answers
// it from any origin (the public files are public data). The shape checks are written by hand,
// for what the map style and the level switcher read, so Ajv and the Node validators stay out of
// the bundle; @usg/contracts' checkLatestPointer keeps the version files under the version's own
// snapshots/<sha256>/ directory. A file that passes has the shape of the @usg/contracts types.

import {
  checkLatestPointer,
  INDOOR_FEATURE_TYPES,
  type IndoorSnapshot,
  type LatestPointer,
  SNAPSHOT_SCHEMA_VERSION,
  type StreetSnapshot,
} from "@usg/contracts";

/** A version of the map, loaded and checked. */
export interface PublishedMap {
  readonly version: number;
  /** When it was published, ISO 8601 with Singapore's offset. */
  readonly publishedAt: string;
  /** Demonstration data (`pnpm demo`), not a surveyed map: the map shows a badge. */
  readonly demo: boolean;
  readonly indoor: IndoorSnapshot;
  readonly street: StreetSnapshot;
}

/** What the Map tab shows about the published map. */
export type PublishedState =
  /** The app can't tell where the API is (`apiUrl()` gave a problem). */
  | { readonly kind: "no-api"; readonly detail: string }
  | { readonly kind: "loading" }
  /** The API answered, but nothing has been published yet. */
  | { readonly kind: "no-version" }
  /** No answer from the API: a network or CORS error, or an HTTP error that isn't its own 404. */
  | { readonly kind: "unreachable"; readonly detail: string }
  /** A file that isn't what the format says, or a version file that's missing. */
  | { readonly kind: "invalid"; readonly detail: string }
  | { readonly kind: "ready"; readonly map: PublishedMap };

/** The part of `fetch` the loader uses. */
export type FetchLike = (
  url: string,
  init: { signal?: AbortSignal; headers: Record<string, string> },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** `<api>/public/latest.json`: the API's stand-in for the public files (Cloudflare R2 later). */
export function latestUrl(apiUrl: string): string {
  return new URL("public/latest.json", withSlash(apiUrl)).href;
}

/**
 * The style's glyph URL template: the API's GET /glyphs serves @usg/map-style's glyph PBFs. With no
 * API there is no published map, so no labels, and the template is never used.
 */
export function glyphsTemplate(apiUrl: string | null): string {
  const base = apiUrl === null ? "/" : withSlash(apiUrl);
  return `${base}glyphs/{fontstack}/{range}.pbf`;
}

function withSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** A file that doesn't have the shape the map reads. */
export class ShapeError extends Error {
  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = "ShapeError";
  }
}

type Json = Record<string, unknown>;

const SHA256 = /^[0-9a-f]{64}$/;

/** Small typed readers that throw a ShapeError naming the file and the path. */
function reader(file: string) {
  const fail = (at: string, message: string): never => {
    throw new ShapeError(file, at === "" ? message : `${at} ${message}`);
  };
  const object = (value: unknown, at: string): Json => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(at, "is not an object");
    }
    return value as Json;
  };
  const array = (value: unknown, at: string): unknown[] =>
    Array.isArray(value) ? value : fail(at, "is not an array");
  const string = (value: unknown, at: string): string =>
    typeof value === "string" ? value : fail(at, "is not a string");
  const nullableString = (value: unknown, at: string): void => {
    if (value !== null) string(value, at);
  };
  const integer = (value: unknown, at: string): number =>
    Number.isInteger(value) ? (value as number) : fail(at, "is not an integer");
  const boolean = (value: unknown, at: string): void => {
    if (typeof value !== "boolean") fail(at, "is not a boolean");
  };
  const schemaVersion = (document: Json): void => {
    const version = document["schema_version"];
    if (version === SNAPSHOT_SCHEMA_VERSION) return;
    if (
      typeof version === "number" &&
      Number.isInteger(version) &&
      version > SNAPSHOT_SCHEMA_VERSION
    ) {
      fail("", `is in format ${version}, newer than this app reads (${SNAPSHOT_SCHEMA_VERSION})`);
    }
    fail("schema_version", `is not ${SNAPSHOT_SCHEMA_VERSION}`);
  };
  const position = (value: unknown, at: string): void => {
    const pair = array(value, at);
    const [lon, lat] = pair;
    if (
      pair.length !== 2 ||
      typeof lon !== "number" ||
      typeof lat !== "number" ||
      !(Math.abs(lon) <= 180 && Math.abs(lat) <= 90)
    ) {
      fail(at, "is not a [longitude, latitude] pair");
    }
  };
  const positions = (value: unknown, at: string, min: number): void => {
    const list = array(value, at);
    if (list.length < min) fail(at, `has fewer than ${min} positions`);
    list.forEach((item, i) => {
      position(item, `${at}[${i}]`);
    });
  };
  const rings = (value: unknown, at: string): void => {
    const list = array(value, at);
    if (list.length === 0) fail(at, "has no rings");
    list.forEach((ring, i) => {
      positions(ring, `${at}[${i}]`, 4);
    });
  };
  const geometry = (
    value: unknown,
    type: "Point" | "LineString" | "Polygon" | "MultiPolygon" | null,
    at: string,
  ): void => {
    if (type === null || (type === "MultiPolygon" && value === null)) {
      if (value !== null) fail(at, "is not null");
      return;
    }
    const g = object(value, at);
    if (g["type"] !== type) fail(`${at}.type`, `is not "${type}"`);
    const coordinates = g["coordinates"];
    if (type === "Point") position(coordinates, `${at}.coordinates`);
    else if (type === "LineString") positions(coordinates, `${at}.coordinates`, 2);
    else if (type === "Polygon") rings(coordinates, `${at}.coordinates`);
    else {
      const polygons = array(coordinates, `${at}.coordinates`);
      if (polygons.length === 0) fail(`${at}.coordinates`, "has no polygons");
      polygons.forEach((polygon, i) => {
        rings(polygon, `${at}.coordinates[${i}]`);
      });
    }
  };
  return {
    fail,
    object,
    array,
    string,
    nullableString,
    integer,
    boolean,
    schemaVersion,
    geometry,
  };
}

/**
 * latest.json: the version, when it was published, the demo flag, and its two files, whose paths
 * must be the version's own `snapshots/<snapshot_sha256>/` files (checkLatestPointer), so a bad
 * pointer can't send the app to another directory or host.
 */
export function checkLatest(value: unknown): LatestPointer {
  const r = reader("latest.json");
  const latest = r.object(value, "");
  r.schemaVersion(latest);
  r.integer(latest["version"], "version");
  if (Number.isNaN(Date.parse(r.string(latest["published_at"], "published_at")))) {
    r.fail("published_at", "is not a date-time");
  }
  if (!SHA256.test(r.string(latest["snapshot_sha256"], "snapshot_sha256"))) {
    r.fail("snapshot_sha256", "is not a SHA-256");
  }
  const files = r.object(latest["files"], "files");
  for (const key of ["indoor", "street"]) {
    const file = r.object(files[key], `files.${key}`);
    r.string(file["path"], `files.${key}.path`);
    r.integer(file["bytes"], `files.${key}.bytes`);
    if (!SHA256.test(r.string(file["sha256"], `files.${key}.sha256`))) {
      r.fail(`files.${key}.sha256`, "is not a SHA-256");
    }
  }
  r.array(latest["attribution"], "attribution");
  if (latest["demo"] !== undefined) r.boolean(latest["demo"], "demo");
  const pointer = latest as unknown as LatestPointer;
  const problems = checkLatestPointer(pointer);
  if (problems.length > 0) r.fail("", problems.join("; "));
  return pointer;
}

/** indoor.json: every feature's type, id, geometry, and the properties the style and switcher read. */
export function checkIndoor(value: unknown): IndoorSnapshot {
  const r = reader("indoor.json");
  const snapshot = r.object(value, "");
  r.schemaVersion(snapshot);
  if (snapshot["type"] !== "FeatureCollection") r.fail("type", 'is not "FeatureCollection"');
  r.array(snapshot["features"], "features").forEach((item, i) => {
    const at = `features[${i}]`;
    const feature = r.object(item, at);
    if (feature["type"] !== "Feature") r.fail(`${at}.type`, 'is not "Feature"');
    const id = r.string(feature["id"], `${at}.id`);
    const p = r.object(feature["properties"], `${at}.properties`);
    const prop = (name: string) => `${at}.properties.${name}`;
    const type = p["feature_type"];
    if (!(INDOOR_FEATURE_TYPES as readonly unknown[]).includes(type)) {
      r.fail(prop("feature_type"), `is not one of ${INDOOR_FEATURE_TYPES.join(", ")}`);
    }
    // The style promotes properties.id to the feature id (feature state, closures).
    if (p["id"] !== id) r.fail(prop("id"), "differs from the feature's id");
    const geometry = (kind: Parameters<typeof r.geometry>[1]) =>
      r.geometry(feature["geometry"], kind, `${at}.geometry`);
    switch (type) {
      case "venue":
        r.string(p["name"], prop("name"));
        geometry("MultiPolygon");
        break;
      case "level":
        r.string(p["venue_id"], prop("venue_id"));
        r.string(p["name"], prop("name"));
        r.integer(p["ordinal"], prop("ordinal"));
        r.integer(p["sort_key"], prop("sort_key"));
        geometry(null);
        break;
      case "space":
        r.integer(p["ordinal"], prop("ordinal"));
        r.string(p["kind"], prop("kind"));
        r.nullableString(p["name"], prop("name"));
        geometry("Polygon");
        break;
      case "node":
        r.integer(p["ordinal"], prop("ordinal"));
        r.string(p["kind"], prop("kind"));
        r.nullableString(p["name"], prop("name"));
        r.nullableString(p["street_name"], prop("street_name"));
        geometry("Point");
        break;
      case "edge":
        r.integer(p["from_ordinal"], prop("from_ordinal"));
        r.integer(p["to_ordinal"], prop("to_ordinal"));
        r.string(p["kind"], prop("kind"));
        r.boolean(p["outdoor"], prop("outdoor"));
        geometry("LineString");
        break;
      case "poi":
        r.integer(p["ordinal"], prop("ordinal"));
        r.string(p["name"], prop("name"));
        r.string(p["category"], prop("category"));
        geometry("Point");
        break;
      case "street_connector":
        r.integer(p["ordinal"], prop("ordinal"));
        geometry("LineString");
        break;
    }
  });
  return snapshot as unknown as IndoorSnapshot;
}

/** street.json: OpenStreetMap's footpaths, as the style draws them. */
export function checkStreet(value: unknown): StreetSnapshot {
  const r = reader("street.json");
  const snapshot = r.object(value, "");
  r.schemaVersion(snapshot);
  if (snapshot["type"] !== "FeatureCollection") r.fail("type", 'is not "FeatureCollection"');
  r.array(snapshot["features"], "features").forEach((item, i) => {
    const at = `features[${i}]`;
    const feature = r.object(item, at);
    if (feature["type"] !== "Feature") r.fail(`${at}.type`, 'is not "Feature"');
    const p = r.object(feature["properties"], `${at}.properties`);
    if (p["feature_type"] === "street_node") {
      r.integer(feature["id"], `${at}.id`);
      r.geometry(feature["geometry"], "Point", `${at}.geometry`);
    } else if (p["feature_type"] === "street_edge") {
      r.boolean(p["covered"], `${at}.properties.covered`);
      r.geometry(feature["geometry"], "LineString", `${at}.geometry`);
    } else {
      r.fail(`${at}.properties.feature_type`, "is not street_node or street_edge");
    }
  });
  return snapshot as unknown as StreetSnapshot;
}

class Unreachable extends Error {}

const MISSING = Symbol("missing");

async function fetchJson(
  fetchFn: FetchLike,
  url: string,
  file: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchFn(url, {
      ...(signal === undefined ? {} : { signal }),
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    // A network error, or the API's CORS headers missing: the platform says no more than that.
    throw new Unreachable(`${file}: ${error instanceof Error ? error.message : "no response"}`);
  }
  if (response.status === 404) {
    // The API's own 404 is JSON. Anything else (an HTML page from a tunnel whose agent is gone,
    // say) isn't the map server saying there's nothing.
    if ((response.headers.get("content-type") ?? "").includes("json")) return MISSING;
    throw new Unreachable(`${file}: HTTP 404 from something other than the map API`);
  }
  if (!response.ok) throw new Unreachable(`${file}: HTTP ${response.status}`);
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new Unreachable(
      `${file}: the response broke off (${error instanceof Error ? error.message : "no body"})`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ShapeError(file, /^\s*</.test(text) ? "got an HTML page, not JSON" : "is not JSON");
  }
}

/**
 * Loads the published map from the API at `apiUrl`. Never rejects unless `signal` aborts: every
 * failure becomes a state.
 */
export async function loadPublishedMap(
  apiUrl: string,
  fetchFn: FetchLike,
  signal?: AbortSignal,
): Promise<PublishedState> {
  try {
    const pointerUrl = latestUrl(apiUrl);
    const pointerValue = await fetchJson(fetchFn, pointerUrl, "latest.json", signal);
    if (pointerValue === MISSING) return { kind: "no-version" };
    const latest = checkLatest(pointerValue);
    const [indoorValue, streetValue] = await Promise.all([
      fetchJson(fetchFn, new URL(latest.files.indoor.path, pointerUrl).href, "indoor.json", signal),
      fetchJson(fetchFn, new URL(latest.files.street.path, pointerUrl).href, "street.json", signal),
    ]);
    if (indoorValue === MISSING || streetValue === MISSING) {
      const missing = indoorValue === MISSING ? "indoor.json" : "street.json";
      return {
        kind: "invalid",
        detail: `latest.json names version ${latest.version}, but its ${missing} is missing`,
      };
    }
    return {
      kind: "ready",
      map: {
        version: latest.version,
        publishedAt: latest.published_at,
        demo: latest.demo === true,
        indoor: checkIndoor(indoorValue),
        street: checkStreet(streetValue),
      },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof Unreachable) return { kind: "unreachable", detail: error.message };
    if (error instanceof ShapeError) return { kind: "invalid", detail: error.message };
    return { kind: "invalid", detail: String(error) };
  }
}

const publishedFormat = new Intl.DateTimeFormat("en-SG", {
  timeZone: "Asia/Singapore",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "Map version 7 · 2 Nov 2026, 2:05 pm", in Singapore time whatever the phone's time zone. */
export function versionLine(map: Pick<PublishedMap, "version" | "publishedAt">): string {
  const time = Date.parse(map.publishedAt);
  const when = Number.isNaN(time) ? map.publishedAt : publishedFormat.format(time);
  return `Map version ${map.version} · ${when}`;
}
