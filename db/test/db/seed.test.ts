// The seed script's mechanism (src/seed.ts): it loads into an empty database, running it twice
// changes nothing, and after a row exists it writes only venues.permission, so an approved change
// is never undone. Removals happen only when named, and only for rows nothing references. It refuses
// a database that holds the demo map.

import { describe, expect, test } from "vitest";
import { CORE_VENUE, coreVenues, EXPANSION_VENUE } from "../../seed/core-venues.ts";
import { DEMO_OWNER } from "../../src/demo.ts";
import { checkDataset, type SeedDataset, SeedError, type SeedVenue, seed } from "../../src/seed.ts";
import { point } from "./fixtures.ts";
import { type TestDb, useDatabase } from "./harness.ts";

const db = useDatabase();

/** Every venue and level row, as text, for before-and-after comparisons. */
async function headRows(d: TestDb): Promise<string> {
  const venues = await d.query(
    `SELECT id, name, kind, operator, permission, ST_AsText(footprint) AS footprint, updated_at, rev
       FROM venues ORDER BY id`,
  );
  const levels = await d.query(
    "SELECT id, venue_id, ordinal, name, elevation_m, sort_key, rev FROM levels ORDER BY id",
  );
  return JSON.stringify({ venues, levels });
}

/** A synthetic venue (at City Hall coordinates) with two levels. */
function venue(id: string, levels: [string, string]): SeedVenue {
  return {
    id,
    name: `Synthetic venue ${id.slice(0, 4)}`,
    kind: "mall",
    operator: "Synthetic Landlord Pte Ltd",
    permission: "synthetic-permission-1",
    footprint: {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [103.8492, 1.2905],
            [103.8507, 1.2905],
            [103.8507, 1.292],
            [103.8492, 1.292],
            [103.8492, 1.2905],
          ],
        ],
      ],
    },
    levels: [
      { id: levels[0], name: "B2", ordinal: -2, sort_key: 0 },
      { id: levels[1], name: "B1", ordinal: -1, sort_key: 0 },
    ],
  };
}

/** A dataset of that one venue. */
function dataset(id: string, levels: [string, string], extra: Partial<SeedDataset> = {}) {
  return { name: "test", venues: [venue(id, levels)], ...extra } satisfies SeedDataset;
}

describe("the core venues", () => {
  test("load into an empty database; running the seed again changes nothing", async () => {
    const first = await seed(db.client, coreVenues);
    expect(first.insertedVenues).toEqual(Object.values(CORE_VENUE));
    expect(first.insertedLevels).toEqual([]);
    // Funan and CityLink Mall aren't there to remove.
    expect(first.removedVenues).toEqual([]);
    const after = await headRows(db);

    const second = await seed(db.client, coreVenues);
    expect(second).toEqual({
      insertedVenues: [],
      insertedLevels: [],
      permissionUpdated: [],
      removedVenues: [],
      removedLevels: [],
      differences: [],
    });
    expect(await headRows(db)).toBe(after);
    expect(
      await db.query("SELECT name, kind::text FROM venues WHERE id = ANY($1) ORDER BY name", [
        Object.values(CORE_VENUE),
      ]),
    ).toEqual([
      { name: "City Hall MRT", kind: "mrt_station" },
      { name: "Esplanade MRT", kind: "mrt_station" },
      { name: "Marina Square", kind: "mall" },
      { name: "Raffles City", kind: "mall" },
      { name: "South Beach", kind: "other" },
    ]);
    // Scanning needs no venue permission (2026-10-17), so none is recorded.
    expect(
      await db.value(
        "SELECT count(*)::int FROM venues WHERE id = ANY($1) AND permission IS NOT NULL",
        [Object.values(CORE_VENUE)],
      ),
    ).toBe(0);
  });

  test("take Funan and CityLink Mall out of a database seeded before the corridor", async () => {
    // The dataset as it was before 2026-10-17, for the two venues that left it.
    const earlier: SeedDataset = {
      name: "core venues before 2026-10-17",
      venues: [
        {
          id: EXPANSION_VENUE.funan,
          name: "Funan",
          kind: "mall",
          operator: null,
          permission:
            "Written permission from Funan's landlord, granted 2026-10-15 (letter kept outside the repo)",
          footprint: null,
          levels: [],
        },
        {
          id: EXPANSION_VENUE.cityLinkMall,
          name: "CityLink Mall",
          kind: "mall",
          operator: null,
          permission: null,
          footprint: null,
          levels: [],
        },
      ],
    };
    await seed(db.client, earlier);

    const report = await seed(db.client, coreVenues);
    expect(report.removedVenues).toEqual([EXPANSION_VENUE.funan, EXPANSION_VENUE.cityLinkMall]);
    expect(
      await db.value("SELECT count(*)::int FROM venues WHERE id = ANY($1)", [
        Object.values(EXPANSION_VENUE),
      ]),
    ).toBe(0);
    expect(
      await db.value("SELECT count(*)::int FROM venues WHERE id = ANY($1)", [
        Object.values(CORE_VENUE),
      ]),
    ).toBe(Object.values(CORE_VENUE).length);
    expect((await seed(db.client, coreVenues)).removedVenues).toEqual([]);
  });

  test("are a well-formed dataset with fixed ids", () => {
    expect(checkDataset(coreVenues)).toEqual([]);
  });
});

describe("re-running", () => {
  const VENUE = "a1000000-0000-4000-8000-000000000001";
  const LEVELS: [string, string] = [
    "a1000000-0000-4000-8000-000000000002",
    "a1000000-0000-4000-8000-000000000003",
  ];

  test("never undoes an approved change, and writes only permission", async () => {
    await seed(db.client, dataset(VENUE, LEVELS));
    // A change set measured B2's height and renamed it (rev bumped by the approval).
    await db.query(
      "UPDATE levels SET elevation_m = -9.5, name = 'B2 (Link)', rev = rev + 1 WHERE id = $1",
      [LEVELS[0]],
    );
    await db.query("UPDATE venues SET name = 'Renamed venue', rev = rev + 1 WHERE id = $1", [
      VENUE,
    ]);

    const report = await seed(db.client, {
      name: "test",
      venues: [{ ...venue(VENUE, LEVELS), permission: "synthetic-permission-2" }],
    });
    expect(report.permissionUpdated).toEqual([VENUE]);
    expect(report.differences).toEqual([
      `venue ${VENUE}: HEAD's name differ; left as HEAD has them`,
      `level ${LEVELS[0]}: HEAD's name differ; left as HEAD has them`,
    ]);
    expect(
      await db.query("SELECT name, permission, rev FROM venues WHERE id = $1", [VENUE]),
    ).toEqual([{ name: "Renamed venue", permission: "synthetic-permission-2", rev: 2 }]);
    expect(
      await db.query("SELECT name, elevation_m, rev FROM levels WHERE id = $1", [LEVELS[0]]),
    ).toEqual([{ name: "B2 (Link)", elevation_m: -9.5, rev: 2 }]);
  });

  test("adds a level the dataset gained, and leaves the others", async () => {
    const added = "a1000000-0000-4000-8000-000000000004";
    const next = venue(VENUE, LEVELS);
    const report = await seed(db.client, {
      name: "test",
      venues: [
        {
          ...next,
          permission: "synthetic-permission-2",
          levels: [...next.levels, { id: added, name: "B1M", ordinal: -1, sort_key: 1 }],
        },
      ],
    });
    expect(report.insertedLevels).toEqual([added]);
    expect(report.insertedVenues).toEqual([]);
  });
});

describe("removing", () => {
  const VENUE = "b1000000-0000-4000-8000-000000000001";
  const LEVELS: [string, string] = [
    "b1000000-0000-4000-8000-000000000002",
    "b1000000-0000-4000-8000-000000000003",
  ];

  test("removes a named level that nothing references", async () => {
    await seed(db.client, dataset(VENUE, LEVELS));
    const kept = venue(VENUE, LEVELS);
    const report = await seed(db.client, {
      name: "test",
      venues: [{ ...kept, levels: kept.levels.slice(0, 1) }],
      remove: { levels: [LEVELS[1]] },
    });
    expect(report.removedLevels).toEqual([LEVELS[1]]);
    expect(await db.value("SELECT count(*)::int FROM levels WHERE id = $1", [LEVELS[1]])).toBe(0);
  });

  test("refuses a level with a node on it, and writes nothing", async () => {
    await db.query(
      "INSERT INTO nodes (id, level_id, kind, geom) VALUES (gen_random_uuid(), $1, 'junction', $2::geometry)",
      [LEVELS[0], point([103.85, 1.2913])],
    );
    const before = await headRows(db);
    const newVenue = "b1000000-0000-4000-8000-000000000009";
    const other = dataset(newVenue, [
      "b1000000-0000-4000-8000-00000000000a",
      "b1000000-0000-4000-8000-00000000000b",
    ]);
    const attempt = seed(db.client, { ...other, remove: { levels: [LEVELS[0]] } });
    await expect(attempt).rejects.toThrow(SeedError);
    await expect(attempt).rejects.toThrow(/level .* can't be removed while HEAD has 1 nodes on it/);
    expect(await headRows(db)).toBe(before);
  });

  test("refuses a venue that still has levels", async () => {
    await expect(
      seed(db.client, { name: "test", venues: [], remove: { venues: [VENUE] } }),
    ).rejects.toThrow(/venue .* can't be removed while it has 1 levels/);
  });
});

describe("a malformed dataset", () => {
  test("is refused before anything is written", async () => {
    const bad = dataset("not-a-uuid", [
      "c1000000-0000-4000-8000-000000000002",
      "c1000000-0000-4000-8000-000000000002",
    ]);
    expect(checkDataset(bad)).toEqual([
      'venue not-a-uuid: id "not-a-uuid" is not a lowercase UUID',
      "venue not-a-uuid, level c1000000-0000-4000-8000-000000000002: id c1000000-0000-4000-8000-000000000002 is used twice",
    ]);
    await expect(seed(db.client, bad)).rejects.toThrow(SeedError);
  });

  test("a level whose name another level of the venue has is refused", async () => {
    const VENUE = "d1000000-0000-4000-8000-000000000001";
    await seed(
      db.client,
      dataset(VENUE, [
        "d1000000-0000-4000-8000-000000000002",
        "d1000000-0000-4000-8000-000000000003",
      ]),
    );
    await expect(
      seed(
        db.client,
        dataset(VENUE, [
          "d1000000-0000-4000-8000-000000000004",
          "d1000000-0000-4000-8000-000000000003",
        ]),
      ),
    ).rejects.toThrow(/already has a level named B2/);
  });
});

describe("a database that holds the demo map", () => {
  test("is refused, having written nothing, unless the dataset is the demo's own", async () => {
    await db.query(
      "INSERT INTO contributors (id, display_name, trust_tier) VALUES ($1, 'Demo: owner', 'owner')",
      [DEMO_OWNER],
    );
    try {
      const before = await headRows(db);
      const real = dataset("e1000000-0000-4000-8000-000000000001", [
        "e1000000-0000-4000-8000-000000000002",
        "e1000000-0000-4000-8000-000000000003",
      ]);
      await expect(seed(db.client, real)).rejects.toThrow(
        "test: The database holds the demo map (`pnpm demo`). Run `pnpm demo --reset` first: real data never goes in beside it.",
      );
      expect(await headRows(db)).toBe(before);
      // The demo loads its own venues and levels through the same mechanism.
      const report = await seed(db.client, real, { demo: true });
      expect(report.insertedVenues).toEqual(["e1000000-0000-4000-8000-000000000001"]);
    } finally {
      await db.query("DELETE FROM levels WHERE venue_id = $1", [
        "e1000000-0000-4000-8000-000000000001",
      ]);
      await db.query("DELETE FROM venues WHERE id = $1", ["e1000000-0000-4000-8000-000000000001"]);
      await db.query("DELETE FROM contributors WHERE id = $1", [DEMO_OWNER]);
    }
  });
});
