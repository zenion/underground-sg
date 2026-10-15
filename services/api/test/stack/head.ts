// HEAD rows in the diff format, as a manual edit reads them (docs/diff-format.md, "Manual edits"),
// for tests that build diffs against the fixture: read through the export builder, which writes
// exactly that format.

import type { ChangeSetDiff, HeadExport } from "@usg/contracts";
import type { Kysely } from "kysely";
import type { Database } from "../../src/database.ts";
import { buildHeadExport } from "../../src/publish/export.ts";

type Table = Exclude<
  keyof HeadExport,
  "schema_version" | "version" | "published_at" | "snapshot_sha256"
>;

/** One HEAD row as `{ id, rev, row }`, in the diff format. */
export async function headRow<T extends Table>(
  db: Kysely<Database>,
  table: T,
  id: string,
): Promise<HeadExport[T][number]> {
  const head = await buildHeadExport(db, {
    version: 1,
    publishedAt: new Date("2026-10-15T00:00:00Z"),
    snapshotSha256: "0".repeat(64),
  });
  const entry = (head[table] as HeadExport[T][number][]).find((e) => e.id === id);
  if (entry === undefined) throw new Error(`HEAD has no ${table} row ${id}`);
  return entry;
}

/** Inserts a pending structural change set (committed) and returns its id. */
export async function insertChangeSet(
  db: Kysely<Database>,
  contributor: string,
  diff: ChangeSetDiff | unknown,
  baseVersionId: number | null = null,
): Promise<string> {
  const row = await db
    .insertInto("change_sets")
    .values({
      contributor_id: contributor,
      track: "structural",
      base_version_id: baseVersionId,
      diff: JSON.stringify(diff),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}
