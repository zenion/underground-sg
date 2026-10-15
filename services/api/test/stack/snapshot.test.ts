// The snapshot builder against PostGIS: the golden files (test/fixtures/snapshot/), built from the
// synthetic City Hall HEAD in test/fixtures/city-hall.ts, and what the format promises about them:
// the same HEAD gives the same bytes whatever order the rows went in, lines run from their start
// node to their end node, nothing private gets out, and a HEAD whose files would fail validation
// gives no files.
//
// Update the golden files after a deliberate change with
//   pnpm --filter @usg/api exec vitest run --project stack test/stack/snapshot.test.ts -u
// and review the diff: the packages/routing tests read the same files.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type IndoorFeature,
  isIndoorFeature,
  type Position,
  SNAPSHOT_SCHEMA_FILES,
  snapshotDigestInput,
} from "@usg/contracts";
import { inlineSchema, streetConnectorId } from "@usg/contracts/validators";
import { useDatabase } from "@usg/db/test/harness";
import { beforeAll, describe, expect, test } from "vitest";
import { buildSnapshot, SnapshotInvalidError } from "../../src/publish/snapshot.ts";
import { rebuildStreetConnectors } from "../../src/publish/street-connectors.ts";
import {
  EDGE,
  LEVEL,
  NODE,
  OSM_NODE,
  OSM_WAY,
  POI,
  PRIVATE,
  SPACE,
  seedCityHall,
} from "../fixtures/city-hall.ts";
import { useKysely } from "./helpers.ts";

const GOLDEN = {
  indoor: "../fixtures/snapshot/indoor.json",
  street: "../fixtures/snapshot/street.json",
} as const;

const db = useDatabase((d) => seedCityHall(d));
const kysely = useKysely(db);
beforeAll(async () => {
  await rebuildStreetConnectors(kysely());
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function feature<T extends IndoorFeature["properties"]["feature_type"]>(
  features: readonly IndoorFeature[],
  type: T,
  id: string,
) {
  const found = features.find((f) => f.id === id);
  if (found === undefined || !isIndoorFeature(found, type)) throw new Error(`no ${type} ${id}`);
  return found;
}

describe("the golden files", () => {
  test("indoor.json and street.json match test/fixtures/snapshot/", async () => {
    const built = await buildSnapshot(kysely());
    await expect(text(built.files["indoor.json"].bytes)).toMatchFileSnapshot(GOLDEN.indoor);
    await expect(text(built.files["street.json"].bytes)).toMatchFileSnapshot(GOLDEN.street);
  });

  test("snapshot_sha256 is what `sha256sum --text indoor.json street.json | sha256sum` gives", async () => {
    const built = await buildSnapshot(kysely());
    const sha = (path: string) =>
      createHash("sha256")
        .update(readFileSync(new URL(path, import.meta.url)))
        .digest("hex");
    const lines = snapshotDigestInput({
      "indoor.json": sha(GOLDEN.indoor),
      "street.json": sha(GOLDEN.street),
    });
    expect(built.snapshotSha256).toBe(createHash("sha256").update(lines).digest("hex"));
    expect(built.directory).toBe(`snapshots/${built.snapshotSha256}/`);
    expect(built.files["indoor.json"].sha256).toBe(sha(GOLDEN.indoor));
  });

  test("are compact UTF-8 JSON with no byte order mark and no trailing newline", () => {
    for (const path of Object.values(GOLDEN)) {
      const bytes = readFileSync(new URL(path, import.meta.url));
      expect(bytes[0]).toBe("{".charCodeAt(0));
      expect(bytes.at(-1)).toBe("}".charCodeAt(0));
      expect(bytes.includes("\n".charCodeAt(0))).toBe(false);
      expect(JSON.stringify(JSON.parse(bytes.toString("utf8")))).toBe(bytes.toString("utf8"));
    }
  });
});

describe("determinism", () => {
  const reversed = useDatabase((d) => seedCityHall(d, { reverse: true }));
  const reversedKysely = useKysely(reversed);

  test("rows inserted in the reverse order give the same bytes", async () => {
    await rebuildStreetConnectors(reversedKysely());
    const a = await buildSnapshot(kysely());
    const b = await buildSnapshot(reversedKysely());
    expect(text(b.files["indoor.json"].bytes)).toBe(text(a.files["indoor.json"].bytes));
    expect(text(b.files["street.json"].bytes)).toBe(text(a.files["street.json"].bytes));
    expect(b.snapshotSha256).toBe(a.snapshotSha256);
  });

  test("rebuilding the street connectors changes nothing", async () => {
    const before = await buildSnapshot(kysely());
    expect(await rebuildStreetConnectors(kysely())).toBe(3);
    const after = await buildSnapshot(kysely());
    expect(after.snapshotSha256).toBe(before.snapshotSha256);
  });

  test("runs inside the caller's transaction and sees its writes", async () => {
    const before = await buildSnapshot(kysely());
    await kysely()
      .transaction()
      .execute(async (trx) => {
        await trx
          .updateTable("pois")
          .set({ name: "Toilets (B2)" })
          .where("id", "=", POI.funanToilets)
          .execute();
        const inside = await buildSnapshot(trx);
        expect(feature(inside.indoor.features, "poi", POI.funanToilets).properties.name).toBe(
          "Toilets (B2)",
        );
        expect(inside.snapshotSha256).not.toBe(before.snapshotSha256);
        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });
    expect((await buildSnapshot(kysely())).snapshotSha256).toBe(before.snapshotSha256);
  });
});

class Rollback extends Error {}

describe("indoor.json", () => {
  test("has every feature, in type order then by id", async () => {
    const { indoor } = await buildSnapshot(kysely());
    const counts = Object.fromEntries(
      ["venue", "level", "space", "node", "edge", "poi", "street_connector"].map((type) => [
        type,
        indoor.features.filter((f) => f.properties.feature_type === type).length,
      ]),
    );
    expect(counts).toEqual({
      venue: 3,
      level: 4,
      space: 6,
      node: 14,
      edge: 13,
      poi: 3,
      street_connector: 3,
    });
  });

  test("members and properties are in the order the schema lists them", async () => {
    const { indoor, street } = await buildSnapshot(kysely());
    expect(Object.keys(indoor)).toEqual(["type", "schema_version", "features"]);
    expect(Object.keys(street)).toEqual(["type", "schema_version", "source", "features"]);
    const schema = inlineSchema(`snapshot/${SNAPSHOT_SCHEMA_FILES["indoor.json"]}`) as {
      properties: { features: { items: { oneOf: { properties: Record<string, unknown> }[] } } };
    };
    const order = new Map(
      schema.properties.features.items.oneOf.map((branch) => {
        const properties = branch.properties["properties"] as {
          properties: Record<string, { const?: string }>;
        };
        return [
          String(properties.properties["feature_type"]?.const),
          {
            feature: Object.keys(branch.properties),
            properties: Object.keys(properties.properties),
          },
        ];
      }),
    );
    for (const f of indoor.features) {
      const expected = order.get(f.properties.feature_type);
      expect(Object.keys(f)).toEqual(expected?.feature);
      expect(Object.keys(f.properties)).toEqual(expected?.properties);
    }
  });

  test("an edge stored the other way round is turned round, ends exactly on its nodes", async () => {
    const { indoor } = await buildSnapshot(kysely());
    const at = (id: string): Position => feature(indoor.features, "node", id).geometry.coordinates;
    const walk = feature(indoor.features, "edge", EDGE.funanB2Walk);
    expect(walk.geometry.coordinates).toEqual([
      at(NODE.funanB2Escalator),
      [103.85, 1.29145],
      at(NODE.funanB2Junction),
    ]);
  });

  test("an edge stored with ends off its nodes gets the nodes' points as its ends", async () => {
    const { indoor } = await buildSnapshot(kysely());
    const stairs = feature(indoor.features, "edge", EDGE.exitBStairs);
    expect(stairs.geometry.coordinates).toEqual([
      [103.8504, 1.2917],
      [103.85052, 1.2918],
      [103.8506, 1.2919],
    ]);
  });

  test("an edge without a stored line is a straight line between its nodes", async () => {
    const { indoor } = await buildSnapshot(kysely());
    expect(feature(indoor.features, "edge", EDGE.funanEscalatorUp).geometry.coordinates).toEqual([
      [103.8498, 1.2913],
      [103.84985, 1.29135],
    ]);
    // A lift's landings at one point: still a line of two positions.
    expect(feature(indoor.features, "edge", EDGE.cityHallLift).geometry.coordinates).toEqual([
      [103.8514, 1.2925],
      [103.8514, 1.2925],
    ]);
  });

  test("ordinals come from the levels and the edges' nodes", async () => {
    const { indoor } = await buildSnapshot(kysely());
    const escalator = feature(indoor.features, "edge", EDGE.funanEscalatorUp);
    expect(escalator.properties).toMatchObject({
      from_ordinal: -2,
      to_ordinal: -1,
      level_id: null,
    });
    expect(feature(indoor.features, "node", NODE.northBridgeRoadExit).properties.ordinal).toBe(0);
    expect(feature(indoor.features, "space", SPACE.cityHallConcourse).properties.ordinal).toBe(-2);
    expect(feature(indoor.features, "poi", POI.rafflesCityFood).properties.ordinal).toBe(-1);
  });

  test("lengths and heights are rounded to 2 decimals; empty text is null", async () => {
    const { indoor } = await buildSnapshot(kysely());
    for (const f of indoor.features) {
      if ("length_m" in f.properties) {
        expect(Number(f.properties.length_m.toFixed(2))).toBe(f.properties.length_m);
      }
    }
    expect(feature(indoor.features, "level", LEVEL.cityHallConcourse).properties.elevation_m).toBe(
      -8.2,
    );
    expect(feature(indoor.features, "level", LEVEL.rafflesCityB1).properties.elevation_m).toBe(
      null,
    );
    expect(feature(indoor.features, "space", SPACE.funanB1Walkway).properties.name).toBe(null);
  });

  test("polygon rings are counterclockwise (RFC 7946)", async () => {
    const { indoor } = await buildSnapshot(kysely());
    const area = (ring: readonly Position[]) =>
      ring.slice(1).reduce((sum, [x, y], i) => {
        const [px, py] = ring[i] as Position;
        return sum + (px * y - x * py);
      }, 0);
    let rings = 0;
    for (const f of indoor.features) {
      const g = f.geometry;
      const polygons =
        g?.type === "Polygon" ? [g.coordinates] : g?.type === "MultiPolygon" ? g.coordinates : [];
      for (const [exterior] of polygons) {
        expect(area(exterior ?? [])).toBeGreaterThan(0);
        rings += 1;
      }
    }
    expect(rings).toBe(8);
  });

  test("street connectors join each exit and entrance to its nearest street node", async () => {
    const { indoor } = await buildSnapshot(kysely());
    const connectors = indoor.features.filter((f) => isIndoorFeature(f, "street_connector"));
    expect(
      Object.fromEntries(connectors.map((c) => [c.properties.node_id, c.properties.osm_node_id])),
    ).toEqual({
      [NODE.northBridgeRoadExit]: OSM_NODE.exitB,
      [NODE.cityHallExitA]: OSM_NODE.exitA,
      [NODE.rafflesCityEntrance]: OSM_NODE.rafflesCityEntrance,
    });
    for (const c of connectors) expect(c.id).toBe(streetConnectorId(c.properties.node_id));
    // Measured in SVY21: about 12 m from Exit B to the North Bridge Road footpath.
    const exitB = connectors.find((c) => c.properties.node_id === NODE.northBridgeRoadExit);
    expect(exitB?.properties.length_m).toBeCloseTo(12.4, 0);
  });
});

describe("street.json", () => {
  test("nodes by id, then edges by way and nodes; ids are numbers", async () => {
    const { street } = await buildSnapshot(kysely());
    const ids = street.features.map((f) =>
      "id" in f ? f.id : [f.properties.osm_way_id, f.properties.from_osm_node],
    );
    expect(ids).toEqual([
      ...Object.values(OSM_NODE).sort((a, b) => a - b),
      [OSM_WAY.northBridgeRoadSidewalk, OSM_NODE.exitB],
      [OSM_WAY.northBridgeRoadSidewalk, OSM_NODE.northBridgeRoad],
      [OSM_WAY.crossing, OSM_NODE.exitA],
      [OSM_WAY.coveredWalkway, OSM_NODE.stamfordRoadCrossing],
      [OSM_WAY.coveredWalkway, OSM_NODE.coveredWalkway],
      [OSM_WAY.steps, OSM_NODE.stepsTop],
    ]);
  });

  test("publishes only highway and footway of the tags; an edge stored reversed is turned round", async () => {
    const { street } = await buildSnapshot(kysely());
    const steps = street.features.find(
      (f) => !("id" in f) && f.properties.osm_way_id === OSM_WAY.steps,
    );
    expect(steps?.properties).toMatchObject({ highway: "steps", footway: null, covered: false });
    expect(steps?.geometry.coordinates).toEqual([
      [103.8505, 1.2924],
      [103.8506, 1.2922],
      [103.8507, 1.29195],
    ]);
  });
});

describe("privacy", () => {
  test("nothing private reaches either file", async () => {
    const built = await buildSnapshot(kysely());
    const files = text(built.files["indoor.json"].bytes) + text(built.files["street.json"].bytes);
    for (const secret of [
      PRIVATE.anchorId,
      PRIVATE.anchorName,
      PRIVATE.anchorPhotoUri,
      PRIVATE.operator,
      PRIVATE.permission,
      PRIVATE.zoneId,
      PRIVATE.zoneNote,
      String(PRIVATE.zoneCorner),
      String(PRIVATE.nodeElevation),
      ...PRIVATE.osmTagValues,
    ]) {
      expect(files).not.toContain(secret);
    }
    for (const key of ['"rev"', '"updated_at"', '"imported_at"', '"permission"', '"operator"']) {
      expect(files).not.toContain(key);
    }
  });
});

describe("validation", () => {
  const broken = useDatabase((d) => seedCityHall(d));
  const brokenKysely = useKysely(broken);

  test("a HEAD whose files would fail validateVersion gives SnapshotInvalidError", async () => {
    // The schema refuses an empty POI name; the database allows it.
    await broken.query("UPDATE pois SET name = '' WHERE id = $1", [POI.cityHallAtm]);
    const error = await buildSnapshot(brokenKysely()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SnapshotInvalidError);
    expect((error as SnapshotInvalidError).problems.join("\n")).toMatch(/^indoor\.json: /);
  });

  test("two street edges with the same way and nodes are refused", async () => {
    await broken.query("UPDATE pois SET name = 'ATM' WHERE id = $1", [POI.cityHallAtm]);
    await rebuildStreetConnectors(brokenKysely());
    await expect(buildSnapshot(brokenKysely())).resolves.toBeDefined();
    // Two street edges with the same way and nodes can't be told apart, so the order check fails.
    await broken.query(
      `INSERT INTO street_edges (osm_way_id, from_osm_node, to_osm_node, length_m, geom)
       SELECT osm_way_id, from_osm_node, to_osm_node, length_m, geom FROM street_edges
        WHERE osm_way_id = $1 LIMIT 1`,
      [OSM_WAY.crossing],
    );
    await expect(buildSnapshot(brokenKysely())).rejects.toThrow(SnapshotInvalidError);
  });
});
