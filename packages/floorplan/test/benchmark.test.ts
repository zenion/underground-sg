import { describe, expect, test } from "vitest";
import { buildFloorplan, CELL_HOLE, type FloorplanResult, traceCoverage } from "../src/index.ts";
import {
  type CorridorMesh,
  syntheticCorridorMesh,
  transform,
  uplCorridorMesh,
} from "../src/synthetic.ts";
import { expectWellFormed, insideRing } from "./helpers.ts";

// The realistic synthetic mesh from the backlog's benchmark: a 150 m x 6 m UPL corridor with side
// halls and pillars, about 100k floor triangles of uneven size, with noise and gaps; and its dense
// variant, about 1.1M triangles of 5 cm on a lattice in the session's axes. Timings for the README
// come from `pnpm --filter @usg/floorplan bench`; these tests check the results and keep a
// generous time bound, so a slow CI runner never fails them but a pathological regression
// (seconds in Node) does.
const TIME_BOUND_MS = 5_000;

/** Every pillar and the unscanned patch, in the design frame. */
const HOLE_CENTRES: [number, number][] = [
  ...Array.from({ length: 10 }, (_, k): [number, number] => [7.5 + 15 * k, 3]),
  [25.5, 11.5],
  [30.5, 11.5],
  [118, 10],
  [74.75, -6.5],
];

/** Builds the plan twice (the first warms up the JIT) and checks what both meshes share. */
function planCorridor(mesh: CorridorMesh): FloorplanResult {
  buildFloorplan(mesh.triangles);
  const result = buildFloorplan(mesh.triangles);
  const { polygons, stats, coverage } = result;
  console.log(
    `floorplan: ${stats.triangles} triangles, grid ${stats.gridWidth} x ${stats.gridHeight}, ` +
      `${stats.vertices} vertices; ms ${JSON.stringify(stats.timingsMs, (_, v) =>
        typeof v === "number" ? Math.round(v * 10) / 10 : v,
      )}`,
  );
  expect(stats.timingsMs.total).toBeLessThan(TIME_BOUND_MS);

  expectWellFormed(polygons);
  expect(polygons).toHaveLength(1);
  // The grid lines up with the corridor.
  expect(Math.abs(stats.gridAngleRad - mesh.angleRad)).toBeLessThan(0.002);
  // Every pillar and the unscanned patch is a hole (the close rounds their corners), plus
  // possibly holes where random dropouts cluster.
  const toDesign = (x: number, z: number): [number, number] => {
    const [dx, dz] = transform([x - mesh.offset[0], z - mesh.offset[1]], -mesh.angleRad);
    return [dx ?? 0, dz ?? 0];
  };
  const designHoles = (polygons[0]?.holes ?? []).map((hole) =>
    hole.map(([x, z]) => toDesign(x, z)),
  );
  expect(HOLE_CENTRES).toHaveLength(mesh.holes);
  for (const [x, z] of HOLE_CENTRES) {
    expect(
      designHoles.some((hole) => insideRing(hole, x, z)),
      `a hole at (${x}, ${z})`,
    ).toBe(true);
  }
  // Strays beyond the walls are removed as islands, and the slivers skipped.
  expect(stats.removedIslands).toBeGreaterThan(500);
  expect(stats.skippedTriangles).toBe(50);
  // The gap outlines for the overlay include every hole.
  const gaps = traceCoverage(coverage, [CELL_HOLE], { minAreaM2: 0.5 });
  expect(gaps.length).toBe(mesh.holes);
  return result;
}

describe("realistic UPL corridor", () => {
  const mesh = uplCorridorMesh();

  test("has about 100k triangles", () => {
    expect(mesh.floorTriangles + mesh.noiseTriangles).toBe(mesh.triangles.length / 6);
    expect(mesh.floorTriangles).toBeGreaterThan(90_000);
    expect(mesh.floorTriangles).toBeLessThan(120_000);
  });

  test("gives one outline with every pillar and the patch as holes, in good time", () => {
    const { polygons, stats } = planCorridor(mesh);
    const [polygon] = polygons;
    expect(polygon?.areaM2).toBeGreaterThan(mesh.walkableAreaM2 * 0.99);
    expect(polygon?.areaM2).toBeLessThan(mesh.walkableAreaM2 * 1.01);
    expect(stats.holeCells * 0.01).toBeGreaterThan(mesh.holeAreaM2 * 0.8);
    expect(stats.holeCells * 0.01).toBeLessThan(mesh.holeAreaM2 * 1.1);
    // The strips and dropouts are bridged.
    expect(stats.bridgedCells * 0.01).toBeGreaterThan(3);
  });
});

describe("dense UPL corridor", () => {
  const mesh = syntheticCorridorMesh("dense");

  test("has about 1.1M triangles", () => {
    expect(mesh.floorTriangles + mesh.noiseTriangles).toBe(mesh.triangles.length / 6);
    expect(mesh.floorTriangles).toBeGreaterThan(1_000_000);
    expect(mesh.floorTriangles).toBeLessThan(1_200_000);
  });

  test("plans like the realistic mesh, with ragged walls", () => {
    const { polygons, stats } = planCorridor(mesh);
    // The close fills the walls' voxel steps, so the outline gains up to half a voxel all round
    // and the holes lose as much: about +1.6% of area and -30% of hole cells.
    expect(polygons[0]?.areaM2).toBeGreaterThan(mesh.walkableAreaM2);
    expect(polygons[0]?.areaM2).toBeLessThan(mesh.walkableAreaM2 * 1.03);
    expect(stats.holeCells * 0.01).toBeGreaterThan(mesh.holeAreaM2 * 0.6);
    expect(stats.holeCells * 0.01).toBeLessThan(mesh.holeAreaM2);
    // The staircase walls keep far more outline vertices than the straight ones (364).
    expect(stats.vertices).toBeGreaterThan(800);
  });
});
