// The coverage grid: what the scan observed, and the gaps worth re-walking.

import { labelComponents } from "./components.ts";
import { type GridFrame, gridToLocalPoint, makeFrame, type RowSpans, scanSpans } from "./frame.ts";
import { assemblePolygons, type FloorPolygon } from "./polygons.ts";
import { type TracedRing, traceRings } from "./trace.ts";

/** Never observed, and outside every outline. */
export const CELL_OUTSIDE = 0;
/** A floor triangle covered the cell's centre. */
export const CELL_OBSERVED = 1;
/** Never observed, but inside an outline: the close bridged it, so the preview guessed. */
export const CELL_BRIDGED = 2;
/** Never observed, and enclosed by walkable cells: a pillar, or floor the scan missed. */
export const CELL_HOLE = 3;

/**
 * One byte per cell, in the occupancy grid's frame (which may be rotated against the session's
 * x/z axes). Cell (col, row) has its centre at u = originU + (col + 0.5) * cellSizeM,
 * w = originW + (row + 0.5) * cellSizeM, and x = u cos(angleRad) - w sin(angleRad),
 * z = u sin(angleRad) + w cos(angleRad); coverageCellCenter does this. Never-observed cells inside
 * the outline (CELL_BRIDGED and CELL_HOLE) are the gaps to re-walk; traceCoverage outlines them.
 */
export interface CoverageGrid {
  readonly width: number;
  readonly height: number;
  readonly cellSizeM: number;
  readonly angleRad: number;
  readonly originU: number;
  readonly originW: number;
  /** Row-major, index = row * width + col: CELL_OUTSIDE, CELL_OBSERVED, CELL_BRIDGED or CELL_HOLE. */
  readonly cells: Uint8Array;
}

export interface CoverageCounts {
  readonly observed: number;
  readonly bridged: number;
  readonly hole: number;
}

/**
 * Turns the observed mask (0 or 1 per cell) into coverage states in place. `visited` (zeroed) is
 * scratch; `stack` needs room for every cell inside the holes.
 *
 * A never-observed, walkable cell was bridged. A never-observed, non-walkable cell is a hole cell
 * if walkable cells enclose it: those are exactly the cells inside the traced hole rings, so a
 * flood fill from each hole ring's first inner cell finds them, at a cost of the holes' area.
 * Background connects through corners (8 neighbours), the counterpart of the walkable cells'
 * 4-connectivity, and walkable cells bound every hole, so the fill never reaches the grid's edge.
 * Observed cells inside a hole (a removed island) stay observed.
 */
export function classifyCoverage(
  cells: Uint8Array,
  walkable: Uint8Array,
  spans: RowSpans,
  width: number,
  height: number,
  rings: readonly TracedRing[],
  visited: Uint8Array,
  stack: Int32Array,
): CoverageCounts {
  // Every observed or walkable cell lies inside the walkable spans (taken before island removal).
  let observed = 0;
  let bridged = 0;
  for (let r = 0; r < height; r++) {
    if (spans.max[r]! < 0) continue;
    for (let i = r * width + spans.min[r]!, last = r * width + spans.max[r]!; i <= last; i++) {
      if (cells[i] !== 0) {
        observed++;
      } else if (walkable[i] !== 0) {
        cells[i] = CELL_BRIDGED;
        bridged++;
      }
    }
  }

  let hole = 0;
  for (const ring of rings) {
    if (!ring.hole || visited[ring.eastCell] !== 0) continue;
    visited[ring.eastCell] = 1;
    stack[0] = ring.eastCell;
    let top = 1;
    while (top > 0) {
      const i = stack[--top]!;
      if (cells[i] === CELL_OUTSIDE) {
        cells[i] = CELL_HOLE;
        hole++;
      }
      for (let j = i - width - 1, row = 0; row < 3; row++, j += width - 3) {
        for (let k = 0; k < 3; k++, j++) {
          if (walkable[j] === 0 && visited[j] === 0) {
            visited[j] = 1;
            stack[top++] = j;
          }
        }
      }
    }
  }
  return { observed, bridged, hole };
}

/** The centre of a coverage cell in the session's x/z metres. */
export function coverageCellCenter(
  grid: CoverageGrid,
  col: number,
  row: number,
): [x: number, z: number] {
  return gridToLocalPoint(frameOf(grid), col + 0.5, row + 0.5);
}

export interface TraceCoverageOptions {
  /** Douglas-Peucker tolerance in metres. Default 0: only collinear vertices go. */
  readonly simplifyToleranceM?: number;
  /** Drop outlines smaller than this, in m². Default 0. */
  readonly minAreaM2?: number;
}

/**
 * Outlines the cells in the given states, as polygons in the session's x/z metres, for example
 * `traceCoverage(grid, [CELL_BRIDGED, CELL_HOLE])` for the gaps to re-walk. Convert them for the
 * map with toDisplayGeoJSON. Cells on the grid's edge are left out (they are always outside).
 */
export function traceCoverage(
  grid: CoverageGrid,
  states: readonly number[],
  options: TraceCoverageOptions = {},
): FloorPolygon[] {
  const { width, height, cells } = grid;
  if (width < 3 || height < 3) return [];
  const wanted = new Uint8Array(256);
  for (const state of states) wanted[state & 255] = 1;
  const mask = new Uint8Array(width * height);
  let count = 0;
  for (let r = 1; r < height - 1; r++) {
    for (let i = r * width + 1, last = r * width + width - 2; i <= last; i++) {
      if (wanted[cells[i]!] !== 0) {
        mask[i] = 1;
        count++;
      }
    }
  }
  if (count === 0) return [];
  const spans = scanSpans(mask, width, height);
  const labels = new Int32Array(width * height);
  labelComponents(mask, spans, width, height, 0, labels, new Int32Array(count));
  const rings = traceRings(mask, spans, width, height, labels, new Uint8Array(width * height));
  const minArea = options.minAreaM2 ?? 0;
  return assemblePolygons(rings, frameOf(grid), {
    toleranceM: options.simplifyToleranceM ?? 0,
    minPolygonAreaM2: minArea,
    minHoleAreaM2: 0,
  }).polygons;
}

function frameOf(grid: CoverageGrid): GridFrame {
  return makeFrame(
    grid.cellSizeM,
    grid.angleRad,
    grid.originU,
    grid.originW,
    grid.width,
    grid.height,
  );
}
