// @usg/floorplan: floor triangles from the ARKit scene mesh to an approximate walkable outline,
// plus the coverage grid for the re-walk overlay. Environment-neutral and dependency-free: the
// mapper app runs it in Hermes (no WebAssembly, no JIT) and processing runs it in Node. See
// README.md for the pipeline, the conventions and the timings.

export {
  CELL_BRIDGED,
  CELL_HOLE,
  CELL_OBSERVED,
  CELL_OUTSIDE,
  type CoverageGrid,
  coverageCellCenter,
  type TraceCoverageOptions,
  traceCoverage,
} from "./coverage.ts";
export { FloorplanExtentError, FloorplanWorkError } from "./errors.ts";
export {
  buildFloorplan,
  DEFAULT_FLOORPLAN_OPTIONS,
  type FloorplanOptions,
  type FloorplanResult,
  type FloorplanStats,
  type StageTimings,
} from "./floorplan.ts";
export {
  type DisplayFeature,
  type DisplayFeatureCollection,
  type DisplayPolygon,
  type DisplayTransform,
  headingFromDirection,
  localToLonLat,
  toDisplayGeoJSON,
} from "./geojson.ts";
export { type FloorPolygon, type LocalPoint, type LocalRing, ringArea } from "./polygons.ts";
export type { TriangleInput } from "./prepare.ts";
