// The on-phone floor-plan benchmark (ADR 0007 spike criterion 4): @usg/floorplan on a synthetic
// corridor mesh generated on the device, so it measures Hermes before any recorded mesh exists.

import {
  buildFloorplan,
  CELL_BRIDGED,
  CELL_HOLE,
  type FloorPolygon,
  type FloorplanStats,
  type StageTimings,
  traceCoverage,
} from "@usg/floorplan";
import { type CorridorSize, syntheticCorridorMesh } from "@usg/floorplan/synthetic";

export type { CorridorSize };

export interface BenchmarkRun {
  readonly size: CorridorSize;
  /** Generating the synthetic mesh: not part of the floor plan, shown apart. */
  readonly meshMs: number;
  readonly stats: FloorplanStats;
  readonly polygons: readonly FloorPolygon[];
  /** Never-observed cells (bridged or holes) outlined for the overlay, and the time it took. */
  readonly gaps: readonly FloorPolygon[];
  readonly gapsMs: number;
}

export const STAGES: readonly (keyof StageTimings)[] = [
  "prepare",
  "rasterise",
  "close",
  "islands",
  "trace",
  "simplify",
  "coverage",
];

const defaultNow = (): number => globalThis.performance?.now() ?? Date.now();

export function runBenchmark(size: CorridorSize, now: () => number = defaultNow): BenchmarkRun {
  const started = now();
  const mesh = syntheticCorridorMesh(size);
  const meshMs = now() - started;
  const { polygons, coverage, stats } = buildFloorplan(mesh.triangles, { now });
  const gapsStarted = now();
  const gaps = traceCoverage(coverage, [CELL_BRIDGED, CELL_HOLE], { minAreaM2: 0.05 });
  const gapsMs = now() - gapsStarted;
  return { size, meshMs, stats, polygons, gaps, gapsMs };
}

/** The median of the runs' totals, in ms. */
export function medianMs(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** "12.3" below 100 ms, "123" above: enough precision for timings on a phone. */
export function formatMs(ms: number): string {
  return ms < 100 ? ms.toFixed(1) : ms.toFixed(0);
}
