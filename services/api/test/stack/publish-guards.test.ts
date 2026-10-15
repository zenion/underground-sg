// What the publish transaction (src/publish/publish.ts) checks again at publish time, against
// PostGIS and RustFS on the synthetic City Hall HEAD with its made-up zone on Funan B2:
//
// - the restricted zones, against HEAD as it applies it and the zones as they are now: a change set
//   that clears its gates alone can still cross a zone once another change set has moved a node,
//   or once a zone has been drawn since; and the whole of HEAD, so a zone drawn over a feature no
//   change set touches stops the publish before a file is written;
// - that the gates checked the diff and captures the change set holds now;
// - that the database's refusal of one change set (a unique constraint) sends it to needs_rebase
//   and lets the others publish, and that two levels can swap names;
// - that real data never goes in beside the demo map, and the demo flag never on a real map.
//
// The tests share the database and run in order.

import { brotliDecompressSync } from "node:zlib";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { ChangeSetDiff, DiffEntry, IndoorSnapshot } from "@usg/contracts";
import { DEMO_OWNER } from "@usg/db/demo";
import { CONTRIBUTOR } from "@usg/db/test/fixtures";
import { useDatabase } from "@usg/db/test/harness";
import { sql } from "kysely";
import { describe, expect, test } from "vitest";
import { runGates } from "../../src/publish/gates.ts";
import { PublishRefusedError, publish } from "../../src/publish/publish.ts";
import { LEVEL, NODE, POI, PRIVATE, SPACE, seedCityHall, VENUE } from "../fixtures/city-hall.ts";
import { headRow, insertChangeSet } from "./head.ts";
import { listKeys, useKysely, useScratchStorage } from "./helpers.ts";

const db = useDatabase(async (d) => {
  await seedCityHall(d);
  await d.query(
    "INSERT INTO contributors (id, display_name, trust_tier) VALUES ($1, 'Owner', 'owner')",
    [CONTRIBUTOR.owner],
  );
});
const kysely = useKysely(db);
const scratch = useScratchStorage();
const OWNER = CONTRIBUTOR.owner;

type LonLat = [number, number];

const nodeAdd = (id: string, level: string, at: LonLat): DiffEntry => ({
  op: "add",
  feature_type: "node",
  id,
  base_rev: null,
  before: null,
  after: {
    level_id: level,
    kind: "junction",
    name: null,
    street_name: null,
    connector_id: null,
    elevation_m: null,
    geom: { type: "Point", coordinates: at },
  },
});

/** An edge with no stored line: the public files draw it straight between its nodes. */
const edgeAdd = (id: string, from: string, to: string, level: string | null): DiffEntry => ({
  op: "add",
  feature_type: "edge",
  id,
  base_rev: null,
  before: null,
  after: {
    from_node: from,
    to_node: to,
    kind: "walk",
    oneway: false,
    access: "public",
    opening_hours: null,
    level_id: level,
    connector_id: null,
    length_m: 25,
    step_free: true,
    sheltered: true,
    outdoor: false,
    geom: null,
  },
});

async function headVersion(): Promise<number | null> {
  return (await kysely().selectFrom("map_head").select("version_id").executeTakeFirstOrThrow())
    .version_id;
}

/** A pending change set made against HEAD, its gates run and passed. */
async function gated(diff: ChangeSetDiff): Promise<string> {
  const id = await insertChangeSet(kysely(), OWNER, diff, await headVersion());
  const outcome = await runGates(kysely(), id);
  expect(outcome.passed, JSON.stringify(outcome.gates)).toBe(true);
  return id;
}

async function renamePoi(poi: string, name: string): Promise<string> {
  const head = await headRow(kysely(), "pois", poi);
  return gated([
    {
      op: "modify",
      feature_type: "poi",
      id: poi,
      base_rev: head.rev,
      before: head.row,
      after: { ...head.row, name },
    },
  ]);
}

async function reject(id: string): Promise<void> {
  await kysely()
    .updateTable("change_sets")
    .set({ decision: "rejected" })
    .where("id", "=", id)
    .execute();
}

async function decision(id: string): Promise<string> {
  return (
    await kysely()
      .selectFrom("change_sets")
      .select("decision")
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
  ).decision;
}

/** A zone drawn on a level by the owner, as a rectangle; returns its id. */
async function drawZone(
  venue: string,
  level: string,
  [west, south, east, north]: number[],
): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    INSERT INTO restricted_zones (venue_id, level_id, geom)
    VALUES (${venue}, ${level},
            ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326))
    RETURNING id`.execute(kysely());
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("no zone");
  return id;
}

async function eraseZone(id: string): Promise<void> {
  await sql`DELETE FROM restricted_zones WHERE id = ${id}`.execute(kysely());
}

const versionCount = async () =>
  (await kysely().selectFrom("map_versions").select("id").execute()).length;
const publicKeys = () => listKeys(scratch.publicBucket.client(), scratch.publicBucket.name());

async function refusal(promise: Promise<unknown>): Promise<readonly string[]> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PublishRefusedError);
  return (error as PublishRefusedError).problems;
}

describe("the restricted zones, checked again against HEAD and the zones as they are", () => {
  const EDGE_A = "b1000000-0000-4000-8000-000000000001";

  test("two change sets clear alone, across a zone together: the later one needs a rebase", async () => {
    // A: an edge drawn straight from Funan B2's escalator to its junction, clear of the zone.
    const a = await gated([
      edgeAdd(EDGE_A, NODE.funanB2Escalator, NODE.funanB2Junction, LEVEL.funanB2),
    ]);
    // B: the escalator moves west of the zone; the lines of the edges HEAD has still clear it.
    const escalator = await headRow(kysely(), "nodes", NODE.funanB2Escalator);
    const moved: LonLat = [103.8492, 1.29068];
    const b = await gated([
      {
        op: "modify",
        feature_type: "node",
        id: escalator.id,
        base_rev: escalator.rev,
        before: escalator.row,
        after: { ...escalator.row, geom: { type: "Point", coordinates: moved } },
      },
    ]);
    // Together, A's line would run from the moved escalator through the zone.
    const result = await publish(kysely(), scratch.storage(), {
      changeSetIds: [a, b],
      publishedBy: OWNER,
    });
    expect(result).toMatchObject({
      version: { id: 1 },
      published: [a],
      needsRebase: [
        {
          id: b,
          reasons: [
            `restricted zones: edge ${EDGE_A} overlaps restricted zone ${PRIVATE.zoneId} on level ${LEVEL.funanB2}`,
          ],
        },
      ],
    });
    expect(await decision(b)).toBe("needs_rebase");
    const position = await sql<{ geom: string }>`
      SELECT ST_AsGeoJSON(geom) AS geom FROM nodes WHERE id = ${NODE.funanB2Escalator}`.execute(
      kysely(),
    );
    expect(JSON.parse(position.rows[0]?.geom ?? "{}").coordinates).toEqual([103.8498, 1.2913]);
    // The published event names the gates record it relied on and the diff it checked.
    const published = await kysely()
      .selectFrom("moderation_events")
      .select(["action", "detail"])
      .where("change_set_id", "=", a)
      .orderBy("id")
      .execute();
    const gatesEvent = await kysely()
      .selectFrom("moderation_events")
      .select(["id", "detail"])
      .where("change_set_id", "=", a)
      .where("action", "=", "gates_passed")
      .executeTakeFirstOrThrow();
    expect(published.at(-1)).toEqual({
      action: "published",
      detail: {
        version: 1,
        publish_path: "owner_mapper",
        gates_event: String(gatesEvent.id),
        diff_sha256: (gatesEvent.detail as { diff_sha256: string }).diff_sha256,
      },
    });
  });

  test("a zone drawn after the gates passed: the change set crossing it needs a rebase", async () => {
    const [from, to, edge] = [
      "b1000000-0000-4000-8000-000000000002",
      "b1000000-0000-4000-8000-000000000003",
      "b1000000-0000-4000-8000-000000000004",
    ];
    const c = await gated([
      nodeAdd(from, LEVEL.funanB1, [103.8493, 1.2909]),
      nodeAdd(to, LEVEL.funanB1, [103.8495, 1.2911]),
      edgeAdd(edge, from, to, LEVEL.funanB1),
    ]);
    const zone = await drawZone(
      VENUE.funan,
      LEVEL.funanB1,
      [103.84935, 1.29095, 103.84945, 1.29105],
    );
    try {
      const keys = await publicKeys();
      const result = await publish(kysely(), scratch.storage(), {
        changeSetIds: [c],
        publishedBy: OWNER,
      });
      expect(result).toEqual({
        version: null,
        published: [],
        needsRebase: [
          {
            id: c,
            reasons: [
              `restricted zones: edge ${edge} overlaps restricted zone ${zone} on level ${LEVEL.funanB1}`,
            ],
          },
        ],
        pointer: { updated: false },
      });
      expect(await headVersion()).toBe(1);
      expect(await publicKeys()).toEqual(keys);
      expect(
        await kysely().selectFrom("nodes").select("id").where("id", "in", [from, to]).execute(),
      ).toEqual([]);
    } finally {
      await eraseZone(zone);
    }
  });

  test("a diff changed after its gates ran is refused until they run again, and then they fail", async () => {
    const d = await renamePoi(POI.cityHallAtm, "ATM (renamed)");
    const [from, to, edge] = [
      "b1000000-0000-4000-8000-000000000005",
      "b1000000-0000-4000-8000-000000000006",
      "b1000000-0000-4000-8000-000000000007",
    ];
    const swapped: ChangeSetDiff = [
      nodeAdd(from, LEVEL.funanB2, [103.8493, 1.2906]),
      nodeAdd(to, LEVEL.funanB2, [103.8495, 1.2908]),
      edgeAdd(edge, from, to, null),
    ];
    await kysely()
      .updateTable("change_sets")
      .set({ diff: JSON.stringify(swapped) })
      .where("id", "=", d)
      .execute();
    const keys = await publicKeys();
    expect(
      await refusal(
        publish(kysely(), scratch.storage(), { changeSetIds: [d], publishedBy: OWNER }),
      ),
    ).toEqual([
      `change set ${d}: its diff isn't the one its gates checked: run them again (pnpm map gates ${d})`,
    ]);
    expect(await versionCount()).toBe(1);
    expect(await publicKeys()).toEqual(keys);
    const again = await runGates(kysely(), d);
    expect(again.passed).toBe(false);
    expect(again.gates.find((g) => g.gate === "restricted_zones")?.problems).toEqual([
      `edge ${edge} overlaps restricted zone ${PRIVATE.zoneId} on level ${LEVEL.funanB2}`,
    ]);
    await reject(d);
  });

  test("a capture linked after the gates ran is refused until they run again", async () => {
    const e = await renamePoi(POI.cityHallAtm, "ATM (captured)");
    const capture = await sql<{ id: string }>`
      INSERT INTO captures (id, contributor_id, status, captured_at)
      VALUES (gen_random_uuid(), ${OWNER}, 'ready_for_review', now())
      RETURNING id`.execute(kysely());
    await kysely()
      .insertInto("change_set_captures")
      .values({ change_set_id: e, capture_id: capture.rows[0]?.id ?? "" })
      .execute();
    expect(
      await refusal(
        publish(kysely(), scratch.storage(), { changeSetIds: [e], publishedBy: OWNER }),
      ),
    ).toEqual([
      `change set ${e}: its captures aren't the ones its gates checked: run them again (pnpm map gates ${e})`,
    ]);
    await reject(e);
  });

  test("a zone drawn over a feature no change set touches stops the publish before a file is written", async () => {
    const f = await renamePoi(POI.rafflesCityFood, "Food court (B1)");
    const zone = await drawZone(
      VENUE.rafflesCity,
      LEVEL.rafflesCityB1,
      [103.8526, 1.2934, 103.8527, 1.2935],
    );
    const keys = await publicKeys();
    try {
      const problems = await refusal(
        publish(kysely(), scratch.storage(), { changeSetIds: [f], publishedBy: OWNER }),
      );
      expect(problems).toContain(
        `space ${SPACE.rafflesCityB1Walkway} overlaps restricted zone ${zone} on level ${LEVEL.rafflesCityB1}`,
      );
      expect(problems.at(-1)).toMatch(/publish a change set that moves or removes it first/);
      for (const problem of problems) expect(problem).not.toMatch(/103\.852/);
      expect(await versionCount()).toBe(1);
      expect(await publicKeys()).toEqual(keys);
      expect(await decision(f)).toBe("pending");
    } finally {
      await eraseZone(zone);
    }
    // With the zone gone, the same change set publishes.
    const result = await publish(kysely(), scratch.storage(), {
      changeSetIds: [f],
      publishedBy: OWNER,
    });
    expect(result.version?.id).toBe(2);
  });

  test("a street connector across a zone stops the publish too", async () => {
    // An exit on Funan B1, joined at publish to the nearest street vertex (Exit B's, to the north).
    const exit = "b1000000-0000-4000-8000-000000000008";
    const entry = nodeAdd(exit, LEVEL.funanB1, [103.8506, 1.2915]);
    const g = await gated([{ ...entry, after: { ...entry.after, kind: "exit" } } as DiffEntry]);
    // Drawn after the gates, across the connector's line but clear of the exit itself.
    const zone = await drawZone(VENUE.funan, LEVEL.funanB1, [103.85062, 1.2919, 103.85072, 1.292]);
    try {
      const problems = await refusal(
        publish(kysely(), scratch.storage(), { changeSetIds: [g], publishedBy: OWNER }),
      );
      expect(problems.slice(0, -1)).toEqual([
        `street connector of node ${exit} overlaps restricted zone ${zone} on level ${LEVEL.funanB1}`,
      ]);
      expect(await versionCount()).toBe(2);
      expect(
        await kysely().selectFrom("nodes").select("id").where("id", "=", exit).execute(),
      ).toEqual([]);
    } finally {
      await eraseZone(zone);
    }
    await reject(g);
  });
});

describe("one change set the database refuses doesn't stop the others", () => {
  test("a duplicate level name needs a rebase; two levels swapping names publish", async () => {
    const level = async (id: string, name: string): Promise<DiffEntry> => {
      const row = await headRow(kysely(), "levels", id);
      return {
        op: "modify",
        feature_type: "level",
        id,
        base_rev: row.rev,
        before: row.row,
        after: { ...row.row, name },
      };
    };
    const duplicate = await gated([await level(LEVEL.funanB1, "B2")]);
    const swap = await gated([await level(LEVEL.funanB2, "B1"), await level(LEVEL.funanB1, "B2")]);
    const result = await publish(kysely(), scratch.storage(), {
      changeSetIds: [duplicate, swap],
      publishedBy: OWNER,
    });
    const reason =
      'the database refused the change set: duplicate key value violates unique constraint "levels_venue_id_name_key"';
    expect(result).toMatchObject({
      version: { id: 3 },
      published: [swap],
      needsRebase: [{ id: duplicate, reasons: [reason] }],
      pointer: { updated: true },
    });
    const event = await kysely()
      .selectFrom("moderation_events")
      .select("detail")
      .where("change_set_id", "=", duplicate)
      .where("action", "=", "needs_rebase")
      .executeTakeFirstOrThrow();
    expect(event.detail).toEqual({ reasons: [reason] });
    const directory = result.version?.directory ?? "";
    const b = scratch.publicBucket;
    const output = await b
      .client()
      .send(new GetObjectCommand({ Bucket: b.name(), Key: `${directory}indoor.json` }));
    const indoor = JSON.parse(
      brotliDecompressSync(Buffer.from((await output.Body?.transformToByteArray()) ?? [])).toString(
        "utf8",
      ),
    ) as IndoorSnapshot;
    const name = (id: string) =>
      (indoor.features.find((f) => f.id === id)?.properties as { name?: string } | undefined)?.name;
    expect([name(LEVEL.funanB2), name(LEVEL.funanB1)]).toEqual(["B1", "B2"]);
  });
});

describe("the demo map", () => {
  test("the demo flag on a database that doesn't hold the demo is refused", async () => {
    const g = await renamePoi(POI.cityHallAtm, "ATM (demo?)");
    expect(
      await refusal(
        publish(kysely(), scratch.storage(), { changeSetIds: [g], publishedBy: OWNER, demo: true }),
      ),
    ).toEqual(["demo is set, but the database doesn't hold the demo map"]);
    await reject(g);
  });

  test("real data on a database that holds the demo is refused", async () => {
    const h = await renamePoi(POI.cityHallAtm, "ATM (beside the demo)");
    await kysely()
      .insertInto("contributors")
      .values({ id: DEMO_OWNER, display_name: "Demo: owner", trust_tier: "owner" })
      .execute();
    try {
      expect(
        await refusal(
          publish(kysely(), scratch.storage(), { changeSetIds: [h], publishedBy: OWNER }),
        ),
      ).toEqual([
        "the database holds the demo map (pnpm demo): run `pnpm demo --reset` before publishing real data",
      ]);
    } finally {
      await kysely().deleteFrom("contributors").where("id", "=", DEMO_OWNER).execute();
    }
    expect(await versionCount()).toBe(3);
    await reject(h);
  });
});
