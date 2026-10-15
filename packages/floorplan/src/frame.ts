// The occupancy grid's frame and the masks' row spans.
//
// The grid may be rotated against the session's x/z axes: ARKit starts every session with an
// arbitrary heading, so a corridor can run diagonally in the session frame, where an axis-aligned
// grid would be mostly empty. The grid's axes are u (columns) and w (rows):
//
//   u = x cos(a) + z sin(a)        x = u cos(a) - w sin(a)
//   w = -x sin(a) + z cos(a)       z = u sin(a) + w cos(a)
//
// A rotation keeps the orientation of rings, so "counter-clockwise as seen from above" means the
// same thing in both frames. Cell (col, row) covers u in [originU + col * cell, + cell) and w in
// [originW + row * cell, + cell); masks are row-major, index = row * width + col.

export interface GridFrame {
  readonly cellSizeM: number;
  readonly angleRad: number;
  readonly cos: number;
  readonly sin: number;
  readonly originU: number;
  readonly originW: number;
  readonly width: number;
  readonly height: number;
}

export function makeFrame(
  cellSizeM: number,
  angleRad: number,
  originU: number,
  originW: number,
  width: number,
  height: number,
): GridFrame {
  return {
    cellSizeM,
    angleRad,
    cos: Math.cos(angleRad),
    sin: Math.sin(angleRad),
    originU,
    originW,
    width,
    height,
  };
}

/** Grid units (cell widths from the grid origin, so a cell's centre is at col + 0.5) to local x/z metres. */
export function gridToLocalPoint(frame: GridFrame, gx: number, gy: number): [x: number, z: number] {
  const u = frame.originU + gx * frame.cellSizeM;
  const w = frame.originW + gy * frame.cellSizeM;
  return [u * frame.cos - w * frame.sin, u * frame.sin + w * frame.cos];
}

/** Marks an empty row in RowSpans.min. */
export const EMPTY_ROW_MIN = 0x7fffffff;

/**
 * For each row, a column range [min, max] outside which every cell of a mask is 0 (it may be
 * wider than the set cells, never narrower). max < 0 marks a row with no set cell. Every pass
 * over a mask works only inside the spans, so empty parts of the grid cost nothing.
 */
export interface RowSpans {
  readonly min: Int32Array;
  readonly max: Int32Array;
}

export function emptySpans(height: number): RowSpans {
  return {
    min: new Int32Array(height).fill(EMPTY_ROW_MIN),
    max: new Int32Array(height).fill(-1),
  };
}

export function clearSpans(spans: RowSpans): void {
  spans.min.fill(EMPTY_ROW_MIN);
  spans.max.fill(-1);
}

/** Exact spans of a mask, by scanning every cell. */
export function scanSpans(mask: Uint8Array, width: number, height: number): RowSpans {
  const spans = emptySpans(height);
  for (let r = 0; r < height; r++) {
    const base = r * width;
    let first = -1;
    let last = -1;
    for (let c = 0; c < width; c++) {
      if (mask[base + c] !== 0) {
        if (first < 0) first = c;
        last = c;
      }
    }
    if (first >= 0) {
      spans.min[r] = first;
      spans.max[r] = last;
    }
  }
  return spans;
}
