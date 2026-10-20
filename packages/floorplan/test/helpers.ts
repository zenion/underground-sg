import type { FloorPolygon, LocalRing } from "../src/index.ts";
import { checkWellFormed } from "./check.ts";

/** Even-odd point-in-ring test. */
export function insideRing(ring: LocalRing, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i] as [number, number];
    const [xj, zj] = ring[j] as [number, number];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the polygon's outer ring and outside its holes. */
export function insidePolygon(polygon: FloorPolygon, x: number, z: number): boolean {
  return insideRing(polygon.outer, x, z) && !polygon.holes.some((hole) => insideRing(hole, x, z));
}

export function bounds(rings: readonly LocalRing[]): [number, number, number, number] {
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const ring of rings) {
    for (const [x, z] of ring) {
      minX = Math.min(minX, x);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxZ = Math.max(maxZ, z);
    }
  }
  return [minX, minZ, maxX, maxZ];
}

/** The output invariants, the same check as the venue tests' (test/check.ts). */
export function expectWellFormed(polygons: readonly FloorPolygon[]): void {
  checkWellFormed(polygons, "output");
}
