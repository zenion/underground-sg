// Connected walkable areas: labelling and removal of tiny islands.
//
// Walkable cells connect through their 4 edge neighbours, never through a corner alone. The
// contour tracer resolves its saddle cases the same way, so each traced outline bounds exactly
// one labelled area.

import type { RowSpans } from "./frame.ts";

export interface ComponentStats {
  /** Areas labelled, including removed ones. */
  readonly components: number;
  readonly removed: number;
  readonly removedCells: number;
}

/**
 * Labels the 4-connected areas of `mask` with 1, 2, … in `labels` (which must be zeroed) and
 * clears the areas smaller than `minCells` from `mask` (their cells keep their label). `queue`
 * needs room for the largest area; the mask's cell count is always enough. Set cells must not
 * touch the grid's edge.
 */
export function labelComponents(
  mask: Uint8Array,
  spans: RowSpans,
  width: number,
  height: number,
  minCells: number,
  labels: Int32Array,
  queue: Int32Array,
): ComponentStats {
  let next = 0;
  let removed = 0;
  let removedCells = 0;
  for (let r = 0; r < height; r++) {
    const last = r * width + spans.max[r]!;
    for (let start = r * width + spans.min[r]!; start <= last; start++) {
      if (mask[start] === 0 || labels[start] !== 0) continue;
      const label = ++next;
      labels[start] = label;
      queue[0] = start;
      let head = 0;
      let tail = 1;
      while (head < tail) {
        const i = queue[head++]!;
        let j = i - 1;
        if (mask[j] !== 0 && labels[j] === 0) {
          labels[j] = label;
          queue[tail++] = j;
        }
        j = i + 1;
        if (mask[j] !== 0 && labels[j] === 0) {
          labels[j] = label;
          queue[tail++] = j;
        }
        j = i - width;
        if (mask[j] !== 0 && labels[j] === 0) {
          labels[j] = label;
          queue[tail++] = j;
        }
        j = i + width;
        if (mask[j] !== 0 && labels[j] === 0) {
          labels[j] = label;
          queue[tail++] = j;
        }
      }
      if (tail < minCells) {
        for (let q = 0; q < tail; q++) mask[queue[q]!] = 0;
        removed++;
        removedCells += tail;
      }
    }
  }
  return { components: next, removed, removedCells };
}
