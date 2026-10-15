// Applying a diff to HEAD (src/publish/apply.ts) against PostGIS, on the synthetic City Hall HEAD:
// the order and the rev bumps, what the database's triggers fill in, each reason the rebase check
// sends a change set to needs_rebase without applying anything, and what the savepoint catches
// (an entry or a change set the database refuses, a new overlap of a restricted zone). Every test runs in a
// transaction that is rolled back, so HEAD stays as the fixture left it.

import type { ChangeSetDiff, DiffEntry } from "@usg/contracts";
import { CONTRIBUTOR } from "@usg/db/test/fixtures";
import { useDatabase } from "@usg/db/test/harness";
import { type Kysely, sql } from "kysely";
import { describe, expect, test } from "vitest";
import type { Database } from "../../src/database.ts";
import {
  applyChangeSet,
  applyDiff,
  applyOrder,
  type ChangeSetToApply,
  rebaseReasons,
} from "../../src/publish/apply.ts";
import {
  EDGE,
  LEVEL,
  NODE,
  POI,
  PRIVATE,
  SPACE,
  seedCityHall,
  VENUE,
} from "../fixtures/city-hall.ts";
import { headRow } from "./head.ts";
import { useKysely } from "./helpers.ts";

const db = useDatabase(async (d) => {
  await seedCityHall(d);
  await d.query(
    "INSERT INTO contributors (id, display_name, trust_tier) VALUES ($1, 'Owner', 'owner')",
    [CONTRIBUTOR.owner],
  );
});
const kysely = useKysely(db);

class Rollback extends Error {}

/** Runs `fn` in a transaction and rolls it back. */
async function rolledBack(fn: (trx: Kysely<Database>) => Promise<void>): Promise<void> {
  await kysely()
    .transaction()
    .execute(async (trx) => {
      await fn(trx);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
}

const NEW_NODE = "c0000000-0000-4000-8000-000000000001";
const NEW_EDGE = "c0000000-0000-4000-8000-000000000002";
const NEW_SPACE = "c0000000-0000-4000-8000-000000000003";

const changeSet = (diff: unknown, base: number | null = null): ChangeSetToApply => ({
  id: "c0000000-0000-4000-8000-0000000000ff",
  track: "structural",
  base_version_id: base,
  diff,
});

const newNode = (id = NEW_NODE): DiffEntry => ({
  op: "add",
  feature_type: "node",
  id,
  base_rev: null,
  before: null,
  after: {
    level_id: LEVEL.rafflesCityB1,
    kind: "junction",
    name: null,
    street_name: null,
    connector_id: null,
    elevation_m: null,
    geom: { type: "Point", coordinates: [103.8527, 1.2937] },
  },
});

const newEdge = (to: string): DiffEntry => ({
  op: "add",
  feature_type: "edge",
  id: NEW_EDGE,
  base_rev: null,
  before: null,
  after: {
    from_node: NODE.rafflesCityDoor,
    to_node: to,
    kind: "walk",
    oneway: false,
    access: "public",
    opening_hours: null,
    level_id: LEVEL.rafflesCityB1,
    connector_id: null,
    length_m: 23.4,
    step_free: true,
    sheltered: true,
    outdoor: false,
    geom: null,
  },
});

describe("applyOrder", () => {
  test("adds and modifies parents first, then removes children first", () => {
    const entry = (op: DiffEntry["op"], feature_type: DiffEntry["feature_type"], id: string) =>
      ({ op, feature_type, id }) as DiffEntry;
    const order = applyOrder([
      entry("remove", "space", "3"),
      entry("add", "edge", "2"),
      entry("remove", "poi", "4"),
      entry("modify", "level", "1"),
      entry("add", "node", "5"),
      entry("remove", "node", "6"),
      entry("add", "edge", "1"),
    ] as ChangeSetDiff);
    expect(order.map((e) => `${e.op} ${e.feature_type} ${e.id}`)).toEqual([
      "modify level 1",
      "add node 5",
      "add edge 1",
      "add edge 2",
      "remove poi 4",
      "remove node 6",
      "remove space 3",
    ]);
  });
});

describe("applying a diff", () => {
  test("adds at rev 1, modifies at base_rev + 1, removes; triggers set ordinals", () =>
    rolledBack(async (trx) => {
      const venue = await headRow(trx, "venues", VENUE.funan);
      const level = await headRow(trx, "levels", LEVEL.rafflesCityB1);
      const atm = await headRow(trx, "pois", POI.cityHallAtm);
      const food = await headRow(trx, "pois", POI.rafflesCityFood);
      const diff: ChangeSetDiff = [
        {
          op: "remove",
          feature_type: "poi",
          id: POI.rafflesCityFood,
          base_rev: food.rev,
          before: food.row,
          after: null,
        },
        newEdge(NEW_NODE),
        newNode(),
        {
          op: "modify",
          feature_type: "poi",
          id: POI.cityHallAtm,
          base_rev: atm.rev,
          before: atm.row,
          after: { ...atm.row, geom: { type: "Point", coordinates: [103.85165, 1.29275] } },
        },
        {
          op: "modify",
          feature_type: "level",
          id: LEVEL.rafflesCityB1,
          base_rev: level.rev,
          before: level.row,
          after: { ...level.row, elevation_m: -5.2 },
        },
        {
          op: "modify",
          feature_type: "venue",
          id: VENUE.funan,
          base_rev: venue.rev,
          before: venue.row,
          after: { ...venue.row, name: "Funan (renamed)" },
        },
      ];
      expect(await rebaseReasons(trx, changeSet(diff))).toEqual([]);
      expect(await applyDiff(trx, diff)).toEqual({ added: 2, modified: 3, removed: 1 });

      const venueRow = await trx
        .selectFrom("venues")
        .select(["name", "permission", "operator", "rev"])
        .where("id", "=", VENUE.funan)
        .executeTakeFirstOrThrow();
      // permission is the seed script's: a venue modify never writes it.
      expect(venueRow).toEqual({
        name: "Funan (renamed)",
        permission: PRIVATE.permission,
        operator: PRIVATE.operator,
        rev: 2,
      });
      expect(
        await trx
          .selectFrom("levels")
          .select(["elevation_m", "rev"])
          .where("id", "=", LEVEL.rafflesCityB1)
          .executeTakeFirstOrThrow(),
      ).toEqual({ elevation_m: -5.2, rev: 2 });
      expect(
        await trx
          .selectFrom("nodes")
          .select(["ordinal", "rev", sql<string>`ST_AsGeoJSON(geom, 7)`.as("geom")])
          .where("id", "=", NEW_NODE)
          .executeTakeFirstOrThrow(),
      ).toEqual({ ordinal: -1, rev: 1, geom: '{"type":"Point","coordinates":[103.8527,1.2937]}' });
      expect(
        await trx
          .selectFrom("pois")
          .select([
            "rev",
            sql<string>`ST_AsGeoJSON(geom, 7)`.as("geom"),
            sql<number>`ST_SRID(geom)`.as("srid"),
          ])
          .where("id", "=", POI.cityHallAtm)
          .executeTakeFirstOrThrow(),
      ).toEqual({ rev: 2, geom: '{"type":"Point","coordinates":[103.85165,1.29275]}', srid: 4326 });
      expect(
        await trx.selectFrom("pois").select("id").where("id", "=", POI.rafflesCityFood).execute(),
      ).toEqual([]);
      expect(
        await trx
          .selectFrom("edges")
          .select(["rev", "length_m"])
          .where("id", "=", NEW_EDGE)
          .execute(),
      ).toEqual([{ rev: 1, length_m: 23.4 }]);
    }));

  test("removes a node with the edge and anchor that use it, when the diff takes them along", () =>
    rolledBack(async (trx) => {
      const node = await headRow(trx, "nodes", NODE.northBridgeRoadExit);
      const edge = await headRow(trx, "edges", EDGE.exitBStairs);
      const anchor = await headRow(trx, "anchors", PRIVATE.anchorId);
      const diff: ChangeSetDiff = [
        {
          op: "remove",
          feature_type: "node",
          id: node.id,
          base_rev: 1,
          before: node.row,
          after: null,
        },
        {
          op: "remove",
          feature_type: "edge",
          id: edge.id,
          base_rev: 1,
          before: edge.row,
          after: null,
        },
        {
          op: "modify",
          feature_type: "anchor",
          id: anchor.id,
          base_rev: 1,
          before: anchor.row,
          after: { ...anchor.row, node_id: null },
        },
      ];
      const outcome = await applyChangeSet(trx, changeSet(diff));
      expect(outcome).toEqual({
        decision: "applied",
        counts: { added: 0, modified: 1, removed: 2 },
      });
      expect(
        await trx
          .selectFrom("anchors")
          .select(["node_id", "rev"])
          .where("id", "=", PRIVATE.anchorId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ node_id: null, rev: 2 });
    }));
});

describe("the rebase check", () => {
  test("a stale rev, a row that is gone and an id HEAD already has", () =>
    rolledBack(async (trx) => {
      const atm = await headRow(trx, "pois", POI.cityHallAtm);
      const toilet = await headRow(trx, "spaces", SPACE.funanB2Toilet);
      const diff: ChangeSetDiff = [
        {
          op: "modify",
          feature_type: "poi",
          id: POI.cityHallAtm,
          base_rev: 2,
          before: atm.row,
          after: { ...atm.row, name: "ATM (B)" },
        },
        {
          op: "remove",
          feature_type: "space",
          id: NEW_SPACE,
          base_rev: 1,
          before: toilet.row,
          after: null,
        },
        { ...newNode(NODE.funanB2Junction) },
      ];
      expect(await rebaseReasons(trx, changeSet(diff))).toEqual([
        `modify poi ${POI.cityHallAtm}: HEAD has rev 1; the diff was made against rev 2`,
        `remove space ${NEW_SPACE}: HEAD no longer has it`,
        `add node ${NODE.funanB2Junction}: HEAD already has it`,
      ]);
    }));

  test("a reference to a row HEAD no longer has; one the diff adds is fine", () =>
    rolledBack(async (trx) => {
      expect(await rebaseReasons(trx, changeSet([newEdge(NEW_NODE)]))).toEqual([
        `add edge ${NEW_EDGE}: to_node references node ${NEW_NODE}, which HEAD no longer has`,
      ]);
      expect(await rebaseReasons(trx, changeSet([newEdge(NEW_NODE), newNode()]))).toEqual([]);
    }));

  test("a remove that would cascade to rows the diff leaves", () =>
    rolledBack(async (trx) => {
      const node = await headRow(trx, "nodes", NODE.northBridgeRoadExit);
      const toilet = await headRow(trx, "spaces", SPACE.funanB2Toilet);
      const diff: ChangeSetDiff = [
        {
          op: "remove",
          feature_type: "node",
          id: node.id,
          base_rev: 1,
          before: node.row,
          after: null,
        },
        {
          op: "remove",
          feature_type: "space",
          id: toilet.id,
          base_rev: 1,
          before: toilet.row,
          after: null,
        },
      ];
      expect(await rebaseReasons(trx, changeSet(diff))).toEqual([
        `remove node ${NODE.northBridgeRoadExit}: edge ${EDGE.exitBStairs} references it (to_node), and the diff leaves that`,
        `remove space ${SPACE.funanB2Toilet}: poi ${POI.funanToilets} references it (space_id), and the diff leaves that`,
        `remove node ${NODE.northBridgeRoadExit}: anchor ${PRIVATE.anchorId} references it (node_id), and the diff leaves that`,
      ]);
    }));

  test("removing an anchor a capture starts or ends on", () =>
    rolledBack(async (trx) => {
      await sql`INSERT INTO captures (id, contributor_id, start_anchor_id, captured_at)
                VALUES (gen_random_uuid(), ${CONTRIBUTOR.owner}, ${PRIVATE.anchorId}, now())`.execute(
        trx,
      );
      const anchor = await headRow(trx, "anchors", PRIVATE.anchorId);
      const diff: ChangeSetDiff = [
        {
          op: "remove",
          feature_type: "anchor",
          id: anchor.id,
          base_rev: 1,
          before: anchor.row,
          after: null,
        },
      ];
      expect(await rebaseReasons(trx, changeSet(diff))).toEqual([
        `remove anchor ${PRIVATE.anchorId}: a capture starts or ends on it`,
      ]);
    }));

  test("a base version that a rollback undid, whenever the change set arrives", () =>
    rolledBack(async (trx) => {
      // Versions 1 and 2, then 3 rolls back to 1, undoing 2. (Rolled back, so the rule that every
      // version publishes a change set, checked at commit, never fires.)
      for (const restores of [null, null, 1]) {
        await sql`INSERT INTO map_versions (snapshot_uri, snapshot_sha256, private_export_uri, restores)
                  VALUES ('snapshots/x/', 'x', 'head/x', ${restores})`.execute(trx);
      }
      const ids = (await trx.selectFrom("map_versions").select("id").orderBy("id").execute()).map(
        (v) => v.id,
      );
      const [first, second, third] = ids as [number, number, number];
      const diff = [newNode()];
      expect(await rebaseReasons(trx, changeSet(diff, second))).toEqual([
        `version ${third} rolled back to version ${first}, undoing the base version ${second}`,
      ]);
      expect(await rebaseReasons(trx, changeSet(diff, first))).toEqual([]);
      expect(await rebaseReasons(trx, changeSet(diff, third))).toEqual([]);
    }));

  test("a diff that no longer validates", () =>
    rolledBack(async (trx) => {
      const node = newNode() as DiffEntry & { after: Record<string, unknown> };
      const reasons = await rebaseReasons(
        trx,
        changeSet([{ ...node, after: { ...node.after, floor: 2 } }]),
      );
      expect(reasons.length).toBeGreaterThan(0);
      for (const reason of reasons) expect(reason).toMatch(/^the diff no longer validates: /);
      expect(reasons.some((reason) => reason.includes('unknown field "floor"'))).toBe(true);
    }));

  test("needs_rebase applies nothing", () =>
    rolledBack(async (trx) => {
      const outcome = await applyChangeSet(trx, changeSet([newNode(), newEdge(NEW_SPACE)]));
      expect(outcome.decision).toBe("needs_rebase");
      expect(
        await trx.selectFrom("nodes").select("id").where("id", "=", NEW_NODE).execute(),
      ).toEqual([]);
    }));
});

describe("under a savepoint: what the database refuses, and the restricted zones", () => {
  const levelName = (trx: Kysely<Database>, id: string) =>
    trx.selectFrom("levels").select("name").where("id", "=", id).executeTakeFirstOrThrow();

  /** A diff entry renaming a level, from its HEAD row. */
  async function rename(trx: Kysely<Database>, id: string, name: string): Promise<DiffEntry> {
    const level = await headRow(trx, "levels", id);
    return {
      op: "modify",
      feature_type: "level",
      id,
      base_rev: level.rev,
      before: level.row,
      after: { ...level.row, name },
    };
  }

  test("two levels of a venue swap names: checked once the change set is in", () =>
    rolledBack(async (trx) => {
      const diff = [await rename(trx, LEVEL.funanB2, "B1"), await rename(trx, LEVEL.funanB1, "B2")];
      expect(await applyChangeSet(trx, changeSet(diff))).toEqual({
        decision: "applied",
        counts: { added: 0, modified: 2, removed: 0 },
      });
      expect(await levelName(trx, LEVEL.funanB2)).toEqual({ name: "B1" });
      expect(await levelName(trx, LEVEL.funanB1)).toEqual({ name: "B2" });
      // Checked statement by statement again afterwards.
      await expect(
        sql`UPDATE levels SET name = 'B1' WHERE id = ${LEVEL.funanB1}`.execute(trx),
      ).rejects.toMatchObject({ code: "23505", constraint: "levels_venue_id_name_key" });
    }));

  test("a name two levels of a venue would share: needs_rebase naming the constraint, nothing applied", () =>
    rolledBack(async (trx) => {
      const atm = await headRow(trx, "pois", POI.cityHallAtm);
      const diff: ChangeSetDiff = [
        await rename(trx, LEVEL.funanB2, "B1"),
        {
          op: "modify",
          feature_type: "poi",
          id: atm.id,
          base_rev: atm.rev,
          before: atm.row,
          after: { ...atm.row, name: "ATM (renamed)" },
        },
      ];
      expect(await applyChangeSet(trx, changeSet(diff))).toEqual({
        decision: "needs_rebase",
        reasons: [
          'the database refused the change set: duplicate key value violates unique constraint "levels_venue_id_name_key"',
        ],
      });
      expect(await levelName(trx, LEVEL.funanB2)).toEqual({ name: "B2" });
      expect(
        await trx.selectFrom("pois").select("name").where("id", "=", POI.cityHallAtm).execute(),
      ).toEqual([{ name: atm.row.name }]);
      // The transaction carries on, with the constraint immediate again.
      await expect(
        sql`UPDATE levels SET name = 'B1' WHERE id = ${LEVEL.funanB2}`.execute(trx),
      ).rejects.toMatchObject({ code: "23505" });
    }));

  test("an entry the database refuses names the entry", () =>
    rolledBack(async (trx) => {
      // The trigger refuses a space over the zone (the gate would have caught it first).
      const diff: ChangeSetDiff = [
        {
          op: "add",
          feature_type: "space",
          id: NEW_SPACE,
          base_rev: null,
          before: null,
          after: {
            level_id: LEVEL.funanB2,
            kind: "walkway",
            name: null,
            geom: {
              type: "Polygon",
              coordinates: [
                [
                  [103.8493, 1.2906],
                  [103.8495, 1.2906],
                  [103.8495, 1.2908],
                  [103.8493, 1.2908],
                  [103.8493, 1.2906],
                ],
              ],
            },
          },
        },
      ];
      expect(await applyChangeSet(trx, changeSet(diff))).toEqual({
        decision: "needs_rebase",
        reasons: [
          `add space ${NEW_SPACE}: the database refused it: spaces ${NEW_SPACE}: overlaps a restricted zone`,
        ],
      });
    }));

  test("an edge drawn straight across a zone, which the trigger can't see: needs_rebase", () =>
    rolledBack(async (trx) => {
      // No stored line: drawn from the new node to Funan B2's escalator, through the zone.
      const node: DiffEntry = {
        ...newNode(),
        after: {
          ...(newNode().after as Extract<DiffEntry, { feature_type: "node"; op: "add" }>["after"]),
          level_id: LEVEL.funanB2,
          geom: { type: "Point", coordinates: [103.8493, 1.2906] },
        },
      } as DiffEntry;
      const edge = newEdge(NEW_NODE) as Extract<DiffEntry, { feature_type: "edge"; op: "add" }>;
      const diff = [
        node,
        {
          ...edge,
          after: { ...edge.after, from_node: NODE.funanB2Escalator, level_id: LEVEL.funanB2 },
        },
      ] as ChangeSetDiff;
      expect(await applyChangeSet(trx, changeSet(diff))).toEqual({
        decision: "needs_rebase",
        reasons: [
          `restricted zones: edge ${NEW_EDGE} overlaps restricted zone ${PRIVATE.zoneId} on level ${LEVEL.funanB2}`,
        ],
      });
      expect(
        await trx.selectFrom("nodes").select("id").where("id", "=", NEW_NODE).execute(),
      ).toEqual([]);
    }));

  test("a level moved to another venue while restricted zones are drawn on it", () =>
    rolledBack(async (trx) => {
      const level = await headRow(trx, "levels", LEVEL.funanB2);
      const diff: ChangeSetDiff = [
        {
          op: "modify",
          feature_type: "level",
          id: level.id,
          base_rev: level.rev,
          before: level.row,
          after: { ...level.row, venue_id: VENUE.rafflesCity, name: "B2" },
        },
      ];
      expect(await rebaseReasons(trx, changeSet(diff))).toEqual([
        `modify level ${LEVEL.funanB2}: moves it from venue ${VENUE.funan} to ${VENUE.rafflesCity}, but restricted zones are drawn on it`,
      ]);
    }));
});
