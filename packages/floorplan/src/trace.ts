// Marching squares: the mask's outlines as closed rings.
//
// Mask values sit at cell centres. Each 2x2 block of centres (a "square", named by its top-left
// cell) gets a case from its corners, and contour vertices sit halfway along the edges between a
// set and an unset centre, which is on the cells' shared side. The tracer walks each outline with
// set cells on its left as seen from above (rows run down the page, as z does when the session is
// seen from above with x to the right), so outer rings come out counter-clockwise and holes
// clockwise. Saddles keep diagonal set cells apart, matching the 4-connected labels.
//
// Square sides: 0 top, 1 right, 2 bottom, 3 left. The top side of square (r, c) is the edge
// between cells (r, c) and (r, c + 1), its left side the edge between (r, c) and (r + 1, c).

import type { RowSpans } from "./frame.ts";

const TOP = 0;
const RIGHT = 1;
const BOTTOM = 2;
const LEFT = 3;

/** EXIT[case * 4 + entry side] = exit side, or -1. Case bits: top-left 8, top-right 4, bottom-right 2, bottom-left 1. */
const EXIT = new Int8Array(64).fill(-1);
function segment(squareCase: number, from: number, to: number): void {
  EXIT[squareCase * 4 + from] = to;
}
segment(1, BOTTOM, LEFT);
segment(2, RIGHT, BOTTOM);
segment(3, RIGHT, LEFT);
segment(4, TOP, RIGHT);
segment(5, TOP, RIGHT);
segment(5, BOTTOM, LEFT);
segment(6, TOP, BOTTOM);
segment(7, TOP, LEFT);
segment(8, LEFT, TOP);
segment(9, BOTTOM, TOP);
segment(10, LEFT, TOP);
segment(10, RIGHT, BOTTOM);
segment(11, RIGHT, TOP);
segment(12, LEFT, RIGHT);
segment(13, BOTTOM, RIGHT);
segment(14, LEFT, BOTTOM);

export interface TracedRing {
  /** Vertices in grid units as x0, y0, x1, y1, …, not repeating the first; no collinear runs. */
  readonly coords: number[];
  /** A hole (clockwise) rather than an outer ring (counter-clockwise). */
  readonly hole: boolean;
  /** Label of the walkable area the ring bounds. */
  readonly label: number;
  /**
   * Index of the cell to the right of the ring's first vertex: the area's first cell for an outer
   * ring, and a cell inside the hole for a hole.
   */
  readonly eastCell: number;
}

/**
 * Traces every outline of `mask`. `visited` (zeroed, one byte per cell) records the contour
 * vertices already used: bit 1 for the edge to the right of a cell, bit 2 for the edge below it.
 * Set cells must not touch the grid's edge.
 *
 * Rows are scanned top to bottom and each row's edges left to right, so a ring is first met at
 * its topmost row, leftmost crossing. For an outer ring the set cell there is on the right; for a
 * hole it is on the left (an island inside the hole starts lower down). That classifies each ring
 * and names its area without any point-in-polygon tests.
 */
export function traceRings(
  mask: Uint8Array,
  spans: RowSpans,
  width: number,
  height: number,
  labels: Int32Array,
  visited: Uint8Array,
): TracedRing[] {
  const rings: TracedRing[] = [];
  const maxSteps = 4 * width * height + 8;
  for (let r = 1; r < height - 1; r++) {
    if (spans.max[r]! < 0) continue;
    const base = r * width;
    // Crossings in this row lie between columns min - 1 and max + 1.
    for (let c = spans.min[r]! - 1, last = spans.max[r]!; c <= last; c++) {
      const i = base + c;
      const west = mask[i]!;
      if (west === mask[i + 1] || (visited[i]! & 1) !== 0) continue;
      // Start on the edge between (r, c) and (r, c + 1). With the set cell to the west the
      // outline heads up, into square (r - 1, c) through its bottom; otherwise down, into
      // square (r, c) through its top.
      const hole = west !== 0;
      const coords: number[] = [c + 1, r + 0.5];
      visited[i] = visited[i]! | 1;
      let row = hole ? r - 1 : r;
      let col = c;
      let entry = hole ? BOTTOM : TOP;
      for (let step = 0; ; step++) {
        if (step > maxSteps) throw new Error("floorplan: contour did not close (internal error)");
        const s = row * width + col;
        const squareCase =
          (mask[s]! << 3) | (mask[s + 1]! << 2) | (mask[s + width + 1]! << 1) | mask[s + width]!;
        const exit = EXIT[squareCase * 4 + entry]!;
        let edge: number;
        let bit: number;
        let x: number;
        let y: number;
        if (exit === TOP) {
          edge = s;
          bit = 1;
          x = col + 1;
          y = row + 0.5;
          row--;
          entry = BOTTOM;
        } else if (exit === RIGHT) {
          edge = s + 1;
          bit = 2;
          x = col + 1.5;
          y = row + 1;
          col++;
          entry = LEFT;
        } else if (exit === BOTTOM) {
          edge = s + width;
          bit = 1;
          x = col + 1;
          y = row + 1.5;
          row++;
          entry = TOP;
        } else if (exit === LEFT) {
          edge = s;
          bit = 2;
          x = col + 0.5;
          y = row + 1;
          col--;
          entry = RIGHT;
        } else {
          throw new Error("floorplan: broken contour (internal error)");
        }
        // Each vertex belongs to one ring, so the first visited one is the start.
        if ((visited[edge]! & bit) !== 0) break;
        visited[edge] = visited[edge]! | bit;
        pushVertex(coords, x, y);
      }
      rings.push({ coords, hole, label: labels[hole ? i : i + 1]!, eastCell: i + 1 });
    }
  }
  return rings;
}

/** Appends a vertex, replacing the last one when it is the middle of a straight run. */
function pushVertex(coords: number[], x: number, y: number): void {
  const n = coords.length;
  if (n >= 4) {
    const px = coords[n - 2]!;
    const py = coords[n - 1]!;
    const dx1 = px - coords[n - 4]!;
    const dy1 = py - coords[n - 3]!;
    const dx2 = x - px;
    const dy2 = y - py;
    // Coordinates are multiples of 0.5, so this test is exact.
    if (dx1 * dy2 === dy1 * dx2 && dx1 * dx2 + dy1 * dy2 > 0) {
      coords[n - 2] = x;
      coords[n - 1] = y;
      return;
    }
  }
  coords.push(x, y);
}
