// Status change sets have no diff and no version, and only they carry status reports.

import { describe, test } from "vitest";
import {
  CONTRIBUTOR,
  NODE,
  newVersion,
  pendingChangeSet,
  publish,
  publishStatement,
  recordGates,
  seedCluster,
  statusReport,
} from "./fixtures.ts";
import { SQLSTATE, useDatabase } from "./harness.ts";

const db = useDatabase(seedCluster);

const insertReport = `INSERT INTO status_reports (feature_type, feature_id, is_open, valid_from, valid_until, change_set_id)
                      VALUES ($1, $2, false, now(), now() + $3::interval, $4)`;

describe("status change sets", () => {
  test("an empty diff is accepted; any diff is refused", () =>
    db.rolledBack(async () => {
      await pendingChangeSet(db, CONTRIBUTOR.trusted, "status", "[]");
      await db.expectRefused(
        "INSERT INTO change_sets (contributor_id, track, diff) VALUES ($1, 'status', $2::jsonb)",
        [CONTRIBUTOR.trusted, '[{"op":"update"}]'],
        { code: SQLSTATE.checkViolation, constraint: "change_sets_status_has_no_diff" },
      );
      await pendingChangeSet(db, CONTRIBUTOR.trusted, "structural", '[{"op":"update"}]');
    }));

  test("it publishes without a version; publishing it with one is refused", () =>
    db.rolledBack(async () => {
      const id = await pendingChangeSet(db, CONTRIBUTOR.trusted, "status");
      await statusReport(db, id);
      await recordGates(db, id, "gates_passed");
      const [sql, params] = publishStatement(id, "trusted_status_auto", {
        version: await newVersion(db),
      });
      await db.expectRefused(sql, params, {
        code: SQLSTATE.checkViolation,
        constraint: "change_sets_version_iff_published",
      });
      await publish(db, id, "trusted_status_auto");
    }));

  test("a pending status change set with a version is refused", () =>
    db.rolledBack(async () => {
      const id = await pendingChangeSet(db, CONTRIBUTOR.trusted, "status");
      await db.expectRefused(
        "UPDATE change_sets SET map_version_id = $2 WHERE id = $1",
        [id, await newVersion(db)],
        { code: SQLSTATE.checkViolation, constraint: "change_sets_version_iff_published" },
      );
    }));
});

describe("status reports", () => {
  test("a report on a status change set is accepted; on a structural one it is refused", () =>
    db.rolledBack(async () => {
      const status = await pendingChangeSet(db, CONTRIBUTOR.trusted, "status");
      const structural = await pendingChangeSet(db, CONTRIBUTOR.trusted, "structural");
      await db.query(insertReport, ["node", NODE.northBridgeRoadExit, "1 hour", status]);
      await db.expectRefused(
        insertReport,
        ["node", NODE.northBridgeRoadExit, "1 hour", structural],
        {
          code: SQLSTATE.foreignKeyViolation,
          constraint: "status_reports_change_set_id_track_fkey",
        },
      );
    }));

  test("a report that claims the structural track, to match a structural change set, is refused", () =>
    db.rolledBack(async () => {
      const structural = await pendingChangeSet(db, CONTRIBUTOR.trusted, "structural");
      // The (change_set_id, track) key alone would accept this row; the CHECK on track refuses it.
      await db.expectRefused(
        `INSERT INTO status_reports (feature_type, feature_id, is_open, valid_from, valid_until,
                                     change_set_id, track)
         VALUES ('node', $1, false, now(), now() + interval '1 hour', $2, 'structural')`,
        [NODE.northBridgeRoadExit, structural],
        { code: SQLSTATE.checkViolation, constraint: "status_reports_track_check" },
      );
    }));

  test("a report on an edge is accepted; on a space it is refused", () =>
    db.rolledBack(async () => {
      const id = await pendingChangeSet(db, CONTRIBUTOR.trusted, "status");
      await db.query(insertReport, ["edge", NODE.northBridgeRoadExit, "1 hour", id]);
      await db.expectRefused(insertReport, ["space", NODE.northBridgeRoadExit, "1 hour", id], {
        code: SQLSTATE.checkViolation,
        constraint: "status_reports_feature_type_check",
      });
    }));

  test("a report that ends before it starts is refused", () =>
    db.rolledBack(async () => {
      const id = await pendingChangeSet(db, CONTRIBUTOR.trusted, "status");
      await db.expectRefused(insertReport, ["node", NODE.northBridgeRoadExit, "-1 hour", id], {
        code: SQLSTATE.checkViolation,
        constraint: "status_reports_check",
      });
    }));
});
