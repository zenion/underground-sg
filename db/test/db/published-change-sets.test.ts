// A published change set, its capture links and its status reports are frozen, and rejected
// and rolled_back are final.

import { describe, expect, test } from "vitest";
import {
  CONTRIBUTOR,
  capture,
  link,
  newVersion,
  pendingChangeSet,
  publish,
  recordGates,
  seedCluster,
  statusReport,
} from "./fixtures.ts";
import { SQLSTATE, useDatabase } from "./harness.ts";

const db = useDatabase(seedCluster);

const refusedBecause = (message: RegExp) => ({ code: SQLSTATE.checkViolation, message });

/** The owner's structural change set with one capture, published through owner_mapper. */
async function publishedStructural(): Promise<{ id: string; captureId: string }> {
  const id = await pendingChangeSet(db, CONTRIBUTOR.owner, "structural", '[{"op":"add"}]');
  const captureId = await capture(db);
  await link(db, id, captureId);
  await recordGates(db, id, "gates_passed");
  await publish(db, id, "owner_mapper");
  return { id, captureId };
}

/**
 * A newcomer's structural change set, published through moderator_review. Its eligibility
 * does not depend on track or contributor, so changing those reaches the freeze.
 */
async function publishedReviewed(): Promise<string> {
  const id = await pendingChangeSet(db, CONTRIBUTOR.newcomer, "structural", '[{"op":"add"}]');
  await recordGates(db, id, "gates_passed");
  await publish(db, id, "moderator_review", CONTRIBUTOR.moderator);
  return id;
}

/** A trusted contributor's status change set with one report, published. */
async function publishedStatus(): Promise<{ id: string; reportId: string }> {
  const id = await pendingChangeSet(db, CONTRIBUTOR.trusted, "status");
  const reportId = await statusReport(db, id);
  await recordGates(db, id, "gates_passed");
  await publish(db, id, "trusted_status_auto");
  return { id, reportId };
}

describe("a published change set is frozen", () => {
  test.each([
    ["diff", 'diff = \'[{"op":"remove"}]\''],
    ["track", "track = 'status', diff = '[]', map_version_id = NULL"],
    ["contributor", `contributor_id = '${CONTRIBUTOR.trusted}'`],
    ["base version", "base_version_id = map_version_id"],
    ["reviewer", `reviewer_id = '${CONTRIBUTOR.secondModerator}'`],
  ])("changing its %s is refused", (_what, assignment) =>
    db.rolledBack(async () => {
      const id = await publishedReviewed();
      await db.expectRefused(
        `UPDATE change_sets SET ${assignment} WHERE id = $1`,
        [id],
        refusedBecause(/a published change set is frozen/),
      );
    }),
  );

  test("re-pointing it at another version is refused", () =>
    db.rolledBack(async () => {
      const id = await publishedReviewed();
      const other = await newVersion(db);
      await db.expectRefused(
        "UPDATE change_sets SET map_version_id = $2 WHERE id = $1",
        [id, other],
        refusedBecause(/a published change set is frozen/),
      );
    }));

  test("its note can still be edited, and it can be rolled back", () =>
    db.rolledBack(async () => {
      const { id } = await publishedStructural();
      await db.query("UPDATE change_sets SET note = 'walked again on a weekday' WHERE id = $1", [
        id,
      ]);
      await db.query("UPDATE change_sets SET decision = 'rolled_back' WHERE id = $1", [id]);
    }));

  test("deleting it is refused", () =>
    db.rolledBack(async () => {
      const { id } = await publishedStructural();
      await db.expectRefused(
        "DELETE FROM change_sets WHERE id = $1",
        [id],
        refusedBecause(/a published change set cannot be deleted/),
      );
    }));

  test("an unpublished change set with no audit events can be deleted, with its capture links", () =>
    db.rolledBack(async () => {
      const id = await pendingChangeSet(db, CONTRIBUTOR.owner, "structural");
      await link(db, id, await capture(db));
      await db.query('UPDATE change_sets SET diff = \'[{"op":"move"}]\' WHERE id = $1', [id]);
      await db.query("DELETE FROM change_sets WHERE id = $1", [id]);
      expect(
        await db.value<number>(
          "SELECT count(*)::int FROM change_set_captures WHERE change_set_id = $1",
          [id],
        ),
      ).toBe(0);
    }));
});

describe("a published change set's capture links are frozen", () => {
  const frozen = refusedBecause(/^change_set_captures: its change set is published$/);

  test("linking another capture is refused", () =>
    db.rolledBack(async () => {
      const { id } = await publishedStructural();
      await db.expectRefused(
        "INSERT INTO change_set_captures (change_set_id, capture_id) VALUES ($1, $2)",
        [id, await capture(db)],
        frozen,
      );
    }));

  test("unlinking or re-pointing a capture is refused", () =>
    db.rolledBack(async () => {
      const { id, captureId } = await publishedStructural();
      await db.expectRefused(
        "DELETE FROM change_set_captures WHERE change_set_id = $1",
        [id],
        frozen,
      );
      await db.expectRefused(
        "UPDATE change_set_captures SET capture_id = $2 WHERE change_set_id = $1 AND capture_id = $3",
        [id, await capture(db), captureId],
        frozen,
      );
    }));

  test("a pending change set's links can change", () =>
    db.rolledBack(async () => {
      const id = await pendingChangeSet(db, CONTRIBUTOR.owner, "structural");
      const captureId = await capture(db);
      await link(db, id, captureId);
      await db.query("DELETE FROM change_set_captures WHERE change_set_id = $1", [id]);
      await link(db, id, captureId);
    }));
});

describe("a published change set's status reports are frozen", () => {
  const frozen = refusedBecause(/^status_reports: its change set is published$/);

  test("editing, deleting or adding a report is refused", () =>
    db.rolledBack(async () => {
      const { id, reportId } = await publishedStatus();
      await db.expectRefused(
        "UPDATE status_reports SET is_open = true WHERE id = $1",
        [reportId],
        frozen,
      );
      await db.expectRefused("DELETE FROM status_reports WHERE id = $1", [reportId], frozen);
      await db.expectRefused(
        `INSERT INTO status_reports (feature_type, feature_id, is_open, valid_from, valid_until, change_set_id)
         VALUES ('edge', gen_random_uuid(), false, now(), now() + interval '1 hour', $1)`,
        [id],
        frozen,
      );
    }));

  test("a pending change set's reports can be edited and deleted", () =>
    db.rolledBack(async () => {
      const id = await pendingChangeSet(db, CONTRIBUTOR.trusted, "status");
      const reportId = await statusReport(db, id);
      await db.query("UPDATE status_reports SET note = 'lift 3 under repair' WHERE id = $1", [
        reportId,
      ]);
      await db.query("DELETE FROM status_reports WHERE id = $1", [reportId]);
    }));
});

describe("rejected and rolled_back are final", () => {
  test("a rejected change set cannot be reopened", () =>
    db.rolledBack(async () => {
      const id = await pendingChangeSet(db, CONTRIBUTOR.newcomer, "structural");
      await db.query("UPDATE change_sets SET decision = 'rejected' WHERE id = $1", [id]);
      await db.expectRefused(
        "UPDATE change_sets SET decision = 'pending' WHERE id = $1",
        [id],
        refusedBecause(/rejected is final/),
      );
    }));

  test("a rolled-back change set cannot be approved again", () =>
    db.rolledBack(async () => {
      const id = await pendingChangeSet(db, CONTRIBUTOR.newcomer, "structural");
      await recordGates(db, id, "gates_passed");
      await publish(db, id, "moderator_review", CONTRIBUTOR.moderator);
      await db.query("UPDATE change_sets SET decision = 'rolled_back' WHERE id = $1", [id]);
      await db.expectRefused(
        "UPDATE change_sets SET decision = 'approved' WHERE id = $1",
        [id],
        refusedBecause(/rolled_back is final/),
      );
    }));

  test("rolling back still works after the reviewer has been demoted", () =>
    db.rolledBack(async () => {
      const id = await pendingChangeSet(db, CONTRIBUTOR.newcomer, "structural");
      await recordGates(db, id, "gates_passed");
      await publish(db, id, "moderator_review", CONTRIBUTOR.moderator);
      await db.query("UPDATE contributors SET trust_tier = 'new' WHERE id = $1", [
        CONTRIBUTOR.moderator,
      ]);
      await db.query("UPDATE change_sets SET decision = 'rolled_back' WHERE id = $1", [id]);
    }));
});
