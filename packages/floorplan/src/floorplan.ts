// buildFloorplan: floor triangles to an approximate walkable outline and a coverage grid.

import { defaultClock } from "./clock.ts";
import { labelComponents } from "./components.ts";
import { type CoverageGrid, classifyCoverage } from "./coverage.ts";
import { emptySpans } from "./frame.ts";
import { closeMask } from "./morphology.ts";
import { assemblePolygons, type FloorPolygon } from "./polygons.ts";
import { chooseGridAngle, frameFor, scanTriangles, type TriangleInput } from "./prepare.ts";
import { rasterise } from "./rasterise.ts";
import { traceRings } from "./trace.ts";

export interface FloorplanOptions {
  /** Grid cell size in metres. Default 0.1. */
  readonly cellSizeM?: number;
  /**
   * Radius of the disc for the morphological close, in metres. The close bridges gaps up to
   * about twice this wide (a person, a reflection, a missed patch) and fills holes narrower than
   * that. Default 0.2, so gaps up to about 0.4 m are bridged; 0 turns the close off. At most 254
   * cells.
   */
  readonly closeRadiusM?: number;
  /** Walkable areas smaller than this (m²) are removed before tracing. Default 0.5; 0 keeps all. */
  readonly minIslandAreaM2?: number;
  /**
   * Douglas-Peucker tolerance in metres. Default 0.04, under half a cell: the traced outline cuts
   * each square corner by half a cell, and a tolerance of half a cell or more lets the
   * simplification drop one of those two vertices and skew the wall beside it. 0 drops only
   * collinear vertices.
   */
  readonly simplifyToleranceM?: number;
  /** Polygons whose area (outer ring minus holes) is below this (m²) are dropped. Default 0.5. */
  readonly minPolygonAreaM2?: number;
  /** Holes smaller than this (m²) are left out of the polygons; the coverage grid still shows them. Default 0.1. */
  readonly minHoleAreaM2?: number;
  /**
   * The grid's rotation in radians (grid u = x cos + z sin), or "auto" (the default) to line the
   * grid up with the walls: a tight grid for a corridor in any direction, and straight outlines.
   * A caller that knows a wall's direction, such as the start anchor's door facing, can pass it.
   */
  readonly gridAngleRad?: number | "auto";
  /**
   * The most grid cells allowed; more throws FloorplanExtentError. Default 4,000,000 (40,000 m² at
   * 0.1 m). It bounds memory; rasterising also stops with FloorplanWorkError after 16 row and cell
   * visits per grid cell (plus 8 per triangle), which bounds the time.
   */
  readonly maxCells?: number;
  /** Clock for the stage timings, in milliseconds. Default performance.now(), or Date.now() without it. */
  readonly now?: () => number;
}

export const DEFAULT_FLOORPLAN_OPTIONS = {
  cellSizeM: 0.1,
  closeRadiusM: 0.2,
  minIslandAreaM2: 0.5,
  simplifyToleranceM: 0.04,
  minPolygonAreaM2: 0.5,
  minHoleAreaM2: 0.1,
  gridAngleRad: "auto",
  maxCells: 4_000_000,
} as const satisfies Required<Omit<FloorplanOptions, "now">>;

/** Milliseconds spent in each stage. */
export interface StageTimings {
  /** Input checks, the grid angle and the extent. */
  readonly prepare: number;
  readonly rasterise: number;
  readonly close: number;
  /** Labelling the walkable areas and removing tiny islands. */
  readonly islands: number;
  /** Marching squares. */
  readonly trace: number;
  /** Douglas-Peucker, orientation, area filters and conversion to local metres. */
  readonly simplify: number;
  readonly coverage: number;
  readonly total: number;
}

export interface FloorplanStats {
  /** Triangles in the input, and those skipped as degenerate or non-finite. */
  readonly triangles: number;
  readonly skippedTriangles: number;
  readonly gridAngleRad: number;
  readonly gridWidth: number;
  readonly gridHeight: number;
  readonly observedCells: number;
  /** Cells in the walkable areas after the close and island removal. */
  readonly walkableCells: number;
  readonly bridgedCells: number;
  readonly holeCells: number;
  readonly removedIslands: number;
  /** Rings traced, and the vertices in the output polygons. */
  readonly rings: number;
  readonly vertices: number;
  readonly polygons: number;
  readonly holes: number;
  readonly timingsMs: StageTimings;
}

export interface FloorplanResult {
  /** Walkable outlines in the session's x/z metres, largest first. */
  readonly polygons: FloorPolygon[];
  /** What the scan observed, for the coverage overlay. */
  readonly coverage: CoverageGrid;
  readonly stats: FloorplanStats;
}

/**
 * Turns floor triangles into an approximate walkable outline: rasterise to an occupancy grid,
 * close small gaps, drop tiny islands, trace with marching squares, simplify, orient and filter.
 *
 * `triangles` holds the floor-classified triangles of the scene mesh projected onto ARKit's
 * horizontal plane: x,z pairs in metres, 3 vertices per triangle, as the capture module's
 * `floorTriangles` returns them. Polygons come back in the same x/z frame, outer rings
 * counter-clockwise and holes clockwise as seen from above (see ringArea). Degenerate and
 * non-finite triangles are skipped and counted. Throws RangeError for malformed input or options,
 * FloorplanExtentError when the triangles span more than `maxCells` cells, and FloorplanWorkError
 * when they overlap so much that rasterising them would pass the work limit (see rasterise).
 */
export function buildFloorplan(
  triangles: TriangleInput,
  options: FloorplanOptions = {},
): FloorplanResult {
  const settings = resolveOptions(options);
  const now = options.now ?? defaultClock();
  const started = now();

  const scan = scanTriangles(triangles);
  const triangleCount = triangles.length / 6;
  const skippedTriangles = triangleCount - scan.validCount;
  if (scan.validCount === 0) {
    return emptyResult(triangleCount, skippedTriangles, settings.cellSizeM, now() - started);
  }
  const cell = settings.cellSizeM;
  const radiusCells = settings.closeRadiusM / cell;
  const reach = Math.floor(radiusCells + 1e-9);
  const angle =
    settings.gridAngleRad === "auto" ? chooseGridAngle(triangles, scan) : settings.gridAngleRad;
  // Padding: the close reaches `reach` cells, and one more empty cell keeps every outline closed.
  const frame = frameFor(triangles, scan, angle, cell, reach + 2, settings.maxCells);
  const { width, height } = frame;
  const cells = width * height;
  const prepared = now();

  const observed = new Uint8Array(cells);
  const observedSpans = emptySpans(height);
  rasterise(triangles, scan, frame, observed, observedSpans);
  const rasterised = now();

  const walkable = new Uint8Array(cells);
  const walkableSpans = emptySpans(height);
  const scratch = new Uint8Array(cells);
  const distance = new Uint8Array(cells);
  const closedCells = closeMask(
    observed,
    observedSpans,
    width,
    height,
    radiusCells,
    { dilated: scratch, dilatedSpans: emptySpans(height), distance },
    walkable,
    walkableSpans,
  );
  const closed = now();

  const labels = new Int32Array(cells);
  const islands = labelComponents(
    walkable,
    walkableSpans,
    width,
    height,
    settings.minIslandAreaM2 / (cell * cell),
    labels,
    new Int32Array(Math.max(1, closedCells)),
  );
  const labelled = now();

  scratch.fill(0);
  const rings = traceRings(walkable, walkableSpans, width, height, labels, scratch);
  const traced = now();

  const assembled = assemblePolygons(rings, frame, {
    toleranceM: settings.simplifyToleranceM,
    minPolygonAreaM2: settings.minPolygonAreaM2,
    minHoleAreaM2: settings.minHoleAreaM2,
  });
  const simplified = now();

  // The labels are done with; their buffer is the flood fill's stack.
  distance.fill(0);
  const counts = classifyCoverage(
    observed,
    walkable,
    walkableSpans,
    width,
    height,
    rings,
    distance,
    labels,
  );
  const finished = now();

  let holes = 0;
  for (const polygon of assembled.polygons) holes += polygon.holes.length;
  return {
    polygons: assembled.polygons,
    coverage: {
      width,
      height,
      cellSizeM: cell,
      angleRad: frame.angleRad,
      originU: frame.originU,
      originW: frame.originW,
      cells: observed,
    },
    stats: {
      triangles: triangleCount,
      skippedTriangles,
      gridAngleRad: frame.angleRad,
      gridWidth: width,
      gridHeight: height,
      observedCells: counts.observed,
      walkableCells: closedCells - islands.removedCells,
      bridgedCells: counts.bridged,
      holeCells: counts.hole,
      removedIslands: islands.removed,
      rings: rings.length,
      vertices: assembled.vertices,
      polygons: assembled.polygons.length,
      holes,
      timingsMs: {
        prepare: prepared - started,
        rasterise: rasterised - prepared,
        close: closed - rasterised,
        islands: labelled - closed,
        trace: traced - labelled,
        simplify: simplified - traced,
        coverage: finished - simplified,
        total: finished - started,
      },
    },
  };
}

type ResolvedOptions = Required<Omit<FloorplanOptions, "now">>;

function resolveOptions(options: FloorplanOptions): ResolvedOptions {
  const resolved: ResolvedOptions = { ...DEFAULT_FLOORPLAN_OPTIONS };
  for (const key of Object.keys(DEFAULT_FLOORPLAN_OPTIONS) as (keyof ResolvedOptions)[]) {
    const value = options[key];
    if (value !== undefined) Object.assign(resolved, { [key]: value });
  }
  const nonNegative = (name: keyof ResolvedOptions, value: number): void => {
    if (!(value >= 0 && value < Number.POSITIVE_INFINITY)) {
      throw new RangeError(`floorplan option ${name} must be a finite number >= 0; got ${value}.`);
    }
  };
  if (!(resolved.cellSizeM > 0 && resolved.cellSizeM < Number.POSITIVE_INFINITY)) {
    throw new RangeError(`floorplan option cellSizeM must be > 0; got ${resolved.cellSizeM}.`);
  }
  nonNegative("closeRadiusM", resolved.closeRadiusM);
  if (resolved.closeRadiusM / resolved.cellSizeM >= 255) {
    throw new RangeError("floorplan option closeRadiusM must be under 255 cells.");
  }
  nonNegative("minIslandAreaM2", resolved.minIslandAreaM2);
  nonNegative("simplifyToleranceM", resolved.simplifyToleranceM);
  nonNegative("minPolygonAreaM2", resolved.minPolygonAreaM2);
  nonNegative("minHoleAreaM2", resolved.minHoleAreaM2);
  if (resolved.gridAngleRad !== "auto" && !Number.isFinite(resolved.gridAngleRad)) {
    throw new RangeError('floorplan option gridAngleRad must be "auto" or a finite number.');
  }
  // Int32 cell indices, and a guard against allocating gigabytes by accident.
  if (
    !(Number.isInteger(resolved.maxCells) && resolved.maxCells > 0 && resolved.maxCells <= 2 ** 28)
  ) {
    throw new RangeError("floorplan option maxCells must be an integer from 1 to 2^28.");
  }
  return resolved;
}

function emptyResult(
  triangles: number,
  skippedTriangles: number,
  cellSizeM: number,
  elapsed: number,
): FloorplanResult {
  return {
    polygons: [],
    coverage: {
      width: 0,
      height: 0,
      cellSizeM,
      angleRad: 0,
      originU: 0,
      originW: 0,
      cells: new Uint8Array(0),
    },
    stats: {
      triangles,
      skippedTriangles,
      gridAngleRad: 0,
      gridWidth: 0,
      gridHeight: 0,
      observedCells: 0,
      walkableCells: 0,
      bridgedCells: 0,
      holeCells: 0,
      removedIslands: 0,
      rings: 0,
      vertices: 0,
      polygons: 0,
      holes: 0,
      timingsMs: {
        prepare: elapsed,
        rasterise: 0,
        close: 0,
        islands: 0,
        trace: 0,
        simplify: 0,
        coverage: 0,
        total: elapsed,
      },
    },
  };
}
