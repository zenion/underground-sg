// Who may publish through each path, and how decision and publish_path agree. Every case
// records gates_passed first, so only the rule under test can refuse it.

import { describe, test } from "vitest";
import {
  CONTRIBUTOR,
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

const refusedBecause = (message: RegExp) => ({ code: SQLSTATE.checkViolation, message });

/** A pending change set whose gates passed. */
async function gated(contributor: string, track: Track): Promise<string> {
  const id = await pendingChangeSet(db, contributor, track);
  await recordGates(db, id, "gates_passed");
  if (track === "status") await statusReport(db, id);
  return id;
}

/** Expects publishing to be refused; the version is a placeholder for structural sets. */
async function expectPublishRefused(
  changeSet: string,
  path: PublishPath,
  reviewer: string | null,
  message: RegExp,
): Promise<void> {
  const track = await db.value<Track>("SELECT track FROM change_sets WHERE id = $1", [changeSet]);
  const version =
    track === "structural"
      ? await db.value<number>(
          `INSERT INTO map_versions (snapshot_uri, snapshot_sha256, private_export_uri)
           VALUES ('v/x', 'x', 'p/x') RETURNING id`,
        )
      : null;
  const [sql, params] = publishStatement(changeSet, path, { reviewer, version });
  await db.expectRefused(sql, params, refusedBecause(message));
}

describe("owner_mapper", () => {
  test("the owner's structural change set publishes", () =>
    db.rolledBack(async () => {
      await publish(db, await gated(CONTRIBUTOR.owner, "structural"), "owner_mapper");
    }));

  test.each([
    ["a newcomer", CONTRIBUTOR.newcomer],
    ["a trusted contributor", CONTRIBUTOR.trusted],
    ["a moderator", CONTRIBUTOR.moderator],
  ])("is refused for %s", (_who, contributor) =>
    db.rolledBack(async () => {
      await expectPublishRefused(
        await gated(contributor, "structural"),
        "owner_mapper",
        null,
        /owner_mapper needs a contributor with tier owner/,
      );
    }),
  );

  test("is refused for a status change set, even the owner's", () =>
    db.rolledBack(async () => {
      await expectPublishRefused(
        await gated(CONTRIBUTOR.owner, "status"),
        "owner_mapper",
        null,
        /owner_mapper is for structural change sets only/,
      );
    }));
});

describe("trusted_status_auto", () => {
  test.each([
    ["a trusted contributor", CONTRIBUTOR.trusted],
    ["a moderator", CONTRIBUTOR.moderator],
    ["the owner", CONTRIBUTOR.owner],
  ])("publishes a status edit by %s", (_who, contributor) =>
    db.rolledBack(async () => {
      await publish(db, await gated(contributor, "status"), "trusted_status_auto");
    }),
  );

  test("is refused for a newcomer", () =>
    db.rolledBack(async () => {
      await expectPublishRefused(
        await gated(CONTRIBUTOR.newcomer, "status"),
        "trusted_status_auto",
        null,
        /trusted_status_auto needs tier trusted, moderator or owner/,
      );
    }));

  test("is refused for a structural change set", () =>
    db.rolledBack(async () => {
      await expectPublishRefused(
        await gated(CONTRIBUTOR.trusted, "structural"),
        "trusted_status_auto",
        null,
        /trusted_status_auto is for status edits only/,
      );
    }));

  test("is refused while a report has no valid_until; accepted once it has one", () =>
    db.rolledBack(async () => {
      const id = await pendingChangeSet(db, CONTRIBUTOR.trusted, "status");
      await recordGates(db, id, "gates_passed");
      await statusReport(db, id, "4 hours");
      const openEnded = await statusReport(db, id, null);
      await expectPublishRefused(
        id,
        "trusted_status_auto",
        null,
        /reports published through trusted_status_auto need valid_until/,
      );
      await db.query(
        "UPDATE status_reports SET valid_until = now() + interval '1 hour' WHERE id = $1",
        [openEnded],
      );
      // Another change set's open-ended report is not this one's.
      await statusReport(db, await pendingChangeSet(db, CONTRIBUTOR.trusted, "status"), null);
      await publish(db, id, "trusted_status_auto");
    }));

  test("an open-ended report can still publish through moderator_review", () =>
    db.rolledBack(async () => {
      const id = await pendingChangeSet(db, CONTRIBUTOR.trusted, "status");
      await recordGates(db, id, "gates_passed");
      await statusReport(db, id, null);
      await publish(db, id, "moderator_review", CONTRIBUTOR.moderator);
    }));
});

describe("moderator_review", () => {
  test.each([
    ["a moderator", CONTRIBUTOR.moderator],
    ["the owner", CONTRIBUTOR.owner],
  ])("publishes a newcomer's change set reviewed by %s", (_who, reviewer) =>
    db.rolledBack(async () => {
      await publish(
        db,
        await gated(CONTRIBUTOR.newcomer, "structural"),
        "moderator_review",
        reviewer,
      );
    }),
  );

  test("a moderator's own change set publishes when another moderator reviews it", () =>
    db.rolledBack(async () => {
      await publish(
        db,
        await gated(CONTRIBUTOR.moderator, "structural"),
        "moderator_review",
        CONTRIBUTOR.secondModerator,
      );
    }));

  test("is refused when the reviewer is the contributor", () =>
    db.rolledBack(async () => {
      await expectPublishRefused(
        await gated(CONTRIBUTOR.moderator, "structural"),
        "moderator_review",
        CONTRIBUTOR.moderator,
        /moderator_review needs a reviewer other than the contributor/,
      );
    }));

  test("is refused without a reviewer", () =>
    db.rolledBack(async () => {
      await expectPublishRefused(
        await gated(CONTRIBUTOR.newcomer, "structural"),
        "moderator_review",
        null,
        /moderator_review needs a reviewer other than the contributor/,
      );
    }));

  test.each([
    ["a trusted contributor", CONTRIBUTOR.trusted],
    ["a newcomer", CONTRIBUTOR.newcomer],
  ])("is refused when the reviewer is %s", (_who, reviewer) =>
    db.rolledBack(async () => {
      await expectPublishRefused(
        await gated(CONTRIBUTOR.owner, "structural"),
        "moderator_review",
        reviewer,
        /reviewer needs tier moderator or owner/,
      );
    }),
  );
});

describe("decision and publish_path agree", () => {
  const disagree = {
    code: SQLSTATE.checkViolation,
    constraint: "change_sets_decision_matches_path",
  };

  test("approved goes with moderator_review, auto_published with the other paths", () =>
    db.rolledBack(async () => {
      await publish(
        db,
        await gated(CONTRIBUTOR.newcomer, "structural"),
        "moderator_review",
        CONTRIBUTOR.owner,
      );
      await publish(db, await gated(CONTRIBUTOR.owner, "structural"), "owner_mapper");
      await publish(db, await gated(CONTRIBUTOR.trusted, "status"), "trusted_status_auto");
    }));

  test("approved without a publish path is refused", () =>
    db.rolledBack(async () => {
      const id = await gated(CONTRIBUTOR.trusted, "status");
      await db.expectRefused(
        "UPDATE change_sets SET decision = 'approved' WHERE id = $1",
        [id],
        disagree,
      );
    }));

  test("auto_published through moderator_review is refused", () =>
    db.rolledBack(async () => {
      const id = await gated(CONTRIBUTOR.trusted, "status");
      await db.expectRefused(
        `UPDATE change_sets SET decision = 'auto_published', publish_path = 'moderator_review',
                                reviewer_id = $2 WHERE id = $1`,
        [id, CONTRIBUTOR.moderator],
        disagree,
      );
    }));

  test("approved through owner_mapper is refused", () =>
    db.rolledBack(async () => {
      const id = await gated(CONTRIBUTOR.owner, "structural");
      const version = await db.value<number>(
        `INSERT INTO map_versions (snapshot_uri, snapshot_sha256, private_export_uri)
         VALUES ('v/x', 'x', 'p/x') RETURNING id`,
      );
      await db.expectRefused(
        `UPDATE change_sets SET decision = 'approved', publish_path = 'owner_mapper',
                                map_version_id = $2 WHERE id = $1`,
        [id, version],
        disagree,
      );
    }));

  test("rolled_back on a published change set is accepted; on one never published it is refused", () =>
    db.rolledBack(async () => {
      // Status change sets: for them no version rule backs this one up.
      const published = await gated(CONTRIBUTOR.trusted, "status");
      await publish(db, published, "trusted_status_auto");
      const rollBack = "UPDATE change_sets SET decision = 'rolled_back' WHERE id = $1";
      await db.query(rollBack, [published]);
      await db.expectRefused(rollBack, [await gated(CONTRIBUTOR.trusted, "status")], disagree);
    }));

  test("a publish path on a change set that is still pending is refused", () =>
    db.rolledBack(async () => {
      const id = await gated(CONTRIBUTOR.trusted, "status");
      await db.expectRefused(
        "UPDATE change_sets SET publish_path = 'trusted_status_auto' WHERE id = $1",
        [id],
        disagree,
      );
    }));

  test("a published change set's publish path cannot change afterwards", () =>
    db.rolledBack(async () => {
      const id = await gated(CONTRIBUTOR.owner, "status");
      await publish(db, id, "trusted_status_auto");
      await db.expectRefused(
        "UPDATE change_sets SET decision = 'approved', publish_path = 'moderator_review', reviewer_id = $2 WHERE id = $1",
        [id, CONTRIBUTOR.moderator],
        refusedBecause(/publish_path cannot change once set/),
      );
    }));
});
