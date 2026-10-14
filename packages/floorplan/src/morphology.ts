// Morphological close with a disc: dilate, then erode by the same disc.
//
// The disc is the set of cell offsets (dx, dy) with dx² + dy² <= r², r in cells. It is split into
// one horizontal run per row offset dy, of half-width hw[|dy|] = floor(sqrt(r² - dy²)). Each pass
// first records, per cell, the distance along its row to the nearest set cell (dilate) or unset
// cell (erode), capped at R + 1; a cell then needs only one comparison per row offset, so the cost
// is about (2R + 1) operations per cell inside the spans, whatever the disc's area.

import { clearSpans, EMPTY_ROW_MIN, type RowSpans } from "./frame.ts";

/** Half-width of the disc's run at each row offset 0..R. */
export function discHalfWidths(radiusCells: number): Int32Array {
  const reach = Math.floor(radiusCells + 1e-9);
  const halfWidths = new Int32Array(reach + 1);
  for (let dy = 0; dy <= reach; dy++) {
    halfWidths[dy] = Math.floor(Math.sqrt(Math.max(0, radiusCells * radiusCells - dy * dy)) + 1e-9);
  }
  return halfWidths;
}

export interface CloseBuffers {
  /** The dilated mask, and its spans. */
  readonly dilated: Uint8Array;
  readonly dilatedSpans: RowSpans;
  /** Per-cell run distances, capped at R + 1 (so R must be below 255). */
  readonly distance: Uint8Array;
}

/**
 * Closes `source` into `out` (zeroed here) and returns the number of set cells. Closing bridges
 * gaps up to about 2r wide and fills holes narrower than that; it never removes a set cell. With
 * r < 1 cell it copies. Every set cell of `source` must be more than R cells from the grid's
 * edge, which the grid's padding guarantees.
 */
export function closeMask(
  source: Uint8Array,
  sourceSpans: RowSpans,
  width: number,
  height: number,
  radiusCells: number,
  buffers: CloseBuffers,
  out: Uint8Array,
  outSpans: RowSpans,
): number {
  const halfWidths = discHalfWidths(radiusCells);
  if (halfWidths.length < 2) {
    out.set(source);
    outSpans.min.set(sourceSpans.min);
    outSpans.max.set(sourceSpans.max);
    let count = 0;
    for (let r = 0; r < height; r++) {
      const last = sourceSpans.max[r]!;
      for (let i = r * width + sourceSpans.min[r]!, end = r * width + last; i <= end; i++) {
        count += out[i]!;
      }
    }
    return count;
  }
  dilate(
    source,
    sourceSpans,
    width,
    height,
    halfWidths,
    buffers.distance,
    buffers.dilated,
    buffers.dilatedSpans,
  );
  return erode(
    buffers.dilated,
    buffers.dilatedSpans,
    width,
    height,
    halfWidths,
    buffers.distance,
    out,
    outSpans,
  );
}

function dilate(
  source: Uint8Array,
  spans: RowSpans,
  width: number,
  height: number,
  halfWidths: Int32Array,
  distance: Uint8Array,
  out: Uint8Array,
  outSpans: RowSpans,
): void {
  const reach = halfWidths.length - 1;
  const cap = reach + 1;
  const spanMin = spans.min;
  const spanMax = spans.max;

  // Distance along the row to the nearest set cell, from both sides.
  for (let r = 0; r < height; r++) {
    if (spanMax[r]! < 0) continue;
    const base = r * width;
    const lo = base + Math.max(0, spanMin[r]! - cap);
    const hi = base + Math.min(width - 1, spanMax[r]! + cap);
    let d = cap;
    for (let i = lo; i <= hi; i++) {
      if (source[i] !== 0) d = 0;
      else if (d < cap) d++;
      distance[i] = d;
    }
    d = cap;
    for (let i = hi; i >= lo; i--) {
      if (source[i] !== 0) d = 0;
      else if (d < cap) d++;
      if (d < distance[i]!) distance[i] = d;
    }
  }

  out.fill(0);
  clearSpans(outSpans);
  for (let r = 0; r < height; r++) {
    const base = r * width;
    let rowMin = EMPTY_ROW_MIN;
    let rowMax = -1;
    const fromRow = Math.max(0, r - reach);
    const toRow = Math.min(height - 1, r + reach);
    for (let rr = fromRow; rr <= toRow; rr++) {
      if (spanMax[rr]! < 0) continue;
      const half = halfWidths[rr < r ? r - rr : rr - r]!;
      const lo = Math.max(0, spanMin[rr]! - half);
      const hi = Math.min(width - 1, spanMax[rr]! + half);
      const offset = (rr - r) * width;
      for (let i = base + lo, end = base + hi; i <= end; i++) {
        if (distance[i + offset]! <= half) out[i] = 1;
      }
      // The cells at lo and hi are always set: each is exactly `half` from a set cell, or
      // clamped to the grid's edge within it. So the union of the ranges is the exact span.
      if (lo < rowMin) rowMin = lo;
      if (hi > rowMax) rowMax = hi;
    }
    if (rowMax >= 0) {
      outSpans.min[r] = rowMin;
      outSpans.max[r] = rowMax;
    }
  }
}

function erode(
  source: Uint8Array,
  spans: RowSpans,
  width: number,
  height: number,
  halfWidths: Int32Array,
  distance: Uint8Array,
  out: Uint8Array,
  outSpans: RowSpans,
): number {
  const reach = halfWidths.length - 1;
  const cap = reach + 1;
  const spanMin = spans.min;
  const spanMax = spans.max;

  // Distance along the row to the nearest unset cell; cells outside the span are unset.
  for (let r = 0; r < height; r++) {
    if (spanMax[r]! < 0) continue;
    const base = r * width;
    const lo = base + spanMin[r]!;
    const hi = base + spanMax[r]!;
    let d = 0;
    for (let i = lo; i <= hi; i++) {
      if (source[i] === 0) d = 0;
      else if (d < cap) d++;
      distance[i] = d;
    }
    d = 0;
    for (let i = hi; i >= lo; i--) {
      if (source[i] === 0) d = 0;
      else if (d < cap) d++;
      if (d < distance[i]!) distance[i] = d;
    }
  }

  out.fill(0);
  clearSpans(outSpans);
  let count = 0;
  for (let r = reach; r < height - reach; r++) {
    if (spanMax[r]! < 0) continue;
    const base = r * width;
    let rowMin = EMPTY_ROW_MIN;
    let rowMax = -1;
    for (let c = spanMin[r]!, last = spanMax[r]!; c <= last; c++) {
      if (source[base + c] === 0) continue;
      let keep = true;
      for (let dy = -reach; dy <= reach; dy++) {
        const rr = r + dy;
        // An empty row has min EMPTY_ROW_MIN and max -1, so it fails the range test.
        if (
          c < spanMin[rr]! ||
          c > spanMax[rr]! ||
          distance[rr * width + c]! <= halfWidths[dy < 0 ? -dy : dy]!
        ) {
          keep = false;
          break;
        }
      }
      if (keep) {
        out[base + c] = 1;
        count++;
        if (c < rowMin) rowMin = c;
        rowMax = c;
      }
    }
    if (rowMax >= 0) {
      outSpans.min[r] = rowMin;
      outSpans.max[r] = rowMax;
    }
  }
  return count;
}
