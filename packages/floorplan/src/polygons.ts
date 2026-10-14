// Traced rings to polygons in the session's x/z metres.

import { type GridFrame, gridToLocalPoint } from "./frame.ts";
import { flatRingArea, reverseRing, simplifyRing } from "./simplify.ts";
import type { TracedRing } from "./trace.ts";

/** A point in the session's horizontal plane: ARKit x and z, in metres. */
export type LocalPoint = [x: number, z: number];

/** A closed ring: the last point repeats the first, as in GeoJSON. */
export type LocalRing = LocalPoint[];

export interface FloorPolygon {
  /** Counter-clockwise as seen from above (ringArea > 0). */
  readonly outer: LocalRing;
  /** Clockwise as seen from above (ringArea < 0), largest first. */
  readonly holes: LocalRing[];
  /** The outer ring's area minus the holes', in m². */
  readonly areaM2: number;
}

export interface AssembleOptions {
  /** Douglas-Peucker tolerance in metres. */
  readonly toleranceM: number;
  /** Drop polygons whose area (outer minus holes) is below this, in m². */
  readonly minPolygonAreaM2: number;
  /** Fill holes smaller than this, in m². */
  readonly minHoleAreaM2: number;
}

export interface Assembled {
  readonly polygons: FloorPolygon[];
  /** Vertices in the polygons' rings, not counting the repeated closing points. */
  readonly vertices: number;
}

interface SimplifiedRing {
  readonly coords: number[];
  readonly areaCells: number;
}

/**
 * Simplifies each ring, enforces the orientation (outer rings counter-clockwise from above, holes
 * clockwise; tracing already produces that, and it is checked again after simplification), pairs
 * holes with the outer ring of the same area label, applies the area filters and converts to
 * local metres. Polygons come largest first.
 */
export function assemblePolygons(
  rings: readonly TracedRing[],
  frame: GridFrame,
  options: AssembleOptions,
): Assembled {
  const cell = frame.cellSizeM;
  const cellArea = cell * cell;
  const toleranceCells = options.toleranceM / cell;
  const outers = new Map<number, SimplifiedRing>();
  const holes = new Map<number, SimplifiedRing[]>();
  for (const ring of rings) {
    const coords = simplifyRing(ring.coords, toleranceCells);
    if (coords.length < 6) continue;
    let areaCells = flatRingArea(coords);
    if (areaCells === 0) continue;
    if (ring.hole === areaCells > 0) {
      reverseRing(coords);
      areaCells = -areaCells;
    }
    if (ring.hole) {
      if (-areaCells * cellArea < options.minHoleAreaM2) continue;
      const list = holes.get(ring.label);
      if (list === undefined) holes.set(ring.label, [{ coords, areaCells }]);
      else list.push({ coords, areaCells });
    } else {
      outers.set(ring.label, { coords, areaCells });
    }
  }

  const polygons: FloorPolygon[] = [];
  let vertices = 0;
  for (const [label, outer] of outers) {
    const inner = holes.get(label) ?? [];
    let areaCells = outer.areaCells;
    for (const hole of inner) areaCells += hole.areaCells;
    const areaM2 = areaCells * cellArea;
    if (areaM2 < options.minPolygonAreaM2) continue;
    inner.sort((a, b) => a.areaCells - b.areaCells);
    vertices += outer.coords.length / 2;
    for (const hole of inner) vertices += hole.coords.length / 2;
    polygons.push({
      outer: toLocalRing(outer.coords, frame),
      holes: inner.map((hole) => toLocalRing(hole.coords, frame)),
      areaM2,
    });
  }
  polygons.sort((a, b) => b.areaM2 - a.areaM2);
  return { polygons, vertices };
}

function toLocalRing(coords: readonly number[], frame: GridFrame): LocalRing {
  const ring: LocalRing = [];
  for (let i = 0; i < coords.length; i += 2) {
    ring.push(gridToLocalPoint(frame, coords[i]!, coords[i + 1]!));
  }
  const first = ring[0];
  if (first !== undefined) ring.push([first[0], first[1]]);
  return ring;
}

/**
 * Signed area of a local ring in m², as seen from above (looking down ARKit's y axis): positive
 * for counter-clockwise. Works on closed and open rings. Seen from above with x to the right, z
 * points down the page, so this is minus the shoelace sum taken in (x, z).
 */
export function ringArea(ring: readonly (readonly [number, number])[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!;
    const b = ring[i]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return -sum / 2;
}
