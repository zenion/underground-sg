import { describe, expect, test } from "vitest";
import { buildFloorplan } from "../src/index.ts";
import { syntheticCorridorMesh, transform, uplCorridorMesh } from "../src/synthetic.ts";
import { expectWellFormed, insideRing } from "./helpers.ts";

// Exact element-wise equality. Vitest's toEqual walks a typed array value by value through its
// generic deep-equality code, which takes several seconds on CI for the 636k floats of the
// realistic mesh.
function sameFloats(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

// The `./synthetic` entry: the meshes the tests use, and the mapper app's on-phone benchmark.
describe("syntheticCorridorMesh", () => {
  test("is the same mesh for the same seed, and realistic is the benchmark mesh", () => {
    const a = syntheticCorridorMesh("small");
    const b = syntheticCorridorMesh("small");
    expect(sameFloats(a.triangles, b.triangles)).toBe(true);
    expect(sameFloats(syntheticCorridorMesh("small", 7).triangles, a.triangles)).toBe(false);
    expect(
      sameFloats(syntheticCorridorMesh("realistic").triangles, uplCorridorMesh().triangles),
    ).toBe(true);
  });

  test("small has about 25k triangles and plans to one outline with every pillar as a hole", () => {
    const mesh = syntheticCorridorMesh("small");
    expect(mesh.floorTriangles + mesh.noiseTriangles).toBe(mesh.triangles.length / 6);
    expect(mesh.floorTriangles).toBeGreaterThan(20_000);
    expect(mesh.floorTriangles).toBeLessThan(30_000);

    const { polygons, stats } = buildFloorplan(mesh.triangles);
    expectWellFormed(polygons);
    expect(polygons).toHaveLength(1);
    const [polygon] = polygons;
    expect(polygon?.areaM2).toBeGreaterThan(mesh.walkableAreaM2 * 0.99);
    expect(polygon?.areaM2).toBeLessThan(mesh.walkableAreaM2 * 1.01);
    expect(Math.abs(stats.gridAngleRad - mesh.angleRad)).toBeLessThan(0.002);
    expect(stats.skippedTriangles).toBe(14);

    // Three corridor pillars, the hall pillar and the unscanned patch, in the design frame.
    const toDesign = (x: number, z: number): [number, number] => {
      const [dx, dz] = transform([x - mesh.offset[0], z - mesh.offset[1]], -mesh.angleRad);
      return [dx ?? 0, dz ?? 0];
    };
    const holes = (polygon?.holes ?? []).map((hole) => hole.map(([x, z]) => toDesign(x, z)));
    const centres: [number, number][] = [
      [7.5, 3],
      [22.5, 3],
      [33.5, 3],
      [20, 10],
      [23.75, 11.5],
    ];
    expect(centres).toHaveLength(mesh.holes);
    for (const [x, z] of centres) {
      expect(
        holes.some((hole) => insideRing(hole, x, z)),
        `a hole at (${x}, ${z})`,
      ).toBe(true);
    }
  });
});
