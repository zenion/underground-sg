// No publish path without a gates_passed event that no later gates_failed overrides, or while
// a linked capture has failed, is not ready or is privacy-flagged: on every path. Each case
// that hinges on the events or captures also has a decoy change set in the transaction, so
// the rule must read the change set being published and no other.

import { describe, expect, test } from "vitest";
import {
  CONTRIBUTOR,
  capture,
  decoyChangeSet,
  link,
  type PublishPath,
  pendingChangeSet,
  publish,
  publishStatement,
  recordGates,
  seedCluster,
  statusReport,
  type Track,
} from "./fixtures.ts";
import { SQLSTATE, useDatabase } from "./harness.ts";

const db = useDatabase(seedCluster);

/** Each path with a change set that is otherwise eligible for it. */
const PATHS: { path: PublishPath; contributor: string; track: Track; reviewer: string | null }[] = [
  { path: "owner_mapper", contributor: CONTRIBUTOR.owner, track: "structural", reviewer: null },
  {
    path: "moderator_review",
    contributor: CONTRIBUTOR.newcomer,
    track: "structural",
    reviewer: CONTRIBUTOR.moderator,
  },
  {
    path: "trusted_status_auto",
    contributor: CONTRIBUTOR.trusted,
    track: "status",
    reviewer: null,
  },
];

const GATES_NOT_PASSED = {
  code: SQLSTATE.checkViolation,
  message: /the automated gates have not passed/,
};
const CAPTURE_BLOCKS = {
  code: SQLSTATE.checkViolation,
  message: /a linked capture failed or is privacy-flagged/,
};

describe.each(PATHS)("$path", ({ path, contributor, track, reviewer }) => {
  async function changeSet(): Promise<string> {
    const id = await pendingChangeSet(db, contributor, track);
    if (track === "status") await statusReport(db, id);
    return id;
  }

  async function expectPublishRefused(id: string, refusal: typeof GATES_NOT_PASSED): Promise<void> {
    const version =
      track === "structural"
        ? await db.value<number>(
            `INSERT INTO map_versions (snapshot_uri, snapshot_sha256, private_export_uri)
             VALUES ('v/x', 'x', 'p/x') RETURNING id`,
          )
        : null;
    const [sql, params] = publishStatement(id, path, { reviewer, version });
    await db.expectRefused(sql, params, refusal);
  }

  test("publishing with no gates result is refused, though another change set's passed", () =>
    db.rolledBack(async () => {
      const id = await changeSet();
      await decoyChangeSet(db, { gates: "gates_passed" });
      await expectPublishRefused(id, GATES_NOT_PASSED);
    }));

  test("a gates_failed after gates_passed is refused; a later gates_passed publishes", () =>
    db.rolledBack(async () => {
      const id = await changeSet();
      await recordGates(db, id, "gates_passed");
      await recordGates(db, id, "gates_failed");
      await expectPublishRefused(id, GATES_NOT_PASSED);
      await recordGates(db, id, "gates_passed");
      // Another change set's later gates_failed and flagged capture are not this one's.
      await decoyChangeSet(db, { gates: "gates_failed", capture: { privacyFlagged: true } });
      await publish(db, id, path, reviewer);
    }));

  test("gates_failed alone is refused, though another change set's gates passed later", () =>
    db.rolledBack(async () => {
      const id = await changeSet();
      await recordGates(db, id, "gates_failed");
      await decoyChangeSet(db, { gates: "gates_passed" });
      await expectPublishRefused(id, GATES_NOT_PASSED);
    }));

  test.each([
    ["privacy-flagged", { privacyFlagged: true }],
    ["failed", { status: "failed" }],
    ["still processing", { status: "processing" }],
  ] as const)("a %s capture blocks publishing", (_what, captureOptions) =>
    db.rolledBack(async () => {
      const id = await changeSet();
      await link(db, id, await capture(db));
      await link(db, id, await capture(db, captureOptions));
      await recordGates(db, id, "gates_passed");
      await expectPublishRefused(id, CAPTURE_BLOCKS);
    }),
  );

  test("clearing a privacy flag (recorded) unblocks publishing", () =>
    db.rolledBack(async () => {
      const id = await changeSet();
      const flagged = await capture(db, { privacyFlagged: true });
      await link(db, id, flagged);
      await recordGates(db, id, "gates_passed");
      await expectPublishRefused(id, CAPTURE_BLOCKS);
      await db.query("UPDATE captures SET privacy_flagged = false WHERE id = $1", [flagged]);
      await db.query(
        "INSERT INTO moderation_events (change_set_id, actor_id, action) VALUES ($1, $2, 'privacy_flag_cleared')",
        [id, CONTRIBUTOR.owner],
      );
      await publish(db, id, path, reviewer);
    }));

  test("approved and ready_for_review captures publish, whatever another change set holds", () =>
    db.rolledBack(async () => {
      const id = await changeSet();
      await link(db, id, await capture(db, { status: "ready_for_review" }));
      await link(db, id, await capture(db, { status: "approved" }));
      await recordGates(db, id, "gates_passed");
      await decoyChangeSet(db, { gates: "gates_failed", capture: { privacyFlagged: true } });
      await decoyChangeSet(db, { capture: { status: "failed" } });
      await publish(db, id, path, reviewer);
      expect(
        await db.value<string>("SELECT publish_path FROM change_sets WHERE id = $1", [id]),
      ).toBe(path);
    }));
});

test("a change set inserted already published is refused: the gates need its id first", () =>
  db.rolledBack(() =>
    db.expectRefused(
      `INSERT INTO change_sets (contributor_id, track, diff, decision, publish_path)
       VALUES ($1, 'status', '[]', 'auto_published', 'trusted_status_auto')`,
      [CONTRIBUTOR.trusted],
      GATES_NOT_PASSED,
    ),
  ));
