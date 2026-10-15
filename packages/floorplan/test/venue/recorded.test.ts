import { describe, expect, test } from "vitest";
import { buildFloorplan, CELL_BRIDGED, CELL_HOLE, traceCoverage } from "../../src/index.ts";
import { expectWellFormed } from "../helpers.ts";
import { FIXTURE_DIR, fixtureFiles, readFloorTriangles } from "./fixtures.ts";

// Runs the pipeline on every mesh recorded in a venue, when there are any (`pnpm test:venue`).
// It checks the output's invariants and prints the timings, which feed the README and the
// on-phone benchmark (backlog: "Floor-plan benchmark on the phone").

const files = fixtureFiles();

describe("recorded meshes", () => {
  if (files.length === 0) {
    test.skip(`none in ${FIXTURE_DIR}`, () => {});
    return;
  }
  for (const name of files) {
    test(name, () => {
      const triangles = readFloorTriangles(name);
      expect(triangles.length).toBeGreaterThan(0);
      buildFloorplan(triangles);
      const { polygons, coverage, stats } = buildFloorplan(triangles);
      console.log(
        `${name}: ${stats.triangles} triangles (${stats.skippedTriangles} skipped), grid ` +
          `${stats.gridWidth} x ${stats.gridHeight} at ${((stats.gridAngleRad * 180) / Math.PI).toFixed(1)}°, ` +
          `${stats.polygons} polygons, ${stats.holes} holes, ${stats.vertices} vertices, ` +
          `${(stats.walkableCells / 100).toFixed(1)} m² walkable, ` +
          `${((stats.bridgedCells + stats.holeCells) / 100).toFixed(1)} m² of gaps; ` +
          `ms ${JSON.stringify(stats.timingsMs, (_, v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v))}`,
      );
      expectWellFormed(polygons);
      expect(polygons.length).toBeGreaterThan(0);
      expect(stats.observedCells).toBeGreaterThan(0);
      expectWellFormed(traceCoverage(coverage, [CELL_BRIDGED, CELL_HOLE]));
    });
  }
});
