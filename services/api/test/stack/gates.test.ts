// The automated gates (src/publish/gates.ts) against PostGIS, on the synthetic City Hall HEAD with
// its made-up restricted zone on Funan B2: what passes, what fails and why, what is recorded in
// moderation_events (and that it names ids, never an outline, and says which diff and captures it
// checked), and that a gate with nothing to check is recorded as not applicable rather than as
// passed.

import { createHash } from "node:crypto";
import type { ChangeSetDiff, DiffEntry } from "@usg/contracts";
import { CONTRIBUTOR } from "@usg/db/test/fixtures";
import { useDatabase } from "@usg/db/test/harness";
import { sql } from "kysely";
import { describe, expect, test } from "vitest";
import { GatesRefusedError, runGates } from "../../src/publish/gates.ts";
import { EDGE, LEVEL, NODE, POI, PRIVATE, seedCityHall } from "../fixtures/city-hall.ts";
import { headRow, insertChangeSet } from "./head.ts";
import { useKysely } from "./helpers.ts";

const db = useDatabase(async (d) => {
  await seedCityHall(d);
  await d.query(
    "INSERT INTO contributors (id, display_name, trust_tier) VALUES ($1, 'Owner', 'owner')",
    [CONTRIBUTOR.owner],
  );
});
const kysely = useKysely(db);

type LonLat = [number, number];

function rectangle(west: number, south: number, east: number, north: number) {
  const ring: LonLat[] = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
  return {
    type: "Polygon" as const,
    coordinates: [ring] as [[LonLat, LonLat, LonLat, LonLat, ...LonLat[]]],
  };
}

/** The made-up zone on Funan B2: west 103.8493123, south 1.2906543, east 103.8494321, north 1.2907654. */
const ZONE = { west: PRIVATE.zoneCorner, south: 1.2906543, east: 103.8494321, north: 1.2907654 };

const space = (id: string, geom: ReturnType<typeof rectangle>): DiffEntry => ({
  op: "add",
  feature_type: "space",
  id,
  base_rev: null,
  before: null,
  after: { level_id: LEVEL.funanB2, kind: "walkway", name: null, geom },
});

const node = (id: string, level: string, at: LonLat): DiffEntry => ({
  op: "add",
  feature_type: "node",
  id,
  base_rev: null,
  before: null,
  after: {
    level_id: level,
    kind: "stairs",
    name: null,
    street_name: null,
    connector_id: null,
    elevation_m: null,
    geom: { type: "Point", coordinates: at },
  },
});

/** SHA-256 of a change set's diff as Postgres prints its jsonb, worked out here independently. */
async function diffHash(id: string): Promise<string> {
  const { rows } = await sql<{ text: string }>`
    SELECT diff::text AS text FROM change_sets WHERE id = ${id}`.execute(kysely());
  return createHash("sha256")
    .update(rows[0]?.text ?? "", "utf8")
    .digest("hex");
}

async function event(id: string) {
  return kysely()
    .selectFrom("moderation_events")
    .select(["action", "actor_id", "detail"])
    .where("change_set_id", "=", id)
    .orderBy("id", "desc")
    .executeTakeFirstOrThrow();
}

const NOT_APPLICABLE = {
  privacy: {
    gate: "privacy",
    result: "not_applicable",
    reason: "a manual edit: no captures, so no images to re-check",
  },
  alignment: {
    gate: "alignment_residuals",
    result: "not_applicable",
    reason: "a manual edit: no captured segments to align",
  },
  priors: {
    gate: "street_priors",
    result: "not_applicable",
    reason: "a manual edit: no captured segments to align",
  },
};

describe("a manual edit", () => {
  test("that shares a zone's edge passes, and the segment gates are recorded as not applicable", async () => {
    const id = await insertChangeSet(kysely(), CONTRIBUTOR.owner, [
      space(
        "e0000000-0000-4000-8000-000000000001",
        rectangle(ZONE.east, ZONE.south, 103.8496, ZONE.north),
      ),
    ]);
    const outcome = await runGates(kysely(), id);
    const gates = [
      { gate: "diff", result: "passed", reason: "the diff validates" },
      NOT_APPLICABLE.privacy,
      {
        gate: "restricted_zones",
        result: "passed",
        reason: "1 features checked; none overlaps a restricted zone",
      },
      NOT_APPLICABLE.alignment,
      NOT_APPLICABLE.priors,
    ];
    expect(outcome).toMatchObject({ changeSetId: id, passed: true, gates });
    // The record says what it checked: the diff, the captures (none) and the version of HEAD.
    expect(await event(id)).toEqual({
      action: "gates_passed",
      actor_id: null,
      detail: { gates, diff_sha256: await diffHash(id), captures: [], head_version: null },
    });
  });

  test("with a space overlapping a zone fails, naming ids and never the outline", async () => {
    const spaceId = "e0000000-0000-4000-8000-000000000002";
    const id = await insertChangeSet(kysely(), CONTRIBUTOR.owner, [
      space(spaceId, rectangle(103.8493, 1.2906, 103.8495, 1.2908)),
    ]);
    const outcome = await runGates(kysely(), id);
    expect(outcome.passed).toBe(false);
    expect(outcome.gates.find((g) => g.gate === "restricted_zones")).toEqual({
      gate: "restricted_zones",
      result: "failed",
      reason: "a feature overlaps the interior of a restricted zone",
      problems: [
        `space ${spaceId} overlaps restricted zone ${PRIVATE.zoneId} on level ${LEVEL.funanB2}`,
      ],
    });
    const recorded = await event(id);
    expect(recorded.action).toBe("gates_failed");
    const detail = JSON.stringify(recorded.detail);
    for (const secret of [
      String(ZONE.west),
      String(ZONE.east),
      String(ZONE.north),
      PRIVATE.zoneNote,
    ]) {
      expect(detail).not.toContain(secret);
    }
  });

  test("with a connector edge whose line crosses a zone on one of its end levels fails", async () => {
    const [b2, b1, edge] = [
      "e0000000-0000-4000-8000-000000000003",
      "e0000000-0000-4000-8000-000000000004",
      "e0000000-0000-4000-8000-000000000005",
    ];
    const diff: ChangeSetDiff = [
      node(b2, LEVEL.funanB2, [103.8493, 1.2907]),
      node(b1, LEVEL.funanB1, [103.8495, 1.2907]),
      {
        op: "add",
        feature_type: "edge",
        id: edge,
        base_rev: null,
        before: null,
        after: {
          from_node: b2,
          to_node: b1,
          kind: "stairs",
          oneway: false,
          access: "public",
          opening_hours: null,
          level_id: null,
          connector_id: null,
          length_m: 22.3,
          step_free: false,
          sheltered: true,
          outdoor: false,
          geom: null,
        },
      },
    ];
    const outcome = await runGates(
      kysely(),
      await insertChangeSet(kysely(), CONTRIBUTOR.owner, diff),
    );
    expect(outcome.gates.find((g) => g.gate === "restricted_zones")?.problems).toEqual([
      `edge ${edge} overlaps restricted zone ${PRIVATE.zoneId} on level ${LEVEL.funanB2}`,
    ]);
  });

  test("moving a node redraws the edges that end on it, and they are checked too", async () => {
    const escalator = await headRow(kysely(), "nodes", NODE.funanB2Escalator);
    const diff: ChangeSetDiff = [
      {
        op: "modify",
        feature_type: "node",
        id: escalator.id,
        base_rev: escalator.rev,
        before: escalator.row,
        after: { ...escalator.row, geom: { type: "Point", coordinates: [103.8493, 1.29071] } },
      },
    ];
    const outcome = await runGates(
      kysely(),
      await insertChangeSet(kysely(), CONTRIBUTOR.owner, diff),
    );
    expect(outcome.gates.find((g) => g.gate === "restricted_zones")?.problems).toEqual([
      `edge ${EDGE.funanB2Walk} (its end moves) overlaps restricted zone ${PRIVATE.zoneId} on level ${LEVEL.funanB2}`,
      `edge ${EDGE.funanEscalatorUp} (its end moves) overlaps restricted zone ${PRIVATE.zoneId} on level ${LEVEL.funanB2}`,
    ]);
  });

  test("whose diff doesn't validate fails the diff gate; the zones aren't checked, and say so", async () => {
    const outcome = await runGates(
      kysely(),
      await insertChangeSet(kysely(), CONTRIBUTOR.owner, [{ op: "add" }]),
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.gates.map((g) => [g.gate, g.result])).toEqual([
      ["diff", "failed"],
      ["privacy", "not_applicable"],
      ["restricted_zones", "not_applicable"],
      ["alignment_residuals", "not_applicable"],
      ["street_priors", "not_applicable"],
    ]);
    expect(outcome.gates.find((g) => g.gate === "restricted_zones")?.reason).toBe(
      "not run: the diff does not validate",
    );
  });

  test("that leaves no public feature to check records the zones as not applicable, not passed", async () => {
    const atm = await headRow(kysely(), "pois", POI.cityHallAtm);
    const anchor = await headRow(kysely(), "anchors", PRIVATE.anchorId);
    const id = await insertChangeSet(kysely(), CONTRIBUTOR.owner, [
      {
        op: "remove",
        feature_type: "poi",
        id: atm.id,
        base_rev: atm.rev,
        before: atm.row,
        after: null,
      },
      {
        op: "modify",
        feature_type: "anchor",
        id: anchor.id,
        base_rev: anchor.rev,
        before: anchor.row,
        after: { ...anchor.row, facing_deg: 12 },
      },
    ]);
    const outcome = await runGates(kysely(), id);
    expect(outcome.passed).toBe(true);
    expect(outcome.gates.find((g) => g.gate === "restricted_zones")).toEqual({
      gate: "restricted_zones",
      result: "not_applicable",
      reason: "no public features in the change set",
    });
  });
});

describe("a change set with captures", () => {
  test("fails privacy for a flagged capture, and the segment gates until Phase 2 builds them", async () => {
    const id = await insertChangeSet(kysely(), CONTRIBUTOR.owner, [
      space("e0000000-0000-4000-8000-000000000006", rectangle(103.8497, 1.2911, 103.8498, 1.2912)),
    ]);
    const capture = await sql<{ id: string }>`
      INSERT INTO captures (id, contributor_id, status, privacy_flagged, captured_at)
      VALUES (gen_random_uuid(), ${CONTRIBUTOR.owner}, 'ready_for_review', true, now())
      RETURNING id`.execute(kysely());
    const captureId = capture.rows[0]?.id ?? "";
    await kysely()
      .insertInto("change_set_captures")
      .values({ change_set_id: id, capture_id: captureId })
      .execute();
    const outcome = await runGates(kysely(), id);
    expect((await event(id)).detail).toMatchObject({ captures: [captureId] });
    expect(outcome.gates.map((g) => [g.gate, g.result, g.problems])).toEqual([
      ["diff", "passed", undefined],
      ["privacy", "failed", [`capture ${captureId} is privacy-flagged`]],
      ["restricted_zones", "passed", undefined],
      ["alignment_residuals", "failed", undefined],
      ["street_priors", "failed", undefined],
    ]);
  });
});

describe("refusals", () => {
  test("a change set that doesn't exist, isn't structural or isn't pending", async () => {
    await expect(runGates(kysely(), "e0000000-0000-4000-8000-0000000000ff")).rejects.toThrow(
      GatesRefusedError,
    );
    await expect(runGates(kysely(), "../latest")).rejects.toThrow(/is not a change set id/);
    const rejected = await insertChangeSet(kysely(), CONTRIBUTOR.owner, []);
    await kysely()
      .updateTable("change_sets")
      .set({ decision: "rejected" })
      .where("id", "=", rejected)
      .execute();
    await expect(runGates(kysely(), rejected)).rejects.toThrow(/is rejected, not pending/);
    const status = await kysely()
      .insertInto("change_sets")
      .values({ contributor_id: CONTRIBUTOR.owner, track: "status", diff: "[]" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await expect(runGates(kysely(), status.id)).rejects.toThrow(/status change set/);
  });

  test("inside a transaction, so the record could be rolled back", async () => {
    await expect(
      kysely()
        .transaction()
        .execute((trx) => runGates(trx, "e0000000-0000-4000-8000-0000000000ff")),
    ).rejects.toThrow(/transaction of its own/);
  });
});
