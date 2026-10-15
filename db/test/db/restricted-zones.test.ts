// Restricted zones: no feature may overlap a zone's interior (sharing its edge is fine), a
// level or venue with zones cannot be deleted, and an invalid outline is refused. The zone is
// synthetic: a 5 m square on Funan B2, not a real back-of-house outline.

import { describe, expect, test } from "vitest";
import { box, LEVEL, line, NODE, point, seedCluster, VENUE } from "./fixtures.ts";
import { SQLSTATE, type TestDb, useDatabase } from "./harness.ts";

// The zone spans lon 103.84980-103.84985, lat 1.29120-1.29125.
const ZONE = box(103.8498, 1.2912, 103.84985, 1.29125);
const INSIDE = [103.849825, 1.291225] as const;
const ON_EDGE = [103.84985, 1.291225] as const;
const OUTSIDE = [103.8499, 1.291225] as const;

const db = useDatabase(async (fresh: TestDb) => {
  await seedCluster(fresh);
  await fresh.query(
    "INSERT INTO restricted_zones (venue_id, level_id, geom, note) VALUES ($1, $2, $3::geometry, 'synthetic')",
    [VENUE.funan, LEVEL.funanB2, ZONE],
  );
});

const overlaps = (table: string) => ({
  code: SQLSTATE.checkViolation,
  message: new RegExp(`^${table} .*: overlaps a restricted zone$`),
});

/**
 * Each table the zone rule guards, with an insert ($1 the level, $2 the geometry, then
 * `params`) and a geometry clear of the zone, one on its edge and one inside it. An UPDATE
 * of geom or level_id must be checked as well as an INSERT.
 */
const MOVABLE = [
  {
    table: "spaces",
    insert:
      "INSERT INTO spaces (level_id, kind, geom) VALUES ($1, 'walkway', $2::geometry) RETURNING id",
    params: [],
    outside: box(103.84986, 1.2912, 103.84995, 1.29125),
    onEdge: box(103.84985, 1.2912, 103.84995, 1.29125),
    inside: box(103.84981, 1.29121, 103.84984, 1.29124),
  },
  {
    table: "nodes",
    insert:
      "INSERT INTO nodes (level_id, kind, geom) VALUES ($1, 'junction', $2::geometry) RETURNING id",
    params: [],
    outside: point(OUTSIDE),
    onEdge: point(ON_EDGE),
    inside: point(INSIDE),
  },
  {
    table: "edges",
    insert: `INSERT INTO edges (from_node, to_node, kind, level_id, length_m, step_free, sheltered,
                                outdoor, geom)
             VALUES ($3, $4, 'walk', $1, 6, true, true, false, $2::geometry) RETURNING id`,
    params: [NODE.funanB2Escalator, NODE.northBridgeRoadExit],
    outside: line([103.8499, 1.291225], [103.84995, 1.291225]),
    onEdge: line([103.84985, 1.2912], [103.84985, 1.29125]),
    inside: line([103.84981, 1.291225], [103.84984, 1.291225]),
  },
  {
    table: "pois",
    insert:
      "INSERT INTO pois (level_id, name, category, geom) VALUES ($1, 'Kiosk', 'shop', $2::geometry) RETURNING id",
    params: [],
    outside: point(OUTSIDE),
    onEdge: point(ON_EDGE),
    inside: point(INSIDE),
  },
];

describe("features overlapping a zone's interior", () => {
  test("a space overlapping the zone is refused; one sharing its edge is accepted", () =>
    db.rolledBack(async () => {
      const insert =
        "INSERT INTO spaces (level_id, kind, geom) VALUES ($1, 'walkway', $2::geometry)";
      await db.expectRefused(
        insert,
        [LEVEL.funanB2, box(103.84979, 1.29119, 103.84986, 1.29126)],
        overlaps("spaces"),
      );
      await db.query(insert, [LEVEL.funanB2, box(103.84985, 1.2912, 103.84995, 1.29125)]);
    }));

  test("a node inside the zone is refused; a door on its edge is accepted", () =>
    db.rolledBack(async () => {
      const insert = "INSERT INTO nodes (level_id, kind, geom) VALUES ($1, 'door', $2::geometry)";
      await db.expectRefused(insert, [LEVEL.funanB2, point(INSIDE)], overlaps("nodes"));
      await db.query(insert, [LEVEL.funanB2, point(ON_EDGE)]);
    }));

  test("a POI inside the zone is refused; one outside is accepted", () =>
    db.rolledBack(async () => {
      const insert =
        "INSERT INTO pois (level_id, name, category, geom) VALUES ($1, 'Kiosk', 'shop', $2::geometry)";
      await db.expectRefused(insert, [LEVEL.funanB2, point(INSIDE)], overlaps("pois"));
      await db.query(insert, [LEVEL.funanB2, point(OUTSIDE)]);
    }));

  test("an edge crossing the zone is refused; one along its edge is accepted", () =>
    db.rolledBack(async () => {
      const insert = `INSERT INTO edges (from_node, to_node, kind, level_id, length_m, step_free,
                                         sheltered, outdoor, geom)
                      VALUES ($1, $2, 'walk', $3, 6, true, true, false, $4::geometry)`;
      const params = [NODE.funanB2Escalator, NODE.northBridgeRoadExit, LEVEL.funanB2];
      await db.expectRefused(
        insert,
        [...params, line([103.84978, 1.291225], [103.84987, 1.291225])],
        overlaps("edges"),
      );
      await db.query(insert, [...params, line([103.84985, 1.2912], [103.84985, 1.29125])]);
    }));

  test.each(MOVABLE)(
    "moving one of $table into the zone is refused; onto its edge is accepted",
    ({ table, insert, params, outside, onEdge, inside }) =>
      db.rolledBack(async () => {
        const id = await db.value<string>(insert, [LEVEL.funanB2, outside, ...params]);
        const move = `UPDATE ${table} SET geom = $2::geometry WHERE id = $1`;
        await db.expectRefused(move, [id, inside], overlaps(table));
        await db.query(move, [id, onEdge]);
      }),
  );

  test.each(MOVABLE)(
    "moving one of $table onto the zone's level, inside it, is refused; onto another level is accepted",
    ({ table, insert, params, inside }) =>
      db.rolledBack(async () => {
        const id = await db.value<string>(insert, [LEVEL.funanB1, inside, ...params]);
        const move = `UPDATE ${table} SET level_id = $2 WHERE id = $1`;
        await db.expectRefused(move, [id, LEVEL.funanB2], overlaps(table));
        await db.query(move, [id, LEVEL.funanB1M]);
      }),
  );

  test("a zone on one level leaves the other levels of the venue alone", () =>
    db.rolledBack(async () => {
      await db.query("INSERT INTO nodes (level_id, kind, geom) VALUES ($1, 'door', $2::geometry)", [
        LEVEL.funanB1,
        point(INSIDE),
      ]);
    }));

  test("a venue-wide zone (no level) covers every level of its venue, and no other venue", () =>
    db.rolledBack(async () => {
      const zone = box(103.853, 1.2936, 103.8532, 1.2938);
      const inside = point([103.8531, 1.2937]);
      await db.query("INSERT INTO restricted_zones (venue_id, geom) VALUES ($1, $2::geometry)", [
        VENUE.rafflesCity,
        zone,
      ]);
      const insert = "INSERT INTO nodes (level_id, kind, geom) VALUES ($1, 'door', $2::geometry)";
      await db.expectRefused(insert, [LEVEL.rafflesCityB1, inside], overlaps("nodes"));
      await db.query(insert, [LEVEL.funanB1, inside]);
    }));
});

describe("zone outlines and their levels", () => {
  test("a zone whose level belongs to another venue is refused", () =>
    db.rolledBack(() =>
      db.expectRefused(
        "INSERT INTO restricted_zones (venue_id, level_id, geom) VALUES ($1, $2, $3::geometry)",
        [VENUE.rafflesCity, LEVEL.funanB1, box(103.853, 1.2936, 103.8532, 1.2938)],
        {
          code: SQLSTATE.foreignKeyViolation,
          constraint: "restricted_zones_level_id_venue_id_fkey",
        },
      ),
    ));

  test("an invalid (self-intersecting) outline is refused; a valid one is accepted", () =>
    db.rolledBack(async () => {
      const insert = "INSERT INTO restricted_zones (venue_id, geom) VALUES ($1, $2::geometry)";
      await db.expectRefused(
        insert,
        [
          VENUE.funan,
          "SRID=4326;POLYGON((103.8498 1.2912, 103.8499 1.2913, 103.8499 1.2912, 103.8498 1.2913, 103.8498 1.2912))",
        ],
        { code: SQLSTATE.checkViolation, constraint: "restricted_zones_geom_check" },
      );
      await db.query(insert, [VENUE.funan, box(103.8498, 1.2913, 103.8499, 1.2914)]);
    }));
});

describe("deleting levels and venues", () => {
  test("a level with a zone cannot be deleted; one without can", () =>
    db.rolledBack(async () => {
      await db.expectRefused("DELETE FROM levels WHERE id = $1", [LEVEL.funanB2], {
        code: SQLSTATE.restrictViolation,
        constraint: "restricted_zones_level_id_venue_id_fkey",
      });
      await db.query("DELETE FROM levels WHERE id = $1", [LEVEL.funanB1M]);
      expect(
        await db.value<number>("SELECT count(*)::int FROM levels WHERE id = $1", [LEVEL.funanB1M]),
      ).toBe(0);
    }));

  test("a venue with a zone cannot be deleted; one without can", () =>
    db.rolledBack(async () => {
      await db.expectRefused("DELETE FROM venues WHERE id = $1", [VENUE.funan], {
        code: SQLSTATE.restrictViolation,
        constraint: "restricted_zones_venue_id_fkey",
      });
      await db.query("DELETE FROM venues WHERE id = $1", [VENUE.rafflesCity]);
    }));
});
