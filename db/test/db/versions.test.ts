// Map versions: a structural change set has a version exactly when it is published, every
// version except a rollback publishes a change set (a deferred rule, so these tests commit),
// map_versions and moderation_events are write-once, and map_head only moves forward.

import { describe, expect, test } from "vitest";
import {
  CONTRIBUTOR,
  newVersion,
  pendingChangeSet,
  publish,
  publishStatement,
  recordGates,
  seedCluster,
} from "./fixtures.ts";
import { SQLSTATE, useDatabase } from "./harness.ts";

const db = useDatabase(seedCluster);

/** The owner's structural change set with its gates passed. */
async function gatedOwnerChangeSet(): Promise<string> {
  const id = await pendingChangeSet(db, CONTRIBUTOR.owner, "structural", '[{"op":"add"}]');
  await recordGates(db, id, "gates_passed");
  return id;
}

describe("a structural change set has a version exactly when it is published", () => {
  const versionMismatch = {
    code: SQLSTATE.checkViolation,
    constraint: "change_sets_version_iff_published",
  };

  test("a pending change set with a version is refused", () =>
    db.rolledBack(async () => {
      const id = await gatedOwnerChangeSet();
      await db.expectRefused(
        "UPDATE change_sets SET map_version_id = $2 WHERE id = $1",
        [id, await newVersion(db)],
        versionMismatch,
      );
    }));

  test("publishing without a version is refused; with one it is accepted", () =>
    db.rolledBack(async () => {
      const id = await pendingChangeSet(db, CONTRIBUTOR.newcomer, "structural");
      await recordGates(db, id, "gates_passed");
      const [sql, params] = publishStatement(id, "moderator_review", {
        reviewer: CONTRIBUTOR.moderator,
      });
      await db.expectRefused(sql, params, versionMismatch);
      await publish(db, id, "moderator_review", CONTRIBUTOR.moderator);
    }));

  test("a rolled-back change set keeps its version", () =>
    db.rolledBack(async () => {
      const id = await gatedOwnerChangeSet();
      const version = await publish(db, id, "owner_mapper");
      await db.query("UPDATE change_sets SET decision = 'rolled_back' WHERE id = $1", [id]);
      expect(await db.value("SELECT map_version_id FROM change_sets WHERE id = $1", [id])).toBe(
        version,
      );
    }));
});

describe("every version except a rollback publishes a change set (checked at COMMIT)", () => {
  test("a version that publishes a change set commits", async () => {
    let version: number | null = null;
    await db.committed(async () => {
      version = await publish(db, await gatedOwnerChangeSet(), "owner_mapper");
    });
    expect(await db.value("SELECT version_id FROM map_head")).toBe(version);
  });

  test("a version that publishes no change set is refused at COMMIT", async () => {
    const before = await db.value<number>("SELECT count(*)::int FROM map_versions");
    await db.expectCommitRefused(
      async () => {
        await newVersion(db);
      },
      { code: SQLSTATE.checkViolation, message: /^map version \d+ publishes no change set$/ },
    );
    expect(await db.value<number>("SELECT count(*)::int FROM map_versions")).toBe(before);
  });

  test("a version whose change set is rolled back before COMMIT is refused", () =>
    db.expectCommitRefused(
      async () => {
        const id = await gatedOwnerChangeSet();
        await publish(db, id, "owner_mapper");
        await db.query("UPDATE change_sets SET decision = 'rolled_back' WHERE id = $1", [id]);
      },
      { code: SQLSTATE.checkViolation, message: /^map version \d+ publishes no change set$/ },
    ));

  test("a rollback version publishes no change set and commits", async () => {
    let earlier = 0;
    await db.committed(async () => {
      earlier = (await publish(db, await gatedOwnerChangeSet(), "owner_mapper")) ?? 0;
    });
    await db.committed(async () => {
      const rollback = await newVersion(db, earlier);
      await db.query("UPDATE map_head SET version_id = $1", [rollback]);
    });
  });
});

describe("map_versions is write-once", () => {
  const writeOnce = (op: string) => ({
    code: SQLSTATE.raiseException,
    message: new RegExp(`^map_versions is write-once: ${op} is not allowed$`),
  });

  test("inserting a version is accepted", () =>
    db.rolledBack(async () => {
      await newVersion(db);
    }));

  test.each([
    ["UPDATE", "UPDATE map_versions SET note = 'edited' WHERE id = $1"],
    ["DELETE", "DELETE FROM map_versions WHERE id = $1"],
  ])("%s is refused", (op, sql) =>
    db.rolledBack(async () => {
      const version = await publish(db, await gatedOwnerChangeSet(), "owner_mapper");
      await db.expectRefused(sql, [version], writeOnce(op));
    }),
  );

  test("TRUNCATE is refused", () =>
    db.rolledBack(async () => {
      // Without CASCADE, PostgreSQL refuses first because other tables reference it.
      await db.expectRefused("TRUNCATE map_versions CASCADE", [], writeOnce("TRUNCATE"));
    }));
});

describe("moderation_events is append-only", () => {
  const writeOnce = (op: string) => ({
    code: SQLSTATE.raiseException,
    message: new RegExp(`^moderation_events is write-once: ${op} is not allowed$`),
  });

  test("appending events is accepted; UPDATE, DELETE and TRUNCATE are refused", () =>
    db.rolledBack(async () => {
      const id = await gatedOwnerChangeSet();
      await recordGates(db, id, "gates_failed");
      await db.expectRefused(
        "UPDATE moderation_events SET action = 'gates_passed' WHERE change_set_id = $1",
        [id],
        writeOnce("UPDATE"),
      );
      await db.expectRefused(
        "DELETE FROM moderation_events WHERE change_set_id = $1",
        [id],
        writeOnce("DELETE"),
      );
      await db.expectRefused("TRUNCATE moderation_events", [], writeOnce("TRUNCATE"));
    }));
});

describe("map_head", () => {
  test("starts as one row and moves forward", () =>
    db.rolledBack(async () => {
      expect(await db.value<number>("SELECT count(*)::int FROM map_head")).toBe(1);
      await publish(db, await gatedOwnerChangeSet(), "owner_mapper");
      const latest = await publish(db, await gatedOwnerChangeSet(), "owner_mapper");
      expect(await db.value("SELECT version_id FROM map_head")).toBe(latest);
    }));

  test.each([
    ["back to an earlier version", "earlier"],
    ["to NULL", "null"],
  ])("moving it %s is refused", (_what, target) =>
    db.rolledBack(async () => {
      const earlier = await publish(db, await gatedOwnerChangeSet(), "owner_mapper");
      await publish(db, await gatedOwnerChangeSet(), "owner_mapper");
      await db.expectRefused(
        "UPDATE map_head SET version_id = $1",
        [target === "null" ? null : earlier],
        { code: SQLSTATE.checkViolation, message: /^map_head only moves forward/ },
      );
    }),
  );

  test.each([
    ["DELETE", "DELETE FROM map_head"],
    ["TRUNCATE", "TRUNCATE map_head"],
  ])("%s is refused", (op, sql) =>
    db.rolledBack(() =>
      db.expectRefused(sql, [], {
        code: SQLSTATE.raiseException,
        message: new RegExp(`^map_head: ${op} is not allowed$`),
      }),
    ),
  );

  test("a second row is refused", () =>
    db.rolledBack(async () => {
      await db.expectRefused("INSERT INTO map_head (id) VALUES (true)", [], {
        code: SQLSTATE.uniqueViolation,
        constraint: "map_head_pkey",
      });
      await db.expectRefused("INSERT INTO map_head (id) VALUES (false)", [], {
        code: SQLSTATE.checkViolation,
        constraint: "map_head_id_check",
      });
    }));
});
