// GET /health against the real stack: PostGIS (this file's scratch database) and RustFS (the
// buckets `pnpm buckets` creates). Each failure gives its problem code, and no response ever
// carries a password, a key, an endpoint or a bucket name.

import { readdirSync } from "node:fs";
import { useDatabase } from "@usg/db/test/harness";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, test } from "vitest";
import { buildApp } from "../../src/app.ts";
import type { BucketNames, S3Config } from "../../src/config.ts";
import { createDatabase } from "../../src/database.ts";
import { createS3Storage } from "../../src/storage.ts";
import { stackConfig } from "./helpers.ts";

const db = useDatabase();
const config = stackConfig();

/** The newest migration in db/migrations. */
const NEWEST_MIGRATION = readdirSync(new URL("../../../../db/migrations/", import.meta.url))
  .map((file) => file.slice(0, 14))
  .sort()
  .at(-1);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function health(
  options: { databaseUrl?: string; s3?: Partial<S3Config>; buckets?: Partial<BucketNames> } = {},
) {
  const kysely = createDatabase(options.databaseUrl ?? db.url.href, { maxConnections: 2 });
  const storage = createS3Storage(
    { ...config.s3, ...options.s3 },
    { ...config.buckets, ...options.buckets },
  );
  const app: FastifyInstance = await buildApp({ db: kysely, storage, corsOrigins: [] });
  cleanups.push(async () => {
    await app.close();
    await kysely.destroy();
    storage.close();
  });
  const response = await app.inject({ url: "/health" });
  return { response, body: response.json() };
}

/** Nothing secret or identifying about the setup may appear in a /health body. */
function expectNothingLeaked(text: string): void {
  const url = new URL(config.databaseUrl);
  for (const secret of [
    url.password,
    url.username,
    config.s3.accessKeyId,
    config.s3.secretAccessKey,
    new URL(config.s3.endpoint).host,
    ...Object.values(config.buckets),
  ]) {
    expect(text).not.toContain(secret);
  }
}

describe("GET /health", () => {
  test("200 with the versions when PostGIS and every bucket answer", async () => {
    const { response, body } = await health();
    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      status: "ok",
      api: { version: "0.0.0", node: process.version, snapshot_schema_version: 1 },
      database: { ok: true, problem: null, migration: NEWEST_MIGRATION },
      storage: { ok: true, problem: null, buckets: { bundles: true, exports: true, public: true } },
    });
    expect(body.database.postgres).toMatch(/^18\./);
    expect(body.database.postgis).toMatch(/^3\.6\./);
    expect(body.storage.server).toEqual(expect.any(String));
    expectNothingLeaked(response.body);
  });

  test("a missing bucket: 503, missing_bucket, and which role it is", async () => {
    const { response, body } = await health({ buckets: { exports: "usg-test-missing-bucket" } });
    expect(response.statusCode).toBe(503);
    expect(body.storage).toMatchObject({
      ok: false,
      problem: "missing_bucket",
      buckets: { bundles: true, exports: false, public: true },
    });
    expect(body.database.ok).toBe(true);
    expect(response.body).not.toContain("usg-test-missing-bucket");
  });

  test("a wrong S3 secret: 503, access_denied, and the secret isn't echoed", async () => {
    const { response, body } = await health({ s3: { secretAccessKey: "wrong-s3-secret-x9" } });
    expect(response.statusCode).toBe(503);
    expect(body.storage).toMatchObject({ ok: false, problem: "access_denied" });
    expect(response.body).not.toContain("wrong-s3-secret-x9");
    expectNothingLeaked(response.body);
  });

  test("nothing listening at the S3 endpoint: unreachable", async () => {
    const { body } = await health({ s3: { endpoint: "http://127.0.0.1:1" } });
    expect(body.storage).toMatchObject({ ok: false, problem: "unreachable", server: null });
  });

  test("a wrong database password: 503, access_denied", async () => {
    const url = db.url;
    url.password = "wrong-db-password-x9";
    const { response, body } = await health({ databaseUrl: url.href });
    expect(response.statusCode).toBe(503);
    expect(body.database).toMatchObject({ ok: false, problem: "access_denied", postgres: null });
    expect(response.body).not.toContain("wrong-db-password-x9");
    expectNothingLeaked(response.body);
  });

  test("a database that doesn't exist: not_migrated", async () => {
    const url = db.url;
    url.pathname = "/usg_scratch_does_not_exist";
    const { body } = await health({ databaseUrl: url.href });
    expect(body.database).toMatchObject({ ok: false, problem: "not_migrated" });
  });

  test("a database without the migrations: not_migrated, with the server's version", async () => {
    // The maintenance database has neither dbmate's table nor PostGIS... unless the image's init
    // script put PostGIS there, so only the migration is asserted.
    const url = db.url;
    url.pathname = "/postgres";
    const { response, body } = await health({ databaseUrl: url.href });
    expect(response.statusCode).toBe(503);
    expect(body.database).toMatchObject({ ok: false, problem: "not_migrated", migration: null });
    expect(body.database.postgres).toMatch(/^18\./);
  });
});
