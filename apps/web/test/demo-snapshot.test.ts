// The fixture dev server's demo snapshot must be a valid published version: each file passes
// @usg/contracts/validators (the schemas and the checks across files), latest.json's sizes and
// hashes match the files it points to, and every length_m matches the line it is drawn with.

import {
  streetConnectorId,
  validateSnapshotFile,
  validateVersion,
  verifyLatestPointer,
} from "@usg/contracts/validators";
import { describe, expect, test } from "vitest";
import {
  CONNECTOR,
  demoIndoor,
  demoPublicFiles,
  demoStreet,
  NODE,
} from "../fixtures/demo-snapshot.ts";
import { svy21Length, toSvy21 } from "./svy21.ts";

const NOW = new Date("2026-10-15T10:00:00+08:00");

function parsed(files: ReturnType<typeof demoPublicFiles>, path: string): unknown {
  const file = files.get(path);
  if (file === undefined) throw new Error(`no ${path}`);
  return JSON.parse(file.body) as unknown;
}

describe("the demo snapshot", () => {
  const files = demoPublicFiles(NOW);
  const latest = parsed(files, "latest.json") as {
    files: { indoor: { path: string }; street: { path: string } };
    demo?: boolean;
  };

  test("indoor.json and street.json are a valid version", () => {
    expect(validateVersion(demoIndoor, demoStreet).problems).toEqual([]);
  });

  test("latest.json and status.json are valid, and latest.json says demo", () => {
    expect(validateSnapshotFile("latest.json", latest).problems).toEqual([]);
    expect(validateSnapshotFile("status.json", parsed(files, "status.json")).problems).toEqual([]);
    expect(latest.demo).toBe(true);
  });

  test("latest.json's sizes and hashes match the served files", () => {
    const bytes = (path: string) => new TextEncoder().encode(files.get(path)?.body ?? "");
    const problems = verifyLatestPointer(latest as never, {
      "indoor.json": bytes(latest.files.indoor.path),
      "street.json": bytes(latest.files.street.path),
    });
    expect(problems).toEqual([]);
  });

  test("the served files are the version's two files, latest.json and status.json", () => {
    expect([...files.keys()].sort()).toEqual(
      ["latest.json", "status.json", latest.files.indoor.path, latest.files.street.path].sort(),
    );
    expect(parsed(files, latest.files.indoor.path)).toEqual(demoIndoor);
    expect(parsed(files, latest.files.street.path)).toEqual(demoStreet);
  });

  test("street connectors' ids are derived from their nodes", () => {
    expect(CONNECTOR.northBridgeRoad).toBe(streetConnectorId(NODE.northBridgeRoadExit));
    expect(CONNECTOR.stamfordRoad).toBe(streetConnectorId(NODE.stamfordRoadExit));
  });

  test("the version files don't change with the time; status.json does", () => {
    const later = demoPublicFiles(new Date(NOW.getTime() + 86_400_000));
    expect(later.get("latest.json")).toEqual(files.get("latest.json"));
    expect(later.get("status.json")).not.toEqual(files.get("status.json"));
  });
});

describe("lengths", () => {
  /** How far length_m may be from the line's length: the schemas don't compare them. */
  const TOLERANCE_M = 3;

  test("SVY21 as PostGIS projects it (ST_Transform(geom, 3414))", () => {
    expect(toSvy21([103.8333333333333, 1.366666666666667])).toEqual([
      expect.closeTo(28001.642, 3),
      expect.closeTo(38744.572, 3),
    ]);
    expect(toSvy21([103.852, 1.2925])).toEqual([
      expect.closeTo(30079.0807, 3),
      expect.closeTo(30543.6098, 3),
    ]);
  });

  test("each edge's length_m is its line's, with the climb for one between levels", () => {
    const elevation = new Map<string, number | null>();
    for (const feature of demoIndoor.features) {
      if (feature.properties.feature_type === "level") {
        elevation.set(feature.id, feature.properties.elevation_m);
      }
    }
    // A node without a level is at the street (0 m); a level without a measured height adds no climb.
    const nodeHeight = new Map<string, number | null>();
    for (const feature of demoIndoor.features) {
      if (feature.properties.feature_type === "node") {
        const level = feature.properties.level_id;
        nodeHeight.set(feature.id, level === null ? 0 : (elevation.get(level) ?? null));
      }
    }
    const checked: string[] = [];
    for (const feature of demoIndoor.features) {
      const p = feature.properties;
      if (p.feature_type !== "edge" && p.feature_type !== "street_connector") continue;
      if (feature.geometry?.type !== "LineString") throw new Error(`${feature.id} has no line`);
      const planar = svy21Length(feature.geometry.coordinates);
      let climb = 0;
      if (p.feature_type === "edge") {
        const from = nodeHeight.get(p.from_node);
        const to = nodeHeight.get(p.to_node);
        if (from !== undefined && from !== null && to !== undefined && to !== null) {
          climb = Math.abs(to - from);
        }
      }
      const expected = Math.hypot(planar, climb);
      expect(
        Math.abs(p.length_m - expected),
        `${p.feature_type} ${feature.id}: length_m ${p.length_m}, line ${expected.toFixed(2)} m`,
      ).toBeLessThanOrEqual(TOLERANCE_M);
      checked.push(feature.id);
    }
    expect(checked.length).toBeGreaterThan(10);
  });

  test("each street edge's length_m is its line's", () => {
    for (const feature of demoStreet.features) {
      if (feature.properties.feature_type !== "street_edge") continue;
      if (feature.geometry.type !== "LineString") throw new Error("a street edge has no line");
      const planar = svy21Length(feature.geometry.coordinates);
      const { osm_way_id, from_osm_node, to_osm_node, length_m } = feature.properties;
      expect(
        Math.abs(length_m - planar),
        `street edge ${osm_way_id} ${from_osm_node}-${to_osm_node}: ${length_m} vs ${planar.toFixed(2)} m`,
      ).toBeLessThanOrEqual(TOLERANCE_M);
    }
  });

  test("Exit B's stairs climb from Funan B2 to North Bridge Road in about 24 m", () => {
    const stairs = demoIndoor.features.find(
      (feature) =>
        feature.properties.feature_type === "edge" && feature.properties.kind === "stairs",
    );
    expect(stairs?.properties).toMatchObject({ to_node: NODE.northBridgeRoadExit, length_m: 24.2 });
  });
});
