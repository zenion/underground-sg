// The app without the stack: the public files from an in-memory bucket, the glyphs from
// @usg/map-style, OpenAPI, CORS, the response contracts, /health with nothing reachable, and what
// a failing route sends (nothing about the cause). The database and RustFS are exercised in
// test/stack/.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { validateApiDocument } from "@usg/contracts/validators";
import { FONT_STACK, GLYPH_RANGES } from "@usg/map-style";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildApp } from "../../src/app.ts";
import { contractSerializerCompiler, responseSchema } from "../../src/contract-schemas.ts";
import { createDatabase } from "../../src/database.ts";
import { installErrorHandler } from "../../src/error-handler.ts";
import { mapStyleGlyphsDir } from "../../src/glyphs.ts";
import {
  createMemoryStorage,
  type MemoryObjectStore,
  type ObjectStore,
  type Storage,
} from "../../src/storage.ts";

const SHA = "3f8a2b6c4d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a";
const INDOOR = `snapshots/${SHA}/indoor.json`;
const STREET = `snapshots/${SHA}/street.json`;
const indoorJson = JSON.stringify({ type: "FeatureCollection", schema_version: 1, features: [] });
const streetJson = JSON.stringify({ type: "FeatureCollection", note: "stored gzip" });
const latestJson = JSON.stringify({ schema_version: 1, version: 1 });
/** Nothing listens on port 1, so every query fails at once. The password must never show. */
const UNREACHABLE_DB = "postgres://usg:hunter2-db-secret@127.0.0.1:1/usg";

const storage = createMemoryStorage();
const db = createDatabase(UNREACHABLE_DB, { maxConnections: 1 });
let app: FastifyInstance;

beforeAll(async () => {
  const store = storage.buckets.public as MemoryObjectStore;
  await store.put("latest.json", new TextEncoder().encode(latestJson), {
    contentType: "application/json",
  });
  await store.put(INDOOR, brotliCompressSync(indoorJson), {
    contentType: "application/geo+json",
    contentEncoding: "br",
  });
  await store.put(STREET, gzipSync(streetJson), {
    contentType: "application/geo+json",
    contentEncoding: "gzip",
  });
  await store.put(`snapshots/${"0".repeat(64)}/indoor.json`, new Uint8Array([1, 2, 3]), {
    contentType: "application/geo+json",
    contentEncoding: "zstd",
  });
  app = await buildApp({ db, storage, corsOrigins: ["http://localhost:5173"] });
});

afterAll(async () => {
  await app.close();
  await db.destroy();
});

describe("GET /public/*", () => {
  test("latest.json: stored as is, JSON, cached for a minute", async () => {
    const response = await app.inject({ url: "/public/latest.json" });
    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      "content-type": "application/json",
      "cache-control": "public, max-age=60",
      "x-content-type-options": "nosniff",
      "content-length": String(latestJson.length),
    });
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.body).toBe(latestJson);
  });

  test("a version file goes out brotli-encoded to a client that accepts br", async () => {
    const response = await app.inject({
      url: `/public/${INDOOR}`,
      headers: { "accept-encoding": "gzip, deflate, br" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      "content-type": "application/geo+json",
      "content-encoding": "br",
      "cache-control": "public, max-age=31536000, immutable",
      vary: "Origin, Accept-Encoding",
    });
    expect(response.headers["etag"]).toMatch(/^"[0-9a-f]{32}"$/);
    expect(response.rawPayload.equals(brotliCompressSync(indoorJson))).toBe(true);
  });

  test("and decompressed to a client that doesn't", async () => {
    for (const headers of [
      {},
      { "accept-encoding": "gzip, deflate" },
      { "accept-encoding": "br;q=0" },
    ]) {
      const response = await app.inject({ url: `/public/${INDOOR}`, headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-encoding"]).toBeUndefined();
      expect(response.headers["etag"]).toBeUndefined();
      expect(response.headers["vary"]).toBe("Origin, Accept-Encoding");
      expect(response.headers["content-type"]).toBe("application/geo+json");
      expect(response.body).toBe(indoorJson);
    }
  });

  test("a gzip-stored file is decoded for a client that accepts only br", async () => {
    const response = await app.inject({
      url: `/public/${STREET}`,
      headers: { "accept-encoding": "br" },
    });
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.body).toBe(streetJson);
  });

  test("a coding it can't decode is 406 for a client that doesn't accept it", async () => {
    const url = `/public/snapshots/${"0".repeat(64)}/indoor.json`;
    const response = await app.inject({ url, headers: { "accept-encoding": "br" } });
    expect(response.statusCode).toBe(406);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(validateApiDocument("error", response.json()).valid).toBe(true);
    const accepted = await app.inject({ url, headers: { "accept-encoding": "zstd" } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers["content-encoding"]).toBe("zstd");
  });

  test("Vary keeps CORS's Origin beside Accept-Encoding, so a cache never mixes origins", async () => {
    const origin = { origin: "http://localhost:5173" };
    for (const headers of [{ ...origin, "accept-encoding": "br" }, origin]) {
      const response = await app.inject({ url: `/public/${INDOOR}`, headers });
      expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
      expect(response.headers["vary"]).toBe("Origin, Accept-Encoding");
    }
    const first = await app.inject({
      url: `/public/${INDOOR}`,
      headers: { ...origin, "accept-encoding": "br" },
    });
    const notModified = await app.inject({
      url: `/public/${INDOOR}`,
      headers: {
        ...origin,
        "accept-encoding": "br",
        "if-none-match": String(first.headers["etag"]),
      },
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.headers["vary"]).toBe("Origin, Accept-Encoding");
  });

  test("HEAD sends the headers and no body", async () => {
    const response = await app.inject({
      method: "HEAD",
      url: `/public/${INDOOR}`,
      headers: { "accept-encoding": "br" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("br");
    expect(response.headers["content-length"]).toBe(
      String(brotliCompressSync(indoorJson).byteLength),
    );
    expect(response.body).toBe("");
  });

  test("If-None-Match with the ETag gives 304", async () => {
    const first = await app.inject({ url: "/public/latest.json" });
    const etag = String(first.headers["etag"]);
    const second = await app.inject({
      url: "/public/latest.json",
      headers: { "if-none-match": `W/${etag}` },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
    expect(second.headers["cache-control"]).toBe("public, max-age=60");
  });

  test("a file that isn't there is 404", async () => {
    const response = await app.inject({ url: "/public/status.json" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      statusCode: 404,
      error: "Not Found",
      message: "No such file",
    });
  });

  test.each([
    "/public/",
    "/public",
    "/public/snapshots/",
    `/public/snapshots/${SHA}/`,
    "/public/..%2F..%2Fpackage.json",
    "/public/%2e%2e/%2e%2e/package.json",
    "/public/snapshots%2F..%2Flatest.json",
    `/public/snapshots/${SHA}/indoor.json%00`,
    "/public/exports/1.json",
  ])("%s is 404: no listing, no other keys", async (url) => {
    const response = await app.inject({ url });
    expect(response.statusCode).toBe(404);
  });

  test("nothing writes: other methods are refused and the bucket is unchanged", async () => {
    const store = storage.buckets.public as MemoryObjectStore;
    const before = store.keys();
    for (const method of ["PUT", "POST", "DELETE", "PATCH"] as const) {
      const response = await app.inject({ method, url: "/public/latest.json", payload: "{}" });
      expect(response.statusCode, method).toBeGreaterThanOrEqual(400);
    }
    expect(store.keys()).toEqual(before);
  });
});

describe("GET /glyphs/:fontstack/:range.pbf", () => {
  test.each(GLYPH_RANGES)("serves %s.pbf of the map style's font stack", async (range) => {
    const response = await app.inject({
      url: `/glyphs/${encodeURIComponent(FONT_STACK)}/${range}.pbf`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/x-protobuf");
    expect(response.headers["cache-control"]).toBe("public, max-age=86400");
    const file = readFileSync(join(mapStyleGlyphsDir(), FONT_STACK, `${range}.pbf`));
    expect(response.rawPayload.equals(file)).toBe(true);
  });

  test.each([
    `/glyphs/${encodeURIComponent(FONT_STACK)}/512-767.pbf`,
    `/glyphs/${encodeURIComponent(FONT_STACK)}/0-256.pbf`,
    `/glyphs/${encodeURIComponent(FONT_STACK)}/0-255`,
    `/glyphs/${encodeURIComponent(FONT_STACK)}/README.md`,
    `/glyphs/${encodeURIComponent(`${FONT_STACK},Arial Unicode MS Regular`)}/0-255.pbf`,
    "/glyphs/Noto%20Sans%20Bold/0-255.pbf",
    "/glyphs/../OFL.txt",
    "/glyphs/..%2F/OFL.txt",
    "/glyphs/%2e%2e/OFL.txt",
    `/glyphs/${encodeURIComponent(FONT_STACK)}/..%2F..%2FOFL.txt`,
    `/glyphs/${encodeURIComponent(FONT_STACK)}/..%5COFL.txt`,
    "/glyphs/",
    `/glyphs/${encodeURIComponent(FONT_STACK)}/`,
  ])("%s is 404", async (url) => {
    const response = await app.inject({ url });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /health with nothing reachable", () => {
  test("503: the database is unreachable; no credentials in the body", async () => {
    const response = await app.inject({ url: "/health" });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(validateApiDocument("GET /health", body)).toEqual({ valid: true, problems: [] });
    expect(body).toMatchObject({
      status: "unavailable",
      database: { ok: false, problem: "unreachable", postgres: null },
      storage: { ok: true, problem: null, buckets: { bundles: true, exports: true, public: true } },
    });
    expect(response.body).not.toContain("hunter2");
    expect(response.body).not.toContain("127.0.0.1");
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

/** An app over `db` and a public bucket that is `store`, for the failure cases. */
async function appWith(
  options: { db?: string; store?: ObjectStore; publicFileTimeoutMs?: number } = {},
): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const database = createDatabase(options.db ?? UNREACHABLE_DB, { maxConnections: 1 });
  const memory = createMemoryStorage();
  const failing: Storage = {
    ...memory,
    buckets: { ...memory.buckets, public: options.store ?? memory.buckets.public },
  };
  const built = await buildApp({
    db: database,
    storage: failing,
    corsOrigins: [],
    ...(options.publicFileTimeoutMs === undefined
      ? {}
      : { publicFileTimeoutMs: options.publicFileTimeoutMs }),
  });
  return {
    app: built,
    close: async () => {
      await built.close();
      await database.destroy();
    },
  };
}

/** A public bucket whose every read fails as S3 would, naming its host. */
const failingStore: ObjectStore = {
  bucket: "public",
  get: async () => {
    throw Object.assign(
      new Error(
        "The request signature we calculated does not match the signature you provided (rustfs.internal.example:29000)",
      ),
      { name: "SignatureDoesNotMatch", code: "SignatureDoesNotMatch" },
    );
  },
  head: async () => {
    throw Object.assign(new Error("getaddrinfo ENOTFOUND rustfs.internal.example"), {
      code: "ENOTFOUND",
      hostname: "rustfs.internal.example",
    });
  },
  put: async () => {},
  exists: async () => true,
};

/** A public bucket that never answers. */
const silentStore: ObjectStore = {
  bucket: "public",
  get: () => new Promise(() => {}),
  head: () => new Promise(() => {}),
  put: async () => {},
  exists: async () => true,
};

const SECRETS = [
  "hunter2",
  "127.0.0.1",
  ":1/",
  "usg-internal-db.invalid",
  "rustfs.internal.example",
  "29000",
  "ECONNREFUSED",
  "ENOTFOUND",
  "SignatureDoesNotMatch",
  "signature",
  '"usg"',
];

function expectBare(response: { statusCode: number; body: string; json: () => unknown }): void {
  const status = response.statusCode;
  expect([500, 503]).toContain(status);
  const text = status === 503 ? "Service Unavailable" : "Internal Server Error";
  expect(response.json()).toEqual({ statusCode: status, error: text, message: text });
  for (const secret of SECRETS) expect(response.body).not.toContain(secret);
}

describe("a route that fails sends nothing about the cause", () => {
  test("GET /map/latest with PostGIS refusing connections: 503, no host, port or user", async () => {
    const response = await app.inject({ url: "/map/latest" });
    expect(response.statusCode).toBe(503);
    expectBare(response);
  });

  test("GET /map/latest with a database host that doesn't resolve: 503, no host", async () => {
    const failing = await appWith({
      db: "postgres://usg:hunter2@usg-internal-db.invalid:5432/usg",
    });
    try {
      const response = await failing.app.inject({ url: "/map/latest" });
      expect(response.statusCode).toBe(503);
      expectBare(response);
    } finally {
      await failing.close();
    }
  });

  test("GET and HEAD /public/latest.json with a store that fails naming its host: no host", async () => {
    const failing = await appWith({ store: failingStore });
    try {
      const get = await failing.app.inject({ url: "/public/latest.json" });
      expect(get.statusCode).toBe(500);
      expectBare(get);
      const head = await failing.app.inject({ method: "HEAD", url: "/public/latest.json" });
      // ENOTFOUND: the store can't be reached.
      expect(head.statusCode).toBe(503);
      for (const secret of SECRETS) expect(head.body).not.toContain(secret);
    } finally {
      await failing.close();
    }
  });

  test("GET /public/* with a store that never answers: 503 once the timeout passes", async () => {
    const failing = await appWith({ store: silentStore, publicFileTimeoutMs: 50 });
    try {
      for (const method of ["GET", "HEAD"] as const) {
        const started = Date.now();
        const response = await failing.app.inject({ method, url: `/public/${INDOOR}` });
        expect(response.statusCode).toBe(503);
        expect(Date.now() - started).toBeLessThan(5_000);
        if (method === "GET") expectBare(response);
      }
    } finally {
      await failing.close();
    }
  });

  test("a client error still goes out as Fastify sends it", async () => {
    const plain = Fastify();
    installErrorHandler(plain);
    plain.get("/bad", async () => {
      throw Object.assign(new Error("page must be a number"), {
        statusCode: 400,
        code: "USG_BAD_PAGE",
      });
    });
    const response = await plain.inject({ url: "/bad" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      statusCode: 400,
      code: "USG_BAD_PAGE",
      error: "Bad Request",
      message: "page must be a number",
    });
    await plain.close();
  });

  test("a body that breaks its contract is a bare 500", async () => {
    const strict = Fastify();
    strict.setSerializerCompiler(contractSerializerCompiler());
    installErrorHandler(strict);
    strict.get(
      "/leaky",
      { schema: { response: { 200: responseSchema("GET /map/latest") } } },
      async () => ({ private_export_uri: "exports/1.json.br" }),
    );
    const response = await strict.inject({ url: "/leaky" });
    expect(response.statusCode).toBe(500);
    expectBare(response);
    expect(response.body).not.toContain("private_export_uri");
    await strict.close();
  });
});

describe("CORS", () => {
  test("an allowed origin may read the responses", async () => {
    const response = await app.inject({
      url: "/public/latest.json",
      headers: { origin: "http://localhost:5173" },
    });
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  test("another origin gets no CORS headers", async () => {
    const response = await app.inject({
      url: "/public/latest.json",
      headers: { origin: "http://evil.example" },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("a preflight allows only GET and HEAD", async () => {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/map/latest",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-methods"]).toBe("GET, HEAD");
  });
});

describe("routes", () => {
  test("only GET, HEAD and OPTIONS: nothing publishes or writes over HTTP", () => {
    const routes = app.printRoutes({ commonPrefix: false });
    expect(routes).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
    expect(routes).not.toMatch(/publish/i);
  });

  test("GET /openapi.json is OpenAPI 3.1 with the contracts' schemas inlined", async () => {
    const response = await app.inject({ url: "/openapi.json" });
    expect(response.statusCode).toBe(200);
    const doc = response.json() as {
      openapi: string;
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/glyphs/{fontstack}/{file}",
      "/health",
      "/map/latest",
      "/public/{*}",
    ]);
    const health = JSON.stringify(doc.paths["/health"]?.["get"]?.responses["200"]);
    expect(health).toContain('"snapshot_schema_version"');
    expect(response.body).not.toContain("underground-sg.local");
    // The file routes document what they send on success, not only their errors.
    const content = (path: string) =>
      Object.keys(
        (
          doc.paths[path]?.["get"]?.responses["200"] as
            | { content?: Record<string, unknown> }
            | undefined
        )?.content ?? {},
      );
    expect(content("/public/{*}")).toEqual(["application/json", "application/geo+json"]);
    expect(content("/glyphs/{fontstack}/{file}")).toEqual(["application/x-protobuf"]);
  });
});

describe("response contracts", () => {
  test("a body that breaks its schema is a 500, not sent", async () => {
    const strict = Fastify();
    strict.setSerializerCompiler(contractSerializerCompiler());
    strict.get(
      "/leaky",
      { schema: { response: { 200: responseSchema("GET /map/latest") } } },
      async () => ({ private_export_uri: "exports/1.json.br" }),
    );
    const response = await strict.inject({ url: "/leaky" });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("exports/1.json.br");
    await strict.close();
  });
});
