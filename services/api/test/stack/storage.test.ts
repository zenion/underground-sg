// The S3 store against RustFS, in a scratch bucket: objects keep their bytes and metadata
// (brotli stays brotli), and GET /public/* serves a built snapshot from the bucket as Cloudflare
// would, brotli to clients that accept it and decoded to the rest.

import { readFileSync } from "node:fs";
import { brotliCompressSync, constants } from "node:zlib";
import { CACHE_CONTROL } from "@usg/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildApp } from "../../src/app.ts";
import { createDatabase } from "../../src/database.ts";
import { S3ObjectStore, type Storage } from "../../src/storage.ts";
import { stackConfig, useScratchBucket } from "./helpers.ts";

const bucket = useScratchBucket();
const golden = {
  indoor: readFileSync(new URL("../fixtures/snapshot/indoor.json", import.meta.url)),
  street: readFileSync(new URL("../fixtures/snapshot/street.json", import.meta.url)),
};
const SHA = "a".repeat(64);
const PUBLIC_SHA = "b".repeat(64);
const brotli = (bytes: Uint8Array) =>
  brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });

describe("S3ObjectStore on RustFS", () => {
  const store = () => new S3ObjectStore(bucket.client(), bucket.name());

  test("the bucket exists; another doesn't", async () => {
    expect(await store().exists()).toBe(true);
    expect(await new S3ObjectStore(bucket.client(), `${bucket.name()}-missing`).exists()).toBe(
      false,
    );
  });

  test("an object keeps its bytes, Content-Encoding, Content-Type and Cache-Control", async () => {
    const encoded = brotli(golden.indoor);
    await store().put(`snapshots/${SHA}/indoor.json`, encoded, {
      contentType: "application/geo+json",
      contentEncoding: "br",
      cacheControl: CACHE_CONTROL.version,
    });
    const head = await store().head(`snapshots/${SHA}/indoor.json`);
    expect(head).toMatchObject({
      contentType: "application/geo+json",
      contentEncoding: "br",
      cacheControl: CACHE_CONTROL.version,
      contentLength: encoded.byteLength,
    });
    const object = await store().get(`snapshots/${SHA}/indoor.json`);
    const chunks: Buffer[] = [];
    for await (const chunk of object?.body ?? []) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(encoded)).toBe(true);
  });

  test("a missing key is undefined, not an error", async () => {
    expect(await store().get("latest.json")).toBeUndefined();
    expect(await store().head("latest.json")).toBeUndefined();
  });
});

describe("GET /public/* from RustFS", () => {
  let app: FastifyInstance;
  const db = createDatabase("postgres://unused@127.0.0.1:1/unused");

  beforeAll(async () => {
    const config = stackConfig();
    const store = new S3ObjectStore(bucket.client(), bucket.name());
    await store.put(`snapshots/${PUBLIC_SHA}/street.json`, brotli(golden.street), {
      contentType: "application/geo+json",
      contentEncoding: "br",
      cacheControl: CACHE_CONTROL.version,
    });
    const storage: Storage = {
      buckets: { bundles: store, exports: store, public: store },
      serverVersion: async () => undefined,
      close: () => {},
    };
    app = await buildApp({ db, storage, corsOrigins: config.corsOrigins });
  });
  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  test("brotli to a client that accepts it, byte for byte as stored", async () => {
    const response = await app.inject({
      url: `/public/snapshots/${PUBLIC_SHA}/street.json`,
      headers: { "accept-encoding": "br, gzip" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      "content-encoding": "br",
      "content-type": "application/geo+json",
      "cache-control": CACHE_CONTROL.version,
    });
    expect(response.rawPayload.equals(brotli(golden.street))).toBe(true);
  });

  test("the golden street.json, decoded, to a client that doesn't", async () => {
    const response = await app.inject({ url: `/public/snapshots/${PUBLIC_SHA}/street.json` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.rawPayload.equals(golden.street)).toBe(true);
  });

  test("a file not in the bucket is 404", async () => {
    const response = await app.inject({ url: `/public/snapshots/${PUBLIC_SHA}/indoor.json` });
    expect(response.statusCode).toBe(404);
  });
});
