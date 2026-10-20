import { type FloorPolygon, ringArea } from "../src/index.ts";

// Assertions that print no values. The venue tests run on meshes recorded in a venue, and their
// output may reach an AI agent (CLAUDE.md: aggregate results only), so a failure names the file
// and the item, never a coordinate or an area. Vitest's matchers print both sides of a failed
// comparison, so venue files use these instead (test/value-free.test.ts checks that). This file
// imports nothing from Vitest: a failure is a plain Error with the message.

export class CheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckError";
  }
}

/** Throws a CheckError with `message` unless `condition` holds. The message must hold no values. */
export function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new CheckError(message);
}

/**
 * Checks the output invariants: closed rings of at least 3 distinct points with finite
 * coordinates, outer rings counter-clockwise and holes clockwise from above, the reported area
 * matching the rings, and largest polygon first. `what` names the output in messages, for example
 * "station.ply polygons".
 */
export function checkWellFormed(polygons: readonly FloorPolygon[], what: string): void {
  let previous = Number.POSITIVE_INFINITY;
  polygons.forEach((polygon, p) => {
    const rings = [polygon.outer, ...polygon.holes];
    rings.forEach((ring, r) => {
      const item = `${what}: ${r === 0 ? "outer ring" : `hole ${r - 1}`} of polygon ${p}`;
      check(ring.length >= 4, `${item} has fewer than 4 points`);
      check(
        ring.every(([x, z]) => Number.isFinite(x) && Number.isFinite(z)),
        `${item} has a non-finite coordinate`,
      );
      const first = ring[0];
      const last = ring[ring.length - 1];
      check(
        first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1],
        `${item} is not closed`,
      );
    });
    let area = ringArea(polygon.outer);
    check(area > 0, `${what}: outer ring of polygon ${p} is not counter-clockwise`);
    polygon.holes.forEach((hole, h) => {
      const holeArea = ringArea(hole);
      check(holeArea < 0, `${what}: hole ${h} of polygon ${p} is not clockwise`);
      area += holeArea;
    });
    // areaM2 comes from the grid's coordinates, before the rotation into x/z: allow rounding.
    check(
      Math.abs(polygon.areaM2 - area) < 5e-7,
      `${what}: areaM2 of polygon ${p} doesn't match its rings`,
    );
    check(polygon.areaM2 <= previous, `${what}: polygon ${p} is larger than the one before it`);
    previous = polygon.areaM2;
  });
}
