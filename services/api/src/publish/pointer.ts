// latest.json and status.json (docs/snapshot-format.md): the short-TTL files outside versions.
// The publish transaction writes latest.json after it commits, so clients never see a version that
// might still roll back, and writes an empty status.json beside it when there is none yet. If that
// last step fails, `reconcileLatest` repairs the pointer from map_head.
//
// latest.json only moves forward. Every write of it (updateLatest after a publish, and
// reconcileLatest) happens in a short transaction holding map_head FOR SHARE, and only while
// map_head names the version written: a publish takes map_head FOR UPDATE before anything else, so
// no newer version can commit between that check and the write, and two writers never interleave.
// A writer whose version map_head has moved past leaves latest.json to the newer one; and neither
// ever replaces a latest.json naming a newer version than its own.
//
// Its `demo` flag follows the database (src/demo-flag.ts), never an option, so a pointer rewritten
// by the reconcile job keeps the banner and a real map never gets one.

import {
  CACHE_CONTROL,
  type LatestPointer,
  SNAPSHOT_SCHEMA_VERSION,
  type StatusOverlay,
  snapshotDirectory,
  snapshotFilePath,
  VERSION_FILES,
  type VersionFileName,
} from "@usg/contracts";
import { sha256Hex, snapshotSha256, validateSnapshotFile } from "@usg/contracts/validators";
import { type Kysely, sql } from "kysely";
import type { Database } from "../database.ts";
import { holdsDemo } from "../demo-flag.ts";
import { currentVersion } from "../map-head.ts";
import type { ObjectStore, Storage } from "../storage.ts";
import { singaporeDateTime } from "../time.ts";
import { decodedBytes } from "./objects.ts";
import { STREET_SOURCE } from "./snapshot.ts";

export const LATEST_KEY = "latest.json";
export const STATUS_KEY = "status.json";

/**
 * The data sources every version carries, for latest.json's `attribution`. OpenStreetMap's for
 * street.json, always. LTA's exit data joins when the LTA exit import (Phase 1) puts exit
 * positions in a version, with the date the data was accessed.
 */
export const ATTRIBUTION: LatestPointer["attribution"] = [
  { text: STREET_SOURCE.attribution, url: STREET_SOURCE.attribution_url },
];

/** A version file's decoded size and hash, as latest.json lists them. */
export interface FileDigest {
  readonly bytes: number;
  readonly sha256: string;
}

export interface LatestInput {
  readonly version: number;
  readonly publishedAt: Date;
  readonly snapshotSha256: string;
  readonly files: Readonly<Record<VersionFileName, FileDigest>>;
  /** latest.json's `demo`: true for demonstration data; absent otherwise. */
  readonly demo?: boolean | undefined;
}

/** The pointer document for a version, validated. */
export function latestPointer(input: LatestInput): LatestPointer {
  const file = (name: VersionFileName) => ({
    path: snapshotFilePath(input.snapshotSha256, name),
    bytes: input.files[name].bytes,
    sha256: input.files[name].sha256,
  });
  const pointer: LatestPointer = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    version: input.version,
    published_at: singaporeDateTime(input.publishedAt),
    snapshot_sha256: input.snapshotSha256,
    files: { indoor: file("indoor.json"), street: file("street.json") },
    attribution: ATTRIBUTION,
    ...(input.demo === true ? { demo: true } : {}),
  };
  const validation = validateSnapshotFile("latest.json", pointer);
  if (!validation.valid) {
    throw new Error(`latest.json fails validation: ${validation.problems.join("; ")}`);
  }
  return pointer;
}

function json(document: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(document));
}

/** Writes latest.json (uncompressed, short TTL). */
export async function writeLatest(store: ObjectStore, pointer: LatestPointer): Promise<void> {
  await store.put(LATEST_KEY, json(pointer), {
    contentType: "application/json",
    cacheControl: CACHE_CONTROL.latest,
  });
}

/**
 * Writes status.json with no entries if there is none yet (the overlay itself arrives in
 * Phase 4). Returns whether it wrote one.
 */
export async function ensureStatus(store: ObjectStore, now: Date = new Date()): Promise<boolean> {
  if ((await store.head(STATUS_KEY)) !== undefined) return false;
  const status: StatusOverlay = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    generated_at: singaporeDateTime(now),
    entries: [],
  };
  const validation = validateSnapshotFile("status.json", status);
  if (!validation.valid) {
    throw new Error(`status.json fails validation: ${validation.problems.join("; ")}`);
  }
  await store.put(STATUS_KEY, json(status), {
    contentType: "application/json",
    cacheControl: CACHE_CONTROL.status,
  });
  return true;
}

/** latest.json as stored, or undefined when there is none or it isn't JSON. */
export async function readLatest(store: ObjectStore): Promise<LatestPointer | undefined> {
  const object = await store.get(LATEST_KEY);
  if (object === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(await decodedBytes(object))) as LatestPointer;
  } catch {
    return undefined;
  }
}

export class ReconcileError extends Error {
  override name = "ReconcileError";
}

/**
 * How long a transaction that holds map_head may sit idle (waiting on the object store) before
 * PostgreSQL ends its session. The S3 client's own timeouts come first (src/storage.ts); this keeps
 * anything else that hangs from holding the lock for good.
 */
export const IDLE_IN_TRANSACTION_TIMEOUT = "5min";

/** Sets IDLE_IN_TRANSACTION_TIMEOUT for the transaction `trx`. */
export async function limitIdleInTransaction(trx: Kysely<Database>): Promise<void> {
  await sql`SET LOCAL idle_in_transaction_session_timeout = ${sql.lit(IDLE_IN_TRANSACTION_TIMEOUT)}`.execute(
    trx,
  );
}

/** map_head's version, locked FOR SHARE until the transaction ends; null before the first publish. */
async function lockHead(trx: Kysely<Database>): Promise<number | null> {
  const { rows } = await sql<{
    version_id: number | null;
  }>`SELECT version_id FROM map_head FOR SHARE`.execute(trx);
  return rows[0]?.version_id ?? null;
}

/** Throws when latest.json already names a newer version than `version`: it never moves back. */
function refuseBackwards(existing: LatestPointer | undefined, version: number): void {
  const named = existing?.version;
  if (typeof named === "number" && named > version) {
    throw new ReconcileError(
      `latest.json names version ${named}, newer than map_head's version ${version}, and never moves back: the bucket holds another database's map`,
    );
  }
}

export type LatestUpdate = "written" | "superseded";

/**
 * Points latest.json at `pointer`'s version after its publish has committed, and writes an empty
 * status.json if there is none, holding map_head FOR SHARE in a short transaction of its own.
 * "superseded" when map_head has moved on to a newer version, whose publish writes its own pointer:
 * latest.json is left alone. Throws ReconcileError when latest.json names a newer version.
 */
export async function updateLatest(
  db: Kysely<Database>,
  store: ObjectStore,
  pointer: LatestPointer,
): Promise<LatestUpdate> {
  if (db.isTransaction) throw new Error("updateLatest runs in a transaction of its own");
  return db.transaction().execute(async (trx) => {
    await limitIdleInTransaction(trx);
    const head = await lockHead(trx);
    if (head === null || head < pointer.version) {
      throw new ReconcileError(
        `map_head names version ${head ?? "none"}, not ${pointer.version}: it hasn't committed`,
      );
    }
    if (head > pointer.version) return "superseded";
    refuseBackwards(await readLatest(store), pointer.version);
    await writeLatest(store, pointer);
    await ensureStatus(store);
    return "written";
  });
}

export type ReconcileResult =
  | { readonly action: "nothing_published" }
  | {
      readonly action: "unchanged" | "repaired";
      readonly version: number;
      /** The version latest.json named before, or null when it was missing or unreadable. */
      readonly previousVersion: number | null;
      readonly statusWritten: boolean;
    };

/**
 * Repairs latest.json from map_head (the reconcile job): when it is missing, unreadable, or differs
 * from what map_head's version gives, it is rewritten from the version's row and the files in its
 * directory, which are read back and checked against snapshot_sha256 first, with `demo` as the
 * database says. Also writes an empty status.json if there is none. Holds map_head FOR SHARE
 * throughout, so a publish waits for it rather than being overwritten by it; refuses to replace a
 * latest.json naming a newer version. Safe to run at any time.
 */
export async function reconcileLatest(
  db: Kysely<Database>,
  storage: Storage,
): Promise<ReconcileResult> {
  if (db.isTransaction) throw new Error("reconcileLatest runs in a transaction of its own");
  return db.transaction().execute(async (trx) => {
    await limitIdleInTransaction(trx);
    await lockHead(trx);
    return reconcileLocked(trx, storage);
  });
}

async function reconcileLocked(db: Kysely<Database>, storage: Storage): Promise<ReconcileResult> {
  const head = await currentVersion(db);
  if (head === undefined) return { action: "nothing_published" };
  const store = storage.buckets.public;
  if (head.snapshot_uri !== snapshotDirectory(head.snapshot_sha256)) {
    throw new ReconcileError(`map version ${head.id}: snapshot_uri does not match snapshot_sha256`);
  }

  const bytes = {} as Record<VersionFileName, Uint8Array>;
  for (const name of VERSION_FILES) {
    const object = await store.get(snapshotFilePath(head.snapshot_sha256, name));
    if (object === undefined) {
      throw new ReconcileError(`map version ${head.id}: ${name} is missing from its directory`);
    }
    bytes[name] = await decodedBytes(object);
  }
  if (snapshotSha256(bytes) !== head.snapshot_sha256) {
    throw new ReconcileError(`map version ${head.id}: its files do not match its snapshot_sha256`);
  }

  const existing = await readLatest(store);
  refuseBackwards(existing, head.id);
  const demo = await holdsDemo(db);
  const digest = (name: VersionFileName): FileDigest => ({
    bytes: bytes[name].byteLength,
    sha256: sha256Hex(bytes[name]),
  });
  const pointer = latestPointer({
    version: head.id,
    publishedAt: head.published_at,
    snapshotSha256: head.snapshot_sha256,
    files: { "indoor.json": digest("indoor.json"), "street.json": digest("street.json") },
    demo,
  });

  const unchanged = existing !== undefined && JSON.stringify(existing) === JSON.stringify(pointer);
  if (!unchanged) await writeLatest(store, pointer);
  const statusWritten = await ensureStatus(store);
  return {
    action: unchanged ? "unchanged" : "repaired",
    version: head.id,
    previousVersion: typeof existing?.version === "number" ? existing.version : null,
    statusWritten,
  };
}
