import { describe, test } from "vitest";
import {
  buildFloorplan,
  CELL_BRIDGED,
  CELL_HOLE,
  type FloorplanResult,
  traceCoverage,
} from "../../src/index.ts";
import { CheckError, check, checkWellFormed } from "../check.ts";
import { FIXTURE_DIR, fixtureFiles, readFloorTriangles } from "./fixtures.ts";

// Runs the pipeline on every mesh recorded in a venue, when there are any (`pnpm test:venue`).
// It checks the output's invariants and prints counts and timings, which feed the README and the
// on-phone benchmark (backlog: "Floor-plan benchmark on the phone").
//
// Nothing here prints a value from the mesh: assertions go through check() (test/check.ts), whose
// messages name only the file and the item, and the log holds counts, areas and timings, not the
// grid angle, which is the corridor's heading in the session frame. test/value-free.test.ts fails
// if a file in this project uses Vitest's matchers or snapshots.

const files = fixtureFiles();

/** Runs the pipeline, replacing its error with one that names only the file and the error's code. */
function build(name: string, triangles: Float32Array): FloorplanResult {
  try {
    return buildFloorplan(triangles);
  } catch (error) {
    // FloorplanExtentError's message and fields hold the mesh's extent.
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : error instanceof Error
          ? error.name
          : "a non-Error";
    throw new CheckError(`${name}: buildFloorplan threw ${code}`);
  }
}

describe("recorded meshes", () => {
  if (files.length === 0) {
    test.skip(`none in ${FIXTURE_DIR}`, () => {});
    return;
  }
  for (const name of files) {
    test(name, () => {
      const triangles = readFloorTriangles(name);
      check(triangles.length > 0, `${name}: no floor triangles`);
      // The first run warms up the JIT, so the timings printed are the second run's.
      build(name, triangles);
      const { polygons, coverage, stats } = build(name, triangles);
      console.log(
        `${name}: ${stats.triangles} triangles (${stats.skippedTriangles} skipped), grid ` +
          `${stats.gridWidth} x ${stats.gridHeight} cells, ` +
          `${stats.polygons} polygons, ${stats.holes} holes, ${stats.vertices} vertices, ` +
          `${(stats.walkableCells / 100).toFixed(1)} m² walkable, ` +
          `${((stats.bridgedCells + stats.holeCells) / 100).toFixed(1)} m² of gaps; ` +
          `ms ${JSON.stringify(stats.timingsMs, (_, v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v))}`,
      );
      checkWellFormed(polygons, `${name} polygons`);
      check(polygons.length > 0, `${name}: no polygons`);
      check(stats.observedCells > 0, `${name}: no observed cells`);
      checkWellFormed(traceCoverage(coverage, [CELL_BRIDGED, CELL_HOLE]), `${name} gaps`);
    });
  }
});
