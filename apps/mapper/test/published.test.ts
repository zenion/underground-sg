// Loading the published map for the Map tab (src/map/published.ts), against the snapshot builder's
// golden files (services/api/test/fixtures/snapshot: a synthetic map at real City Hall cluster
// coordinates) and a fake API.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type IndoorSnapshot,
  type LatestPointer,
  type StreetSnapshot,
  snapshotDigestInput,
  snapshotFilePath,
} from "@usg/contracts";
import { describe, expect, test } from "vitest";
import {
  checkIndoor,
  checkLatest,
  checkStreet,
  type FetchLike,
  glyphsTemplate,
  latestUrl,
  loadPublishedMap,
  ShapeError,
  versionLine,
} from "../src/map/published.ts";

const golden = (file: string): string =>
  readFileSync(
    new URL(`../../../services/api/test/fixtures/snapshot/${file}`, import.meta.url),
    "utf8",
  );
const INDOOR_TEXT = golden("indoor.json");
const STREET_TEXT = golden("street.json");
const INDOOR = JSON.parse(INDOOR_TEXT) as IndoorSnapshot;
const STREET = JSON.parse(STREET_TEXT) as StreetSnapshot;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const SNAPSHOT_SHA = sha256(
  snapshotDigestInput({ "indoor.json": sha256(INDOOR_TEXT), "street.json": sha256(STREET_TEXT) }),
);

function latest(overrides: Partial<LatestPointer> = {}): LatestPointer {
  return {
    schema_version: 1,
    version: 3,
    published_at: "2026-10-15T19:09:00+08:00",
    snapshot_sha256: SNAPSHOT_SHA,
    files: {
      indoor: {
        path: snapshotFilePath(SNAPSHOT_SHA, "indoor.json"),
        bytes: Buffer.byteLength(INDOOR_TEXT),
        sha256: sha256(INDOOR_TEXT),
      },
      street: {
        path: snapshotFilePath(SNAPSHOT_SHA, "street.json"),
        bytes: Buffer.byteLength(STREET_TEXT),
        sha256: sha256(STREET_TEXT),
      },
    },
    attribution: [
      { text: "© OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright" },
    ],
    ...overrides,
  };
}

const clone = <T>(value: T): T => structuredClone(value);

describe("URLs", () => {
  test("latest.json and the glyphs come from the API", () => {
    expect(latestUrl("https://usg.example.ngrok.app")).toBe(
      "https://usg.example.ngrok.app/public/latest.json",
    );
    expect(latestUrl("http://192.168.1.20:28000/")).toBe(
      "http://192.168.1.20:28000/public/latest.json",
    );
    expect(latestUrl("https://host.example/api")).toBe(
      "https://host.example/api/public/latest.json",
    );
    expect(glyphsTemplate("https://usg.example.ngrok.app")).toBe(
      "https://usg.example.ngrok.app/glyphs/{fontstack}/{range}.pbf",
    );
    expect(glyphsTemplate(null)).toBe("/glyphs/{fontstack}/{range}.pbf");
  });
});

describe("checkLatest", () => {
  test("a pointer to the version's own files passes, with its demo flag", () => {
    expect(checkLatest(latest()).version).toBe(3);
    expect(checkLatest(latest({ demo: true })).demo).toBe(true);
  });

  test.each([
    ["not an object", [], /latest\.json: is not an object/],
    ["no version", { ...latest(), version: "3" }, /version is not an integer/],
    ["a bad date", { ...latest(), published_at: "yesterday" }, /published_at/],
    ["a bad hash", { ...latest(), snapshot_sha256: "abc" }, /snapshot_sha256/],
    ["no files", { ...latest(), files: undefined }, /files is not an object/],
    ["a text demo flag", { ...latest(), demo: "yes" }, /demo is not a boolean/],
    ["an older format", { ...latest(), schema_version: 0 }, /schema_version is not 1/],
    ["a newer format", { ...latest(), schema_version: 2 }, /format 2, newer than this app reads/],
  ])("refuses %s", (_name, value, message) => {
    expect(() => checkLatest(value)).toThrow(ShapeError);
    expect(() => checkLatest(value)).toThrow(message);
  });

  test("refuses paths outside the version's own directory, or on another host", () => {
    for (const path of [
      `snapshots/${"0".repeat(64)}/indoor.json`,
      "https://evil.example/indoor.json",
      `snapshots/${SNAPSHOT_SHA}/../../private/indoor.json`,
      `snapshots/${SNAPSHOT_SHA}/street.json`,
    ]) {
      const pointer = latest();
      const bad = {
        ...pointer,
        files: { ...pointer.files, indoor: { ...pointer.files.indoor, path } },
      };
      expect(() => checkLatest(bad), path).toThrow(ShapeError);
    }
  });
});

describe("checkIndoor and checkStreet", () => {
  test("the snapshot builder's golden files pass", () => {
    expect(checkIndoor(clone(INDOOR)).features).toHaveLength(INDOOR.features.length);
    expect(checkStreet(clone(STREET)).features).toHaveLength(STREET.features.length);
  });

  /** A copy of indoor.json with the first feature of `type` changed by `change`. */
  function indoorWith(type: string, change: (feature: Record<string, unknown>) => void): unknown {
    const copy = clone(INDOOR) as unknown as { features: Record<string, unknown>[] };
    const feature = copy.features.find(
      (f) => (f["properties"] as Record<string, unknown>)["feature_type"] === type,
    );
    if (feature === undefined) throw new Error(`no ${type} in the golden file`);
    change(feature);
    return copy;
  }
  const props = (feature: Record<string, unknown>) =>
    feature["properties"] as Record<string, unknown>;

  test.each([
    ["a level without an integer ordinal", "level", (f) => (props(f)["ordinal"] = -1.5), /ordinal/],
    ["a level without a name", "level", (f) => (props(f)["name"] = null), /name is not a string/],
    ["an id that differs", "space", (f) => (props(f)["id"] = "x"), /differs from the feature's id/],
    ["an unknown feature type", "poi", (f) => (props(f)["feature_type"] = "shop"), /feature_type/],
    [
      "a space as a point",
      "space",
      (f) => (f["geometry"] = { type: "Point", coordinates: [103.85, 1.29] }),
      /geometry\.type is not "Polygon"/,
    ],
    [
      "a node off the globe",
      "node",
      (f) => (f["geometry"] = { type: "Point", coordinates: [1000, 1.29] }),
      /longitude, latitude/,
    ],
    [
      "an edge with one position",
      "edge",
      (f) => (f["geometry"] = { type: "LineString", coordinates: [[103.85, 1.29]] }),
      /fewer than 2/,
    ],
    [
      "an edge without outdoor",
      "edge",
      (f) => delete props(f)["outdoor"],
      /outdoor is not a boolean/,
    ],
    [
      "a level with a geometry",
      "level",
      (f) => (f["geometry"] = { type: "Point", coordinates: [103.85, 1.29] }),
      /geometry is not null/,
    ],
  ] as [string, string, (f: Record<string, unknown>) => unknown, RegExp][])(
    "indoor.json: refuses %s",
    (_name, type, change, message) => {
      expect(() => checkIndoor(indoorWith(type, change))).toThrow(message);
    },
  );

  test("street.json: refuses a node without a numeric id and an edge without covered", () => {
    const nodeCopy = clone(STREET) as unknown as { features: Record<string, unknown>[] };
    const node = nodeCopy.features.find((f) => typeof f["id"] === "number");
    if (node) node["id"] = "1001";
    expect(() => checkStreet(nodeCopy)).toThrow(/id is not an integer/);
    const edgeCopy = clone(STREET) as unknown as { features: Record<string, unknown>[] };
    const edge = edgeCopy.features.find((f) => f["id"] === undefined);
    if (edge) delete (edge["properties"] as Record<string, unknown>)["covered"];
    expect(() => checkStreet(edgeCopy)).toThrow(/covered is not a boolean/);
  });

  test("refuses another kind of file", () => {
    expect(() => checkIndoor({ ...clone(INDOOR), type: "Feature" })).toThrow(/FeatureCollection/);
    expect(() => checkStreet({ ...clone(STREET), schema_version: 3 })).toThrow(/format 3/);
  });
});

/** A fake API: path → [status, content type, body], or an Error to throw. */
function fakeApi(routes: Record<string, readonly [number, string, string] | Error>): {
  fetch: FetchLike;
  requests: { url: string; headers: Record<string, string> }[];
} {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({ url, headers: init.headers });
    const route = routes[new URL(url).pathname];
    if (route instanceof Error) throw route;
    const [status, type, body] = route ?? [404, "application/json", '{"statusCode":404}'];
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? type : null) },
      text: async () => body,
    };
  };
  return { fetch: fetchImpl, requests };
}

const API = "https://usg.example.ngrok.app";
const JSON_TYPE = "application/json";
const INDOOR_PATH = `/public/snapshots/${SNAPSHOT_SHA}/indoor.json`;
const STREET_PATH = `/public/snapshots/${SNAPSHOT_SHA}/street.json`;
const INDOOR_ROUTE = [200, "application/geo+json", INDOOR_TEXT] as const;
const STREET_ROUTE = [200, "application/geo+json", STREET_TEXT] as const;
const versionRoutes = { [INDOOR_PATH]: INDOOR_ROUTE, [STREET_PATH]: STREET_ROUTE };

describe("loadPublishedMap", () => {
  test("latest.json, then the two files it names, under the API's /public/", async () => {
    const api = fakeApi({
      "/public/latest.json": [200, JSON_TYPE, JSON.stringify(latest({ demo: true }))],
      ...versionRoutes,
    });
    const state = await loadPublishedMap(API, api.fetch);
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.map).toMatchObject({ version: 3, demo: true });
    expect(state.map.indoor.features).toHaveLength(INDOOR.features.length);
    expect(state.map.street.features).toHaveLength(STREET.features.length);
    expect(api.requests.map((r) => r.url)).toEqual([
      `${API}/public/latest.json`,
      `${API}/public/snapshots/${SNAPSHOT_SHA}/indoor.json`,
      `${API}/public/snapshots/${SNAPSHOT_SHA}/street.json`,
    ]);
    // A CORS-safelisted header only, so a cross-origin WebView needs no preflight.
    for (const request of api.requests) expect(request.headers).toEqual({ Accept: JSON_TYPE });
  });

  test("demo is false when latest.json doesn't say", async () => {
    const api = fakeApi({
      "/public/latest.json": [200, JSON_TYPE, JSON.stringify(latest())],
      ...versionRoutes,
    });
    const state = await loadPublishedMap(API, api.fetch);
    expect(state.kind === "ready" && state.map.demo).toBe(false);
  });

  test("the API's own 404 for latest.json: nothing published yet", async () => {
    const api = fakeApi({});
    expect(await loadPublishedMap(API, api.fetch)).toEqual({ kind: "no-version" });
  });

  test.each([
    [
      "a 404 page that isn't the API's",
      [404, "text/html", "<html>ERR_NGROK_3200</html>"],
      /HTTP 404 from something other than the map API/,
    ],
    ["a 502 from the tunnel", [502, "text/html", "<html>ERR_NGROK_8012</html>"], /HTTP 502/],
    ["a 503 from the API", [503, JSON_TYPE, '{"statusCode":503}'], /HTTP 503/],
    ["a network or CORS error", new TypeError("Load failed"), /latest\.json: Load failed/],
  ] as [string, readonly [number, string, string] | Error, RegExp][])(
    "%s: the API is unreachable",
    async (_name, route, detail) => {
      const state = await loadPublishedMap(API, fakeApi({ "/public/latest.json": route }).fetch);
      expect(state.kind).toBe("unreachable");
      expect(state.kind === "unreachable" && state.detail).toMatch(detail);
    },
  );

  test.each([
    [
      "an HTML page",
      [200, "text/html", "<!doctype html><html></html>"],
      /got an HTML page, not JSON/,
    ],
    ["broken JSON", [200, JSON_TYPE, '{"schema_version":'], /is not JSON/],
    [
      "a pointer of the wrong shape",
      [200, JSON_TYPE, '{"schema_version":1}'],
      /version is not an integer/,
    ],
  ] as [string, readonly [number, string, string], RegExp][])(
    "latest.json is %s: invalid",
    async (_name, route, detail) => {
      const state = await loadPublishedMap(API, fakeApi({ "/public/latest.json": route }).fetch);
      expect(state.kind).toBe("invalid");
      expect(state.kind === "invalid" && state.detail).toMatch(detail);
    },
  );

  test("a version file that is missing or broken: invalid", async () => {
    const missing = fakeApi({
      "/public/latest.json": [200, JSON_TYPE, JSON.stringify(latest())],
      [INDOOR_PATH]: INDOOR_ROUTE,
    });
    expect(await loadPublishedMap(API, missing.fetch)).toEqual({
      kind: "invalid",
      detail: "latest.json names version 3, but its street.json is missing",
    });
    const broken = fakeApi({
      "/public/latest.json": [200, JSON_TYPE, JSON.stringify(latest())],
      ...versionRoutes,
      [STREET_PATH]: [200, JSON_TYPE, '{"type":"x"}'],
    });
    const state = await loadPublishedMap(API, broken.fetch);
    expect(state.kind === "invalid" && state.detail).toMatch(/^street\.json: schema_version/);
  });

  test("an abort rejects instead of becoming a state", async () => {
    const controller = new AbortController();
    const api: FetchLike = async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    };
    await expect(loadPublishedMap(API, api, controller.signal)).rejects.toThrow();
  });
});

test("versionLine: the version and when, in Singapore time", () => {
  expect(versionLine({ version: 3, publishedAt: "2026-10-15T19:09:00+08:00" })).toBe(
    "Map version 3 · 15 Oct 2026, 7:09 pm",
  );
  expect(versionLine({ version: 4, publishedAt: "2026-10-15T23:30:00Z" })).toBe(
    "Map version 4 · 16 Oct 2026, 7:30 am",
  );
});
