// GET /map/latest against PostGIS: 404 before the first publish, then the version map_head points
// at, with URLs a client can fetch the files from, and nothing private.

import { validateApiDocument } from "@usg/contracts/validators";
import {
  CONTRIBUTOR,
  pendingChangeSet,
  publishStatement,
  recordGates,
} from "@usg/db/test/fixtures";
import { type TestDb, useDatabase } from "@usg/db/test/harness";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildApp } from "../../src/app.ts";
import type { Database } from "../../src/database.ts";
import { createMemoryStorage } from "../../src/storage.ts";
import { useKysely } from "./helpers.ts";

const SHA_1 = "1".repeat(64);
const SHA_2 = "2".repeat(64);

async function seedOwner(db: TestDb): Promise<void> {
  await db.query(
    "INSERT INTO contributors (id, display_name, trust_tier) VALUES ($1, 'Owner', 'owner')",
    [CONTRIBUTOR.owner],
  );
}

/** Publishes a version the way the publish transaction will: one owner_mapper change set. */
async function publishVersion(
  db: TestDb,
  sha: string,
  publishedAt: string,
  restores: number | null = null,
): Promise<number> {
  let version = 0;
  await db.committed(async () => {
    const changeSet = await pendingChangeSet(db, CONTRIBUTOR.owner, "structural", '[{"op":"add"}]');
    await recordGates(db, changeSet, "gates_passed");
    version = await db.value<number>(
      `INSERT INTO map_versions (published_at, published_by, snapshot_uri, snapshot_sha256,
                                 private_export_uri, restores, note)
       VALUES ($1, $2, $3, $4, $5, $6, 'private note')
       RETURNING id`,
      [
        publishedAt,
        CONTRIBUTOR.owner,
        `snapshots/${sha}/`,
        sha,
        `exports/private-${sha.slice(0, 8)}.json.br`,
        restores,
      ],
    );
    const [sql, params] = publishStatement(changeSet, "owner_mapper", { version });
    await db.query(sql, params);
    await db.query("UPDATE map_head SET version_id = $1", [version]);
  });
  return version;
}

const db = useDatabase(seedOwner);
const kysely = useKysely(db);

function app(publicFilesUrl?: string): () => FastifyInstance {
  let instance: FastifyInstance | undefined;
  beforeAll(async () => {
    instance = await buildApp({
      db: kysely() as Kysely<Database>,
      storage: createMemoryStorage(),
      corsOrigins: [],
      publicFilesUrl,
    });
  });
  afterAll(async () => {
    await instance?.close();
  });
  return () => {
    if (instance === undefined) throw new Error("app not ready");
    return instance;
  };
}

const local = app();
const r2 = app("https://maps.example.org/files/");

describe("GET /map/latest", () => {
  test("404 before the first publish", async () => {
    const response = await local().inject({ url: "/map/latest" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      statusCode: 404,
      error: "Not Found",
      message: "No map version has been published yet",
    });
  });

  test("the version map_head points at, in Singapore time, with URLs under /public/", async () => {
    const version = await publishVersion(db, SHA_1, "2026-11-02T06:05:11.123456Z");
    const response = await local().inject({
      url: "/map/latest",
      headers: { host: "192.168.1.20:28000" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(validateApiDocument("GET /map/latest", body)).toEqual({ valid: true, problems: [] });
    expect(body).toEqual({
      version,
      published_at: "2026-11-02T14:05:11+08:00",
      snapshot_sha256: SHA_1,
      restores: null,
      files: {
        indoor: {
          path: `snapshots/${SHA_1}/indoor.json`,
          url: `http://192.168.1.20:28000/public/snapshots/${SHA_1}/indoor.json`,
        },
        street: {
          path: `snapshots/${SHA_1}/street.json`,
          url: `http://192.168.1.20:28000/public/snapshots/${SHA_1}/street.json`,
        },
      },
    });
    expect(response.body).not.toMatch(/exports\/|private note|published_by/);
  });

  test("follows map_head to a newer version, a rollback here", async () => {
    const first = await db.value<number>("SELECT version_id FROM map_head");
    const version = await publishVersion(db, SHA_2, "2026-11-03T01:00:00Z", first);
    const body = (await local().inject({ url: "/map/latest" })).json();
    expect(body).toMatchObject({ version, snapshot_sha256: SHA_2, restores: first });
  });

  test("URLs under API_PUBLIC_FILES_URL when it is set", async () => {
    const body = (await r2().inject({ url: "/map/latest" })).json();
    expect(body.files.street.url).toBe(
      `https://maps.example.org/files/snapshots/${SHA_2}/street.json`,
    );
  });

  test("a Host header that makes no URL is a 400", async () => {
    const response = await local().inject({ url: "/map/latest", headers: { host: "bad host" } });
    expect(response.statusCode).toBe(400);
  });
});
