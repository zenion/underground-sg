// Levels, ordinals and vertical connectors.

import { describe, expect, test } from "vitest";
import { AT, LEVEL, NODE, point, seedCluster, VENUE } from "./fixtures.ts";
import { SQLSTATE, useDatabase } from "./harness.ts";

const db = useDatabase(seedCluster);

const MISSING_LEVEL = "20000000-0000-0000-0000-0000000000ff";

async function nodeOrdinal(id: string): Promise<number> {
  return db.value<number>("SELECT ordinal FROM nodes WHERE id = $1", [id]);
}

async function anchorOrdinal(id: string): Promise<number> {
  return db.value<number>("SELECT ordinal FROM anchors WHERE id = $1", [id]);
}

async function insertAnchor(levelId: string | null, ordinal: number): Promise<string> {
  return db.value<string>(
    `INSERT INTO anchors (kind, name, level_id, ordinal, facing_deg)
     VALUES ('floor_point', 'Funan B2 link door', $1, $2, 90) RETURNING id`,
    [levelId, ordinal],
  );
}

describe("nodes.ordinal stays in step with levels.ordinal", () => {
  test("a node takes its level's band, whatever ordinal it was given", () =>
    db.rolledBack(async () => {
      expect(await nodeOrdinal(NODE.funanB2Escalator)).toBe(-2);
      const id = await db.value<string>(
        "INSERT INTO nodes (level_id, ordinal, kind, geom) VALUES ($1, 7, 'door', $2::geometry) RETURNING id",
        [LEVEL.funanB1M, point(AT.funanB1Escalator)],
      );
      expect(await nodeOrdinal(id)).toBe(-1);
    }));

  test("setting a node's ordinal directly is overridden by its level's band", () =>
    db.rolledBack(async () => {
      await db.query("UPDATE nodes SET ordinal = 3 WHERE id = $1", [NODE.funanB2Escalator]);
      expect(await nodeOrdinal(NODE.funanB2Escalator)).toBe(-2);
    }));

  test("a node without a level is in the street band (0)", () =>
    db.rolledBack(async () => {
      expect(await nodeOrdinal(NODE.northBridgeRoadExit)).toBe(0);
      await db.query("UPDATE nodes SET ordinal = -1 WHERE id = $1", [NODE.northBridgeRoadExit]);
      expect(await nodeOrdinal(NODE.northBridgeRoadExit)).toBe(0);
    }));

  test("a node on a level that does not exist is refused", () =>
    db.rolledBack(() =>
      db.expectRefused(
        "INSERT INTO nodes (level_id, kind, geom) VALUES ($1, 'door', $2::geometry)",
        [MISSING_LEVEL, point(AT.funanB2Escalator)],
        { code: SQLSTATE.foreignKeyViolation, message: /^nodes .*: level .* does not exist$/ },
      ),
    ));

  test("moving a level to another band moves its nodes, and only its nodes", () =>
    db.rolledBack(async () => {
      await db.query("UPDATE levels SET ordinal = -3 WHERE id = $1", [LEVEL.funanB2]);
      expect(await nodeOrdinal(NODE.funanB2Escalator)).toBe(-3);
      expect(await nodeOrdinal(NODE.funanB1Escalator)).toBe(-1);
    }));
});

describe("anchors.ordinal stays in step with levels.ordinal", () => {
  test("an anchor takes its level's band, and follows it", () =>
    db.rolledBack(async () => {
      const id = await insertAnchor(LEVEL.funanB2, 0);
      expect(await anchorOrdinal(id)).toBe(-2);
      await db.query("UPDATE levels SET ordinal = -3 WHERE id = $1", [LEVEL.funanB2]);
      expect(await anchorOrdinal(id)).toBe(-3);
      await db.query("UPDATE anchors SET ordinal = 5 WHERE id = $1", [id]);
      expect(await anchorOrdinal(id)).toBe(-3);
    }));

  test("a street anchor (no level) is in the street band (0)", () =>
    db.rolledBack(async () => {
      const id = await db.value<string>(
        `INSERT INTO anchors (kind, name, ordinal, surveyed_geom, prior_source, prior_sigma_m)
         VALUES ('floor_point', 'City Hall exit A', 4, $1::geometry, 'lta_exit', 2) RETURNING id`,
        [point(AT.cityHallExitA)],
      );
      expect(await anchorOrdinal(id)).toBe(0);
    }));

  test("an anchor on a level that does not exist is refused", () =>
    db.rolledBack(() =>
      db.expectRefused(
        `INSERT INTO anchors (kind, name, level_id, ordinal) VALUES ('floor_point', 'x', $1, 0)`,
        [MISSING_LEVEL],
        { code: SQLSTATE.foreignKeyViolation, message: /^anchors .*: level .* does not exist$/ },
      ),
    ));
});

describe("UNIQUE (venue_id, name)", () => {
  test("two levels of one venue may share a band", async () => {
    const rows = await db.query<{ name: string }>(
      "SELECT name FROM levels WHERE venue_id = $1 AND ordinal = -1 ORDER BY sort_key",
      [VENUE.funan],
    );
    expect(rows.map((row) => row.name)).toEqual(["B1", "B1M"]);
  });

  test("two venues may each have a level with the same name", () =>
    db.rolledBack(async () => {
      await db.query("INSERT INTO levels (venue_id, ordinal, name) VALUES ($1, -2, 'B2')", [
        VENUE.rafflesCity,
      ]);
    }));

  test("a second level with the same name in one venue is refused", () =>
    db.rolledBack(() =>
      db.expectRefused(
        "INSERT INTO levels (venue_id, ordinal, name) VALUES ($1, -3, 'B2')",
        [VENUE.funan],
        { code: SQLSTATE.uniqueViolation, constraint: "levels_venue_id_name_key" },
      ),
    ));
});

describe("stairs and escalators are never step_free", () => {
  const insertEdge = `INSERT INTO edges (from_node, to_node, kind, oneway, connector_id, length_m,
                                         step_free, sheltered, outdoor)
                      VALUES ($1, $2, $3, $4, gen_random_uuid(), 12, $5, true, false)`;

  test.each(["escalator", "stairs"])("a step-free %s is refused", (kind) =>
    db.rolledBack(() =>
      db.expectRefused(
        insertEdge,
        [NODE.funanB2Escalator, NODE.funanB1Escalator, kind, kind === "escalator", true],
        { code: SQLSTATE.checkViolation, constraint: "edges_check1" },
      ),
    ),
  );

  test.each([
    ["escalator", false],
    ["stairs", false],
    ["lift", true],
    ["ramp", true],
  ] as const)("a %s with step_free = %s is accepted", (kind, stepFree) =>
    db.rolledBack(async () => {
      await db.query(insertEdge, [
        NODE.funanB2Escalator,
        NODE.funanB1Escalator,
        kind,
        kind === "escalator",
        stepFree,
      ]);
    }),
  );
});
