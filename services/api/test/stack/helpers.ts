// Helpers for the stack tests (PostGIS and RustFS). Databases come from @usg/db's harness
// (`useDatabase`: a scratch copy of the migrated template per file); these add a Kysely pool on
// that database, and scratch buckets on the S3 endpoint in the root .env, so the tests never touch
// the developer's own database or buckets.

import { randomBytes } from "node:crypto";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { TestDb } from "@usg/db/test/harness";
import { loadRootEnv } from "@usg/scripts/env";
import type { Kysely } from "kysely";
import { afterAll, beforeAll } from "vitest";
import { type ApiConfig, loadConfig } from "../../src/config.ts";
import { createDatabase, type Database } from "../../src/database.ts";
import {
  createS3Client,
  type ObjectStore,
  S3ObjectStore,
  type Storage,
} from "../../src/storage.ts";

/** The settings in the root .env (or the environment, as in CI). */
export function stackConfig(): ApiConfig {
  loadRootEnv();
  return loadConfig();
}

/** A Kysely pool on the test file's database, opened after it is seeded and closed after the file. */
export function useKysely(db: TestDb): () => Kysely<Database> {
  let kysely: Kysely<Database> | undefined;
  beforeAll(() => {
    kysely = createDatabase(db.url.href, { maxConnections: 4 });
  });
  afterAll(async () => {
    await kysely?.destroy();
  });
  return () => {
    if (kysely === undefined) throw new Error("useKysely: the database is not ready");
    return kysely;
  };
}

const SCRATCH_BUCKET_PREFIX = "usg-test-";
const STALE_AFTER_MS = 60 * 60 * 1000;

async function emptyAndDelete(client: S3Client, bucket: string): Promise<void> {
  for (;;) {
    const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
    const keys = (listed.Contents ?? []).flatMap((object) =>
      object.Key === undefined ? [] : [{ Key: object.Key }],
    );
    if (keys.length === 0) break;
    await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
  }
  await client.send(new DeleteBucketCommand({ Bucket: bucket }));
}

/** Every key in a bucket, sorted. */
export async function listKeys(client: S3Client, bucket: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    for (const object of listed.Contents ?? []) if (object.Key !== undefined) keys.push(object.Key);
    token = listed.NextContinuationToken;
  } while (token !== undefined);
  return keys.sort();
}

/**
 * A bucket of its own for the test file, named usg-test-<epoch ms>-<hex>, emptied and deleted
 * after the file. Buckets left by a run that crashed more than an hour ago are deleted first.
 */
export function useScratchBucket(): {
  readonly name: () => string;
  readonly client: () => S3Client;
} {
  let client: S3Client | undefined;
  let bucket: string | undefined;
  beforeAll(async () => {
    client = createS3Client(stackConfig().s3);
    const { Buckets = [] } = await client.send(new ListBucketsCommand({}));
    for (const { Name } of Buckets) {
      const created = Number(Name?.slice(SCRATCH_BUCKET_PREFIX.length).split("-")[0]);
      if (Name?.startsWith(SCRATCH_BUCKET_PREFIX) && Date.now() - created > STALE_AFTER_MS) {
        await emptyAndDelete(client, Name);
      }
    }
    bucket = `${SCRATCH_BUCKET_PREFIX}${Date.now()}-${randomBytes(4).toString("hex")}`;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  });
  afterAll(async () => {
    if (client !== undefined && bucket !== undefined) await emptyAndDelete(client, bucket);
    client?.destroy();
  });
  return {
    name: () => {
      if (bucket === undefined) throw new Error("useScratchBucket: the bucket is not ready");
      return bucket;
    },
    client: () => {
      if (client === undefined) throw new Error("useScratchBucket: the bucket is not ready");
      return client;
    },
  };
}

/**
 * Storage over two scratch buckets of the test file: one for the public files and one for the
 * private exports (and the bundles, which the publish never touches). `wrapPublic` can stand in
 * for the public bucket, for example to make one write fail.
 */
export function useScratchStorage(): {
  readonly storage: (wrapPublic?: (store: ObjectStore) => ObjectStore) => Storage;
  readonly publicBucket: ReturnType<typeof useScratchBucket>;
  readonly exportsBucket: ReturnType<typeof useScratchBucket>;
} {
  const publicBucket = useScratchBucket();
  const exportsBucket = useScratchBucket();
  return {
    publicBucket,
    exportsBucket,
    storage: (wrapPublic = (store) => store) => {
      const exports = new S3ObjectStore(exportsBucket.client(), exportsBucket.name());
      return {
        buckets: {
          bundles: exports,
          exports,
          public: wrapPublic(new S3ObjectStore(publicBucket.client(), publicBucket.name())),
        },
        serverVersion: async () => undefined,
        close: () => {},
      };
    },
  };
}

/**
 * Waits until at least `count` backends of the test file's database wait on a lock. Asked on the
 * harness's own connection, outside any transaction: pg_stat_activity is a snapshot taken once per
 * transaction.
 */
export async function waitForLockWaiters(db: TestDb, count: number): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const waiting = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((waiting[0]?.n ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fewer than ${count} backends ever waited on a lock`);
}

/** A promise to hold an operation at, and the function that lets it go. */
export function gate(): {
  readonly reached: Promise<void>;
  readonly wait: () => Promise<void>;
  readonly release: () => void;
} {
  let arrive: () => void = () => {};
  let open: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    reached,
    wait: () => {
      arrive();
      return opened;
    },
    release: () => open(),
  };
}
