// Floor triangles to the observed-cell mask.

import { FloorplanWorkError } from "./errors.ts";
import type { GridFrame, RowSpans } from "./frame.ts";
import type { ScanResult, TriangleInput } from "./prepare.ts";

/**
 * The work limit: rows and cells visited, per grid cell plus per valid triangle. A scan's floor
 * triangles tile the floor, so they set each observed cell about once, and a triangle a few
 * centimetres across visits at most two rows and a few cells, so real meshes should use a small
 * fraction of this. The synthetic meshes, with overlapping duplicates, use 4% (`realistic`,
 * triangles up to 0.5 m) to 10% (`dense`, 1.1M triangles of 5 cm).
 */
export const RASTER_WORK_PER_CELL = 16;
export const RASTER_WORK_PER_TRIANGLE = 8;

/**
 * Sets every cell whose centre lies inside (or on the edge of) a valid triangle. Floor triangles
 * tile the floor, so sampling at cell centres turns the mesh into cells without double counting
 * or bias. A triangle too small to contain any cell centre sets the cell holding its centroid, so
 * every observed triangle counts. `mask` must be zeroed; `spans` is widened to cover what is set.
 *
 * Throws FloorplanWorkError once the rows and cells visited pass the work limit
 * (RASTER_WORK_PER_CELL per grid cell plus RASTER_WORK_PER_TRIANGLE per valid triangle): the
 * grid's size bounds the memory, but each triangle costs its own size, so many large overlapping
 * triangles would otherwise take minutes.
 */
export function rasterise(
  triangles: TriangleInput,
  scan: ScanResult,
  frame: GridFrame,
  mask: Uint8Array,
  spans: RowSpans,
): void {
  const width = frame.width;
  const height = frame.height;
  const inv = 1 / frame.cellSizeM;
  // Local x/z metres to grid units: gx = x * ux + z * uz + u0, gy = x * wx + z * wz + w0.
  const ux = frame.cos * inv;
  const uz = frame.sin * inv;
  const u0 = -frame.originU * inv;
  const wx = -frame.sin * inv;
  const wz = frame.cos * inv;
  const w0 = -frame.originW * inv;
  const spanMin = spans.min;
  const spanMax = spans.max;
  const valid = scan.valid;
  const limit = RASTER_WORK_PER_CELL * width * height + RASTER_WORK_PER_TRIANGLE * scan.validCount;
  let work = 0;
  let done = 0;

  for (let t = 0; t < valid.length; t++) {
    if (valid[t] === 0) continue;
    const o = t * 6;
    const ax = triangles[o]!;
    const az = triangles[o + 1]!;
    const bx = triangles[o + 2]!;
    const bz = triangles[o + 3]!;
    const cx = triangles[o + 4]!;
    const cz = triangles[o + 5]!;
    let x0 = ax * ux + az * uz + u0;
    let y0 = ax * wx + az * wz + w0;
    let x1 = bx * ux + bz * uz + u0;
    let y1 = bx * wx + bz * wz + w0;
    let x2 = cx * ux + cz * uz + u0;
    let y2 = cx * wx + cz * wz + w0;
    // Sort the vertices by y.
    let swap: number;
    if (y1 < y0) {
      swap = x0;
      x0 = x1;
      x1 = swap;
      swap = y0;
      y0 = y1;
      y1 = swap;
    }
    if (y2 < y1) {
      swap = x1;
      x1 = x2;
      x2 = swap;
      swap = y1;
      y1 = y2;
      y2 = swap;
      if (y1 < y0) {
        swap = x0;
        x0 = x1;
        x1 = swap;
        swap = y0;
        y0 = y1;
        y1 = swap;
      }
    }

    let marked = false;
    if (y2 > y0) {
      let row = Math.ceil(y0 - 0.5);
      if (row < 0) row = 0;
      let lastRow = Math.floor(y2 - 0.5);
      if (lastRow > height - 1) lastRow = height - 1;
      const slopeLong = (x2 - x0) / (y2 - y0);
      const slopeTop = y1 > y0 ? (x1 - x0) / (y1 - y0) : 0;
      const slopeBottom = y2 > y1 ? (x2 - x1) / (y2 - y1) : 0;
      if (lastRow >= row) work += lastRow - row + 1;
      for (; row <= lastRow; row++) {
        const yc = row + 0.5;
        const xa = x0 + (yc - y0) * slopeLong;
        const xb =
          y1 > y0 && (yc < y1 || y2 <= y1)
            ? x0 + (yc - y0) * slopeTop
            : x1 + (yc - y1) * slopeBottom;
        let first: number;
        let last: number;
        if (xa < xb) {
          first = Math.ceil(xa - 0.5);
          last = Math.floor(xb - 0.5);
        } else {
          first = Math.ceil(xb - 0.5);
          last = Math.floor(xa - 0.5);
        }
        if (first < 0) first = 0;
        if (last > width - 1) last = width - 1;
        if (first > last) continue;
        work += last - first + 1;
        const base = row * width;
        if (last - first < 16) {
          for (let c = first; c <= last; c++) mask[base + c] = 1;
        } else {
          mask.fill(1, base + first, base + last + 1);
        }
        if (first < spanMin[row]!) spanMin[row] = first;
        if (last > spanMax[row]!) spanMax[row] = last;
        marked = true;
      }
    }
    if (!marked) {
      const col = Math.floor((x0 + x1 + x2) / 3);
      const row = Math.floor((y0 + y1 + y2) / 3);
      if (col >= 0 && col < width && row >= 0 && row < height) {
        mask[row * width + col] = 1;
        if (col < spanMin[row]!) spanMin[row] = col;
        if (col > spanMax[row]!) spanMax[row] = col;
      }
      work++;
    }
    done++;
    if (work > limit) throw new FloorplanWorkError(limit, width * height, done, scan.validCount);
  }
}
