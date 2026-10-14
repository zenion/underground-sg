import { expect } from "vitest";
import { type FloorPolygon, type LocalRing, ringArea } from "../src/index.ts";

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

/**
 * Checks the output invariants: closed rings of at least 3 distinct points with finite
 * coordinates, outer rings counter-clockwise and holes clockwise from above, the reported area
 * matching the rings, and largest polygon first.
 */
export function expectWellFormed(polygons: readonly FloorPolygon[]): void {
  let previous = Number.POSITIVE_INFINITY;
  for (const polygon of polygons) {
    for (const ring of [polygon.outer, ...polygon.holes]) {
      expect(ring.length).toBeGreaterThanOrEqual(4);
      expect(ring[0]).toEqual(ring[ring.length - 1]);
      for (const [x, z] of ring) {
        expect(Number.isFinite(x) && Number.isFinite(z)).toBe(true);
      }
    }
    expect(ringArea(polygon.outer)).toBeGreaterThan(0);
    let area = ringArea(polygon.outer);
    for (const hole of polygon.holes) {
      expect(ringArea(hole)).toBeLessThan(0);
      area += ringArea(hole);
    }
    expect(polygon.areaM2).toBeCloseTo(area, 6);
    expect(polygon.areaM2).toBeLessThanOrEqual(previous);
    previous = polygon.areaM2;
  }
}
