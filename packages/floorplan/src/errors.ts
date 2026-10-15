/**
 * The floor triangles span more than the grid allows (FloorplanOptions.maxCells). A capture
 * segment is one corridor, hall or level, so this usually means stray triangles far from the walk.
 * Check `code` rather than `instanceof` if the error may cross a bundler's class transform.
 */
export class FloorplanExtentError extends Error {
  readonly code = "FLOORPLAN_EXTENT";
  /** The triangles' extent along the grid's two axes, in metres. */
  readonly extentM: readonly [number, number];
  /** Cells the grid would need, and the limit. */
  readonly cells: number;
  readonly maxCells: number;

  constructor(
    extentM: readonly [number, number],
    cellSizeM: number,
    cells: number,
    maxCells: number,
  ) {
    super(
      `Floor triangles span ${formatMetres(extentM[0])} by ${formatMetres(extentM[1])}, which ` +
        `needs ${cells} grid cells of ${cellSizeM} m; the limit is ${maxCells}. A segment should ` +
        "be one corridor, hall or level: look for stray triangles far from the walk, or raise " +
        "maxCells or cellSizeM.",
    );
    this.name = "FloorplanExtentError";
    this.extentM = extentM;
    this.cells = cells;
    this.maxCells = maxCells;
  }
}

/**
 * The floor triangles overlap far more than a scan's do: rasterising them would take more than
 * the work limit (RASTER_WORK_PER_CELL row and cell visits per grid cell, plus a few per
 * triangle). maxCells bounds the grid's memory but not the time, which grows with each
 * triangle's size, so many large overlapping triangles could otherwise keep a worker busy for
 * minutes. ARKit's floor faces are centimetres across and tile the floor, so this means a
 * malformed mesh. Check `code` rather than `instanceof` if the error may cross a bundler's class
 * transform.
 */
export class FloorplanWorkError extends Error {
  readonly code = "FLOORPLAN_WORK";
  /** The work limit for this grid and input, and the grid's cells. */
  readonly limit: number;
  readonly cells: number;
  /** Triangles rasterised before the limit was reached, of the valid ones. */
  readonly rasterised: number;
  readonly validTriangles: number;

  constructor(limit: number, cells: number, rasterised: number, validTriangles: number) {
    super(
      `Floor triangles overlap far more than a scan's: after ${rasterised} of ${validTriangles} ` +
        `triangles, rasterising had visited more than ${limit} rows and cells for a grid of ` +
        `${cells} cells. Floor faces from a scan are centimetres across and barely overlap: look ` +
        "for large or repeated triangles.",
    );
    this.name = "FloorplanWorkError";
    this.limit = limit;
    this.cells = cells;
    this.rasterised = rasterised;
    this.validTriangles = validTriangles;
  }
}

function formatMetres(value: number): string {
  return value < 1e6 ? `${value.toFixed(1)} m` : `${value.toExponential(2)} m`;
}
