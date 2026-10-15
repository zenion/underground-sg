// The publish transaction (docs/decisions/0004-storage-and-versioning.md, "Approval and publish
// order"; docs/diff-format.md, "Approval"; docs/snapshot-format.md). A library function: the CLI
// runs it now (`pnpm map publish`), a worker or the approval path later. Never an HTTP route:
// heavy work never runs in the API process (CLAUDE.md).
//
//  1. Lock map_head (SELECT ... FOR UPDATE): publishes are serialised. The transaction's session
//     ends if it sits idle (waiting on the object store) for IDLE_IN_TRANSACTION_TIMEOUT.
//  2. Check the change sets it was given: pending, structural, the owner's (Phase 1 publishes only
//     through owner_mapper), with gates_passed as their latest gates result, recorded for the diff
//     and captures they have now, and no failed or privacy-flagged capture. Refuse real data on a
//     database that holds the demo map, and the demo flag on one that doesn't. Any problem refuses
//     the whole publish, and nothing changes.
//  3. For each change set, oldest first: the rebase check, then its diff under a savepoint
//     (src/publish/apply.ts). One that needs a rebase, that the database refuses, or that would
//     leave a feature overlapping a restricted zone (the zones as they are now) becomes
//     needs_rebase and applies nothing; the others carry on. If none is left, the transaction
//     commits those decisions and publishes no version.
//  4. Rebuild street_connectors. Check the whole of HEAD against the restricted zones, as the
//     public files will draw it, street connectors included: anything overlapping refuses the
//     publish before a file is written. Then build the snapshot inside the transaction.
//  5. Upload the version files, brotli-compressed, to their content-addressed directory, before
//     commit. Files already there are read back and reused if they match, and never overwritten.
//  6. Write the private full export under a key of its own for the version.
//  7. Insert map_versions, mark the change sets auto_published through owner_mapper with the
//     version, record the publish in moderation_events, and point map_head at the version.
//  8. Commit. The database checks, at the latest here, every rule of the publish paths.
//  9. Write latest.json (updateLatest: only while map_head still names this version, so it never
//     moves back), and an empty status.json if there is none. If that fails, the version stands
//     and `reconcileLatest` repairs the pointer.

import { randomUUID } from "node:crypto";
import {
  CACHE_CONTROL,
  headExportKey,
  snapshotFilePath,
  VERSION_FILES,
  type VersionFileName,
} from "@usg/contracts";
import { sha256Hex } from "@usg/contracts/validators";
import { type Kysely, sql } from "kysely";
import type { Database } from "../database.ts";
import { holdsDemo } from "../demo-flag.ts";
import type { ObjectStore, Storage } from "../storage.ts";
import { applyChangeSet } from "./apply.ts";
import { buildHeadExport, serialiseExport } from "./export.ts";
import { diffSha256Sql } from "./gates.ts";
import { brotli, decodedBytes } from "./objects.ts";
import { latestPointer, limitIdleInTransaction, updateLatest } from "./pointer.ts";
import { describeOverlap, headOverlaps } from "./restricted-zones.ts";
import { type BuiltSnapshot, buildSnapshot } from "./snapshot.ts";
import { rebuildStreetConnectors } from "./street-connectors.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The only publish path in Phase 1: the owner's structural work, published without review. */
export const PHASE_1_PUBLISH_PATH = "owner_mapper";

export interface PublishOptions {
  /** The change sets to publish. At least one: every version except a rollback publishes one. */
  readonly changeSetIds: readonly string[];
  /** map_versions.published_by: the contributor publishing, with tier owner. */
  readonly publishedBy: string;
  /** map_versions.note: private. */
  readonly note?: string | null;
  /**
   * Publishing on top of the demo map (`pnpm demo`): required when the database holds the demo,
   * refused when it doesn't. latest.json's `demo` follows the database (src/demo-flag.ts).
   */
  readonly demo?: boolean;
}

export interface NeedsRebase {
  readonly id: string;
  readonly reasons: readonly string[];
}

export interface PublishedVersion {
  readonly id: number;
  readonly snapshotSha256: string;
  /** map_versions.snapshot_uri. */
  readonly directory: string;
  /** Version files uploaded now, and ones already in the directory with the same content. */
  readonly uploaded: readonly VersionFileName[];
  readonly reused: readonly VersionFileName[];
  /** map_versions.private_export_uri: the export's key in the private exports bucket. */
  readonly exportKey: string;
}

export interface PointerOutcome {
  /** Whether latest.json now points at the version. */
  readonly updated: boolean;
  /**
   * A newer version was published before this one's pointer was written: latest.json is left to
   * it, and needs no repair on this version's account.
   */
  readonly superseded?: boolean;
  /** latest.json's `demo`, as the database gives it. */
  readonly demo?: boolean;
  /** Why the write failed; run the reconcile job. */
  readonly error?: string;
}

export interface PublishResult {
  /** The new version, or null when every change set needed a rebase. */
  readonly version: PublishedVersion | null;
  /** The change sets the version published. */
  readonly published: readonly string[];
  readonly needsRebase: readonly NeedsRebase[];
  /** latest.json; when neither updated nor superseded, run the reconcile job. */
  readonly pointer: PointerOutcome;
}

/** The publish was refused, and nothing changed. */
export class PublishRefusedError extends Error {
  override name = "PublishRefusedError";
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`The publish was refused: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

/** A version file's directory holds different bytes: an immutable file is never overwritten. */
export class ImmutableFileError extends Error {
  override name = "ImmutableFileError";
}

/** A change set as the publish reads it. */
interface ChangeSetRow {
  readonly id: string;
  readonly contributor_id: string;
  readonly track: "structural" | "status";
  readonly decision: string;
  readonly base_version_id: number | null;
  readonly diff: unknown;
  readonly diff_sha256: string;
}

/** The latest gates event of a change set the publish relies on. */
interface GatesRecord {
  readonly id: string;
  readonly diffSha256: string;
}

/**
 * Publishes change sets as a new map version, as set out above. Throws PublishRefusedError, having
 * changed nothing, when a change set may not be published or HEAD would publish a feature
 * overlapping a restricted zone; returns the version, or none when every change set needed a
 * rebase.
 */
export async function publish(
  db: Kysely<Database>,
  storage: Storage,
  options: PublishOptions,
): Promise<PublishResult> {
  if (db.isTransaction) throw new Error("publish runs its own transaction");
  const ids = [...new Set(options.changeSetIds.map((id) => id.toLowerCase()))];
  const publishedBy = options.publishedBy.toLowerCase();
  if (ids.length === 0) {
    throw new PublishRefusedError([
      "no change sets: every map version except a rollback publishes at least one",
    ]);
  }
  const malformed = [...ids, publishedBy].filter((id) => !UUID.test(id));
  if (malformed.length > 0) {
    throw new PublishRefusedError(malformed.map((id) => `${JSON.stringify(id)} is not an id`));
  }

  const committed = await db.transaction().execute(async (trx) => {
    // 1. Serialise publishes.
    await trx.selectFrom("map_head").select("version_id").forUpdate().executeTakeFirstOrThrow();
    await limitIdleInTransaction(trx);

    // 2. What may be published, checked before anything changes.
    const changeSets: ChangeSetRow[] = await trx
      .selectFrom("change_sets")
      .select([
        "id",
        "contributor_id",
        "track",
        "decision",
        "base_version_id",
        "diff",
        diffSha256Sql("diff").as("diff_sha256"),
      ])
      .where("id", "in", ids)
      .orderBy("created_at")
      .orderBy("id")
      .forUpdate()
      .execute();
    const gates = await refuseIfNotPublishable(trx, ids, changeSets, publishedBy, options);
    const demo = await holdsDemo(trx);

    // 3. Apply each change set, or send it to needs_rebase.
    const published: string[] = [];
    const needsRebase: NeedsRebase[] = [];
    for (const changeSet of changeSets) {
      const outcome = await applyChangeSet(trx, changeSet);
      if (outcome.decision === "applied") {
        published.push(changeSet.id);
        continue;
      }
      needsRebase.push({ id: changeSet.id, reasons: outcome.reasons });
      await trx
        .updateTable("change_sets")
        .set({ decision: "needs_rebase" })
        .where("id", "=", changeSet.id)
        .execute();
      await trx
        .insertInto("moderation_events")
        .values({
          change_set_id: changeSet.id,
          actor_id: null,
          action: "needs_rebase",
          detail: JSON.stringify({ reasons: outcome.reasons }),
        })
        .execute();
    }
    if (published.length === 0) return { version: null, published, needsRebase, demo };

    // 4. Street connectors, the restricted zones across the whole of HEAD, then the public files
    // from HEAD as this transaction now sees it.
    await rebuildStreetConnectors(trx);
    const overlaps = await headOverlaps(trx, { connectors: true });
    if (overlaps.length > 0) {
      throw new PublishRefusedError([
        ...overlaps.map(describeOverlap),
        "HEAD may not publish a feature that overlaps a restricted zone (a zone drawn over it since it was published, or a street connector): publish a change set that moves or removes it first",
      ]);
    }
    const snapshot = await buildSnapshot(trx);

    // The version's id and time, known before the files are written: the export carries both.
    // The clock, not now(): now() is when the transaction began, before it waited for the lock,
    // so a version could otherwise seem published before the one it waited for.
    const { id: version, now } = await sql<{ id: number; now: Date }>`
      SELECT nextval(pg_get_serial_sequence('map_versions', 'id'))::integer AS id,
             clock_timestamp() AS now`
      .execute(trx)
      .then((result) => {
        const row = result.rows[0];
        if (row === undefined) throw new Error("no version id");
        return row;
      });

    // 5. Upload before commit: every committed version has its files.
    const files = await uploadVersionFiles(storage.buckets.public, snapshot);

    // 6. The private full export, under a key of its own (never from snapshot_sha256).
    const exportKey = headExportKey(version, randomUUID());
    const exported = await buildHeadExport(trx, {
      version,
      publishedAt: now,
      snapshotSha256: snapshot.snapshotSha256,
    });
    await storage.buckets.exports.put(exportKey, await brotli(serialiseExport(exported)), {
      contentType: "application/json",
      contentEncoding: "br",
    });

    // 7. The version, the change sets it publishes, and the head.
    await trx
      .insertInto("map_versions")
      .values({
        id: version,
        published_at: now,
        published_by: publishedBy,
        snapshot_uri: snapshot.directory,
        snapshot_sha256: snapshot.snapshotSha256,
        private_export_uri: exportKey,
        restores: null,
        note: options.note ?? null,
      })
      .execute();
    await trx
      .updateTable("change_sets")
      .set({
        decision: "auto_published",
        publish_path: PHASE_1_PUBLISH_PATH,
        map_version_id: version,
      })
      .where("id", "in", published)
      .execute();
    await trx
      .insertInto("moderation_events")
      .values(
        published.map((id) => ({
          change_set_id: id,
          actor_id: publishedBy,
          action: "published",
          detail: JSON.stringify({
            version,
            publish_path: PHASE_1_PUBLISH_PATH,
            gates_event: gates.get(id)?.id,
            diff_sha256: gates.get(id)?.diffSha256,
          }),
        })),
      )
      .execute();
    await trx.updateTable("map_head").set({ version_id: version }).execute();

    return {
      version: {
        id: version,
        publishedAt: now,
        snapshot,
        files,
        exportKey,
      },
      published,
      needsRebase,
      demo,
    };
  });

  if (committed.version === null) {
    return {
      version: null,
      published: committed.published,
      needsRebase: committed.needsRebase,
      pointer: { updated: false },
    };
  }

  // 9. After commit: clients never see a version that might still roll back.
  const { id, publishedAt, snapshot, files, exportKey } = committed.version;
  const demo = committed.demo;
  let pointer: PointerOutcome;
  try {
    const digest = (name: VersionFileName) => ({
      bytes: snapshot.files[name].bytes.byteLength,
      sha256: snapshot.files[name].sha256,
    });
    const outcome = await updateLatest(
      db,
      storage.buckets.public,
      latestPointer({
        version: id,
        publishedAt,
        snapshotSha256: snapshot.snapshotSha256,
        files: { "indoor.json": digest("indoor.json"), "street.json": digest("street.json") },
        demo,
      }),
    );
    pointer =
      outcome === "written" ? { updated: true, demo } : { updated: false, superseded: true, demo };
  } catch (error) {
    pointer = {
      updated: false,
      demo,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    version: {
      id,
      snapshotSha256: snapshot.snapshotSha256,
      directory: snapshot.directory,
      uploaded: files.uploaded,
      reused: files.reused,
      exportKey,
    },
    published: committed.published,
    needsRebase: committed.needsRebase,
    pointer,
  };
}

/** Two lists of ids hold the same ids. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const sorted = (list: readonly string[]) => [...list].sort().join(",");
  return sorted(a) === sorted(b);
}

/**
 * Refuses the publish, with every reason, unless each change set may be published through
 * owner_mapper now. The database enforces the publish paths' rules when the path is set; checking
 * first refuses before any file is uploaded, and says why. Returns each change set's gates event.
 */
async function refuseIfNotPublishable(
  db: Kysely<Database>,
  ids: readonly string[],
  changeSets: readonly ChangeSetRow[],
  publishedBy: string,
  options: PublishOptions,
): Promise<Map<string, GatesRecord>> {
  const problems: string[] = [];
  const publisher = await db
    .selectFrom("contributors")
    .select("trust_tier")
    .where("id", "=", publishedBy)
    .executeTakeFirst();
  if (publisher === undefined) problems.push(`no contributor ${publishedBy} to publish as`);
  else if (publisher.trust_tier !== "owner") {
    problems.push(`the publisher has tier ${publisher.trust_tier}: Phase 1 publishes as the owner`);
  }

  const demo = await holdsDemo(db);
  if (demo && options.demo !== true) {
    problems.push(
      "the database holds the demo map (pnpm demo): run `pnpm demo --reset` before publishing real data",
    );
  } else if (!demo && options.demo === true) {
    problems.push("demo is set, but the database doesn't hold the demo map");
  }

  const found = new Set(changeSets.map((c) => c.id));
  for (const id of ids) if (!found.has(id)) problems.push(`no change set ${id}`);

  const contributors = new Map(
    (
      await db
        .selectFrom("contributors")
        .select(["id", "trust_tier"])
        .where(
          "id",
          "in",
          changeSets.map((c) => c.contributor_id),
        )
        .execute()
    ).map((c) => [c.id, c.trust_tier]),
  );
  const gates = new Map(
    (
      await sql<{ change_set_id: string; id: string; action: string; detail: unknown }>`
        SELECT DISTINCT ON (change_set_id) change_set_id, id::text AS id, action, detail
          FROM moderation_events
         WHERE change_set_id = ANY(${[...ids]}::uuid[])
           AND action IN ('gates_passed', 'gates_failed')
         ORDER BY change_set_id, id DESC`.execute(db)
    ).rows.map((row) => [row.change_set_id, row]),
  );
  const captures = await db
    .selectFrom("change_set_captures as csc")
    .innerJoin("captures as c", "c.id", "csc.capture_id")
    .select(["csc.change_set_id", "c.id", "c.status", "c.privacy_flagged"])
    .where("csc.change_set_id", "in", [...ids])
    .execute();

  const records = new Map<string, GatesRecord>();
  for (const changeSet of changeSets) {
    const at = `change set ${changeSet.id}`;
    const runAgain = `run them again (pnpm map gates ${changeSet.id})`;
    if (changeSet.track !== "structural") problems.push(`${at} is a status change set`);
    if (changeSet.decision !== "pending") problems.push(`${at} is ${changeSet.decision}`);
    if (contributors.get(changeSet.contributor_id) !== "owner") {
      problems.push(
        `${at} is not the owner's: Phase 1 publishes only through owner_mapper (moderator review comes in Phase 4)`,
      );
    }
    const linked = captures.filter((c) => c.change_set_id === changeSet.id);
    const latestGates = gates.get(changeSet.id);
    if (latestGates === undefined) {
      problems.push(`${at}: the automated gates have not run (pnpm map gates ${changeSet.id})`);
    } else if (latestGates.action !== "gates_passed") {
      problems.push(`${at}: the automated gates failed`);
    } else {
      // The gates passed for what the change set holds now, not for an earlier diff or captures.
      const detail = (latestGates.detail ?? {}) as { diff_sha256?: unknown; captures?: unknown };
      if (detail.diff_sha256 !== changeSet.diff_sha256) {
        problems.push(`${at}: its diff isn't the one its gates checked: ${runAgain}`);
      }
      const gated = Array.isArray(detail.captures) ? detail.captures.map(String) : undefined;
      if (
        gated === undefined ||
        !sameIds(
          gated,
          linked.map((c) => c.id),
        )
      ) {
        problems.push(`${at}: its captures aren't the ones its gates checked: ${runAgain}`);
      }
      records.set(changeSet.id, { id: latestGates.id, diffSha256: changeSet.diff_sha256 });
    }
    for (const c of linked) {
      if (c.privacy_flagged) problems.push(`${at}: capture ${c.id} is privacy-flagged`);
      if (c.status !== "ready_for_review" && c.status !== "approved") {
        problems.push(`${at}: capture ${c.id} is ${c.status}`);
      }
    }
  }
  if (problems.length > 0) throw new PublishRefusedError(problems);
  return records;
}

/**
 * Uploads a version's files, brotli-compressed, to its content-addressed directory. A file that is
 * already there is read back: reused if it decodes to the same bytes, and an error if not, since a
 * directory is never overwritten.
 */
export async function uploadVersionFiles(
  store: ObjectStore,
  snapshot: BuiltSnapshot,
): Promise<{ uploaded: VersionFileName[]; reused: VersionFileName[] }> {
  const uploaded: VersionFileName[] = [];
  const reused: VersionFileName[] = [];
  for (const name of VERSION_FILES) {
    const key = snapshotFilePath(snapshot.snapshotSha256, name);
    const file = snapshot.files[name];
    const existing = await store.get(key);
    if (existing !== undefined) {
      if (sha256Hex(await decodedBytes(existing)) !== file.sha256) {
        throw new ImmutableFileError(
          `${key} is already stored with other content; a version's files are never overwritten`,
        );
      }
      reused.push(name);
      continue;
    }
    await store.put(key, await brotli(file.bytes), {
      contentType: "application/geo+json",
      contentEncoding: "br",
      cacheControl: CACHE_CONTROL.version,
    });
    uploaded.push(name);
  }
  return { uploaded, reused };
}
