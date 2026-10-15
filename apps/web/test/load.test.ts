// loadMap against a fake server: the demo snapshot, and each way the files can fail.

import { describe, expect, test } from "vitest";
import {
  demoIndoor,
  demoPublicFiles,
  demoStatus,
  demoStreet,
  EDGE,
  NODE,
} from "../fixtures/demo-snapshot.ts";
import { type FetchLike, loadMap } from "../src/data/load.ts";
import { crashMessage, rendererMessage, stateMessage } from "../src/data/messages.ts";
import { publicRoot } from "../src/data/urls.ts";

const ROOT = publicRoot("/public", "http://localhost:5173/");
const PREFIX = "http://localhost:5173/public/";

type Override = (path: string) => Response | Error | undefined;

/** A server with the demo's files under /public/, changed by `override`; records what was fetched. */
function server(override: Override = () => undefined) {
  const files = demoPublicFiles(new Date());
  const fetched: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    fetched.push(url);
    const path = url.startsWith(PREFIX) ? url.slice(PREFIX.length) : url;
    const changed = override(path);
    if (changed instanceof Error) throw changed;
    if (changed !== undefined) return changed;
    const file = files.get(path);
    return file === undefined
      ? new Response("Not found", { status: 404 })
      : new Response(file.body, { status: 200, headers: { "Content-Type": file.contentType } });
  };
  return { fetchFn, fetched, files };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe("loadMap", () => {
  test("loads latest.json, then the version's files and status.json", async () => {
    const { fetchFn, fetched } = server();
    const state = await loadMap(ROOT, { fetch: fetchFn });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(fetched[0]).toBe(`${PREFIX}latest.json`);
    expect(fetched.slice(1).sort()).toEqual(
      [state.map.urls.indoor, state.map.urls.street, `${PREFIX}status.json`].sort(),
    );
    expect(state.map.indoor).toEqual(demoIndoor);
    expect(state.map.street).toEqual(demoStreet);
    expect(state.map.latest.demo).toBe(true);
    expect(state.map.status.entries.map((entry) => entry.feature_id)).toEqual([
      EDGE.escalator,
      NODE.northBridgeRoadExit,
    ]);
    expect(state.map.warnings).toEqual([]);
  });

  test("no latest.json: nothing published yet", async () => {
    const { fetchFn, fetched } = server(() => new Response("", { status: 404 }));
    expect(await loadMap(ROOT, { fetch: fetchFn })).toEqual({ kind: "no-version" });
    expect(fetched).toEqual([`${PREFIX}latest.json`]);
  });

  test.each([
    ["a network error", new TypeError("Failed to fetch"), /latest\.json: Failed to fetch/],
    ["a proxy with no API behind it", new Response("", { status: 502 }), /latest\.json: HTTP 502/],
    ["a server error", new Response("", { status: 500 }), /HTTP 500/],
    ["a refusal", new Response("", { status: 403 }), /HTTP 403/],
  ])("%s: unreachable", async (_, answer, detail) => {
    const { fetchFn } = server((path) => (path === "latest.json" ? answer : undefined));
    const state = await loadMap(ROOT, { fetch: fetchFn });
    expect(state.kind).toBe("unreachable");
    expect(state.kind === "unreachable" && state.detail).toMatch(detail);
  });

  test("an HTML page instead of latest.json: invalid, and says so", async () => {
    const { fetchFn } = server((path) =>
      path === "latest.json" ? new Response("<!doctype html><title>x</title>") : undefined,
    );
    expect(await loadMap(ROOT, { fetch: fetchFn })).toEqual({
      kind: "invalid",
      detail: "latest.json: got an HTML page, not JSON",
      outdated: false,
    });
  });

  test("a newer format: invalid and outdated, so the page offers a reload", async () => {
    const { fetchFn, files } = server((path) =>
      path === "latest.json"
        ? json({ ...JSON.parse(files.get("latest.json")?.body ?? ""), schema_version: 2 })
        : undefined,
    );
    const state = await loadMap(ROOT, { fetch: fetchFn });
    expect(state).toMatchObject({ kind: "invalid", outdated: true });
    expect(stateMessage(state)?.action).toBe("reload");
  });

  test.each([
    ["an empty object", {}],
    ["an API error body", { statusCode: 404, error: "Not Found", message: "No such file" }],
    ["schema_version as text", { schema_version: "1" }],
    ["a lower schema_version", { schema_version: 0 }],
  ])("%s as latest.json: invalid, not outdated, so the page offers Try again", async (_, body) => {
    const { fetchFn } = server((path) => (path === "latest.json" ? json(body) : undefined));
    const state = await loadMap(ROOT, { fetch: fetchFn });
    expect(state).toEqual({
      kind: "invalid",
      detail: "latest.json: schema_version: is not 1",
      outdated: false,
    });
    expect(stateMessage(state)).toMatchObject({
      title: "The map data couldn't be read",
      action: "retry",
    });
  });

  test("a version file that is missing or broken: invalid", async () => {
    const missing = server((path) =>
      path.endsWith("street.json") ? new Response("", { status: 404 }) : undefined,
    );
    expect(await loadMap(ROOT, { fetch: missing.fetchFn })).toMatchObject({
      kind: "invalid",
      detail: "latest.json points to version 1, but its street.json is missing",
    });
    const broken = server((path) =>
      path.endsWith("indoor.json")
        ? json({ type: "FeatureCollection", schema_version: 1 })
        : undefined,
    );
    expect(await loadMap(ROOT, { fetch: broken.fetchFn })).toMatchObject({
      kind: "invalid",
      detail: "indoor.json: features: is not an array",
    });
  });

  test("a version file the server can't send: unreachable", async () => {
    const { fetchFn } = server((path) =>
      path.endsWith("indoor.json") ? new Response("", { status: 504 }) : undefined,
    );
    expect(await loadMap(ROOT, { fetch: fetchFn })).toEqual({
      kind: "unreachable",
      detail: "indoor.json: HTTP 504",
    });
  });

  test("status.json missing: no closures, no warning", async () => {
    const { fetchFn } = server((path) =>
      path === "status.json" ? new Response("", { status: 404 }) : undefined,
    );
    const state = await loadMap(ROOT, { fetch: fetchFn });
    expect(state.kind === "ready" && state.map.status.entries).toEqual([]);
    expect(state.kind === "ready" && state.map.warnings).toEqual([]);
  });

  test.each([
    ["unreadable", () => new Response("{")],
    ["invalid", () => json({ schema_version: 1, generated_at: "now", entries: [] })],
    ["failing", () => new Response("", { status: 500 })],
    ["unreachable", () => new TypeError("Failed to fetch")],
  ])("status.json %s: the map still loads, with no closures and a warning", async (_, answer) => {
    const { fetchFn } = server((path) => (path === "status.json" ? answer() : undefined));
    const state = await loadMap(ROOT, { fetch: fetchFn });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.map.status.entries).toEqual([]);
    expect(state.map.warnings).toEqual([
      expect.stringMatching(/^status\.json: .*; no closures shown$/),
    ]);
  });

  test("status.json with two entries for one feature: no closures, and a warning", async () => {
    // A closure and a reopening of the same escalator: the page can't tell which holds, so the
    // file counts as one it can't validate (docs/snapshot-format.md, "status.json").
    const now = new Date();
    const status = demoStatus(now);
    const reopening = {
      feature_type: "edge",
      feature_id: EDGE.escalator,
      is_open: true,
      note: null,
      valid_from: now.toISOString(),
      valid_until: null,
    };
    const { fetchFn } = server((path) =>
      path === "status.json"
        ? json({ ...status, entries: [...status.entries, reopening] })
        : undefined,
    );
    const state = await loadMap(ROOT, { fetch: fetchFn });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.map.status.entries).toEqual([]);
    expect(state.map.warnings).toEqual([
      `status.json: entries[2]: a second entry for edge ${EDGE.escalator}; no closures shown`,
    ]);
  });

  test("checks across features become warnings, not failures", async () => {
    const indoor = structuredClone(demoIndoor);
    indoor.features.reverse();
    const { fetchFn } = server((path) => (path.endsWith("indoor.json") ? json(indoor) : undefined));
    const state = await loadMap(ROOT, { fetch: fetchFn });
    expect(state.kind).toBe("ready");
    expect(state.kind === "ready" && state.map.warnings.join("\n")).toMatch(/not sorted/);
  });

  test("an aborted load rejects, so a newer attempt's result wins", async () => {
    const controller = new AbortController();
    const fetchFn: FetchLike = async (_url, init) => {
      controller.abort();
      init?.signal?.throwIfAborted();
      return new Response("{}");
    };
    await expect(loadMap(ROOT, { fetch: fetchFn, signal: controller.signal })).rejects.toThrow();
  });
});

describe("stateMessage", () => {
  test("loading and ready need no message", () => {
    expect(stateMessage({ kind: "loading" })).toBeUndefined();
  });

  test("nothing published is information; the rest are errors with a retry", () => {
    expect(stateMessage({ kind: "no-version" })).toMatchObject({
      title: "No map published yet",
      tone: "info",
      action: "retry",
    });
    expect(stateMessage({ kind: "unreachable", detail: "latest.json: HTTP 502" })).toMatchObject({
      title: "Can't reach the map server",
      detail: "latest.json: HTTP 502",
      tone: "error",
      action: "retry",
    });
    expect(stateMessage({ kind: "invalid", detail: "x", outdated: false })).toMatchObject({
      tone: "error",
      action: "retry",
    });
  });
});

describe("rendererMessage and crashMessage", () => {
  test("no WebGL 2: says so, with MapLibre's reason, and offers a reload", () => {
    // What MapLibre GL JS 6.14 throws from its constructor when getContext("webgl2") is null.
    const error = new Error("WebGL2 is required to display this map.");
    error.name = "GPUInitializationError";
    expect(rendererMessage(error)).toEqual({
      title: "This browser can't draw the map",
      text: expect.stringMatching(/WebGL 2/),
      detail: "WebGL2 is required to display this map.",
      action: "reload",
      tone: "error",
    });
  });

  test("a page failure offers a reload; a thrown value that isn't an Error still shows", () => {
    expect(crashMessage(new TypeError("x is undefined"))).toMatchObject({
      title: "Something went wrong",
      detail: "x is undefined",
      action: "reload",
    });
    expect(crashMessage("boom").detail).toBe("boom");
    expect(crashMessage(undefined)).not.toHaveProperty("detail");
  });
});
