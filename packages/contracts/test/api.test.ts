// The API's response schemas (schemas/api/) and inlineSchema, which turns a schema file into one
// self-contained schema for Fastify route schemas and the OpenAPI document.

import { describe, expect, test } from "vitest";
import {
  API_SCHEMA_FILES,
  type ApiDocumentName,
  type ErrorResponse,
  HEALTH_PROBLEMS,
  type HealthResponse,
  type MapLatestResponse,
} from "../src/index.ts";
import { createAjv, inlineSchema, validateApiDocument } from "../src/validators.ts";
import { ALL_SCHEMA_FILES, readSchema } from "./schemas.ts";

const SHA = "3f8a2b6c4d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a";

const health: HealthResponse = {
  status: "ok",
  api: { version: "0.0.0", node: "v26.12.0", snapshot_schema_version: 1 },
  database: {
    ok: true,
    problem: null,
    postgres: "18.0 (Debian 18.0-1.pgdg13+3)",
    postgis: "3.6.0",
    migration: "20261014225324",
  },
  storage: {
    ok: true,
    problem: null,
    server: "1.0.1",
    buckets: { bundles: true, exports: true, public: true },
  },
};

const unhealthy: HealthResponse = {
  ...health,
  status: "unavailable",
  database: { ok: false, problem: "unreachable", postgres: null, postgis: null, migration: null },
  storage: {
    ok: false,
    problem: "missing_bucket",
    server: null,
    buckets: { bundles: true, exports: false, public: true },
  },
};

const mapLatest: MapLatestResponse = {
  version: 7,
  published_at: "2026-11-02T14:05:11+08:00",
  snapshot_sha256: SHA,
  restores: null,
  files: {
    indoor: {
      path: `snapshots/${SHA}/indoor.json`,
      url: `http://192.168.1.20:28000/public/snapshots/${SHA}/indoor.json`,
    },
    street: {
      path: `snapshots/${SHA}/street.json`,
      url: `http://192.168.1.20:28000/public/snapshots/${SHA}/street.json`,
    },
  },
};

const notFound: ErrorResponse = {
  statusCode: 404,
  error: "Not Found",
  message: "No map version has been published yet",
};

const valid: [string, ApiDocumentName, unknown][] = [
  ["a healthy API", "GET /health", health],
  ["an unhealthy API", "GET /health", unhealthy],
  ["the current version", "GET /map/latest", mapLatest],
  ["a rollback version", "GET /map/latest", { ...mapLatest, restores: 5 }],
  ["the demo map", "GET /map/latest", { ...mapLatest, demo: true }],
  ["a 404", "error", notFound],
  ["a Fastify error with its code", "error", { ...notFound, code: "FST_ERR_NOT_FOUND" }],
];

const invalid: [string, ApiDocumentName, unknown][] = [
  ["health with an unknown field", "GET /health", { ...health, database_url: "postgres://" }],
  [
    "health naming a bucket",
    "GET /health",
    { ...health, storage: { ...health.storage, buckets: { "usg-public": true } } },
  ],
  [
    "health with an error message instead of a problem code",
    "GET /health",
    {
      ...unhealthy,
      database: { ...unhealthy.database, problem: "password authentication failed" },
    },
  ],
  [
    "map/latest with the private export key",
    "GET /map/latest",
    { ...mapLatest, private_export_uri: "exports/7.json.br" },
  ],
  ["map/latest with the publisher", "GET /map/latest", { ...mapLatest, published_by: "x" }],
  [
    "map/latest with demo false rather than absent",
    "GET /map/latest",
    { ...mapLatest, demo: false },
  ],
  [
    "map/latest with a path outside snapshots/",
    "GET /map/latest",
    {
      ...mapLatest,
      files: { ...mapLatest.files, indoor: { ...mapLatest.files.indoor, path: "../indoor.json" } },
    },
  ],
  [
    "map/latest with a UTC offset other than +08:00",
    "GET /map/latest",
    { ...mapLatest, published_at: "2026-11-02T14:05:11+09:00" },
  ],
  ["an error with a 2xx status", "error", { ...notFound, statusCode: 200 }],
];

describe("API response schemas", () => {
  test("every API schema file is listed", () => {
    expect(ALL_SCHEMA_FILES.filter((file) => file.startsWith("api/")).sort()).toEqual(
      Object.values(API_SCHEMA_FILES)
        .map((file) => `api/${file}`)
        .sort(),
    );
  });

  test("HEALTH_PROBLEMS is the schema's enum", () => {
    const defs = readSchema("api/health.schema.json")["$defs"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(defs["problem"]?.["enum"]).toEqual(HEALTH_PROBLEMS);
  });

  test.each(valid)("accepts %s", (_name, document, body) => {
    expect(validateApiDocument(document, body)).toEqual({ valid: true, problems: [] });
  });

  test.each(invalid)("refuses %s", (_name, document, body) => {
    expect(validateApiDocument(document, body).valid).toBe(false);
  });
});

describe("inlineSchema", () => {
  const ajv = createAjv();
  const files = ALL_SCHEMA_FILES.filter((file) => !file.endsWith("/defs.schema.json"));

  test.each(files)("%s inlines to a schema with no $ref, $id, $schema or $defs", (file) => {
    const text = JSON.stringify(inlineSchema(file));
    for (const keyword of ['"$ref"', '"$id"', '"$schema"', '"$defs"']) {
      expect(text).not.toContain(keyword);
    }
  });

  test.each([
    ...valid.map(([name, document, body]) => [name, document, body, true] as const),
    ...invalid.map(([name, document, body]) => [name, document, body, false] as const),
  ])("the inlined schema agrees with the file on %s", (_name, document, body, expected) => {
    // Compiled on its own, with nothing to resolve: no $id, so Ajv can't reach the files.
    const validate = ajv.compile(inlineSchema(`api/${API_SCHEMA_FILES[document]}`));
    expect(validate(body)).toBe(expected);
  });

  test("resolves references across files", () => {
    const inlined = inlineSchema("api/map-latest.schema.json") as {
      properties: { snapshot_sha256: { allOf: [Record<string, unknown>] } };
    };
    // ../map/defs.schema.json#/$defs/sha256 is itself a $ref into the capture bundle's defs.
    expect(inlined.properties.snapshot_sha256.allOf[0]).toMatchObject({
      title: "Sha256",
      type: "string",
      pattern: "^[0-9a-f]{64}$",
    });
  });

  test("refuses a file that isn't one of the package's schemas", () => {
    expect(() => inlineSchema("../package.json")).toThrow(/not a schema file/);
  });
});
