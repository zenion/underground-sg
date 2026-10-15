// Input checks, the grid angle and the grid's extent.

import { FloorplanExtentError } from "./errors.ts";
import { type GridFrame, makeFrame } from "./frame.ts";
import { prng } from "./random.ts";

/** Floor triangles as x,z pairs, 3 vertices (6 numbers) per triangle. */
export type TriangleInput = Float32Array | Float64Array;

/** Triangles smaller than this (m²) are degenerate and skipped. */
const MIN_TRIANGLE_AREA_M2 = 1e-9;

/**
 * So are slivers: an area at most this times the longest edge squared, a height under 0.02% of
 * that edge (0.2 mm on 1 m). Collinear points stop being exactly collinear once rounded to
 * Float32, and a steep face classified as floor projects to a sliver.
 */
const SLIVER_RATIO = 1e-4;

/** Triangles sampled for the grid-angle search; their vertices are the sample points. */
const ANGLE_SAMPLE_TRIANGLES = 2048;

/** Seed for picking the sample, so the same input always gives the same angle. */
const ANGLE_SAMPLE_SEED = 0x2f6b9d43;

/** Histogram bin for the grid-angle search, in metres, and the most bins per axis. */
const ANGLE_BIN_M = 0.2;
const ANGLE_MAX_BINS = 1 << 15;

/** A rotated grid must be at least this much sharper than the session axes to be used. */
const MIN_ROTATION_GAIN = 0.02;

export interface ScanResult {
  /** 1 for each triangle that is finite and not degenerate. */
  readonly valid: Uint8Array;
  readonly validCount: number;
}

/**
 * Marks the triangles to rasterise: every coordinate finite, an area of at least
 * MIN_TRIANGLE_AREA_M2, and not a sliver (SLIVER_RATIO). A non-finite coordinate makes the area
 * NaN or infinite, so the area test catches it too.
 */
export function scanTriangles(triangles: TriangleInput): ScanResult {
  if (triangles.length % 6 !== 0) {
    throw new RangeError(
      `Floor triangles are x,z pairs with 3 vertices per triangle, so the length must be a ` +
        `multiple of 6; got ${triangles.length}.`,
    );
  }
  const count = triangles.length / 6;
  const valid = new Uint8Array(count);
  let validCount = 0;
  for (let t = 0; t < count; t++) {
    const o = t * 6;
    const x0 = triangles[o]!;
    const z0 = triangles[o + 1]!;
    const abx = triangles[o + 2]! - x0;
    const abz = triangles[o + 3]! - z0;
    const acx = triangles[o + 4]! - x0;
    const acz = triangles[o + 5]! - z0;
    const area2 = abx * acz - acx * abz;
    const area = area2 < 0 ? -area2 * 0.5 : area2 * 0.5;
    const bcx = acx - abx;
    const bcz = acz - abz;
    let edge2 = abx * abx + abz * abz;
    const ac2 = acx * acx + acz * acz;
    const bc2 = bcx * bcx + bcz * bcz;
    if (ac2 > edge2) edge2 = ac2;
    if (bc2 > edge2) edge2 = bc2;
    if (
      area >= MIN_TRIANGLE_AREA_M2 &&
      area < Number.POSITIVE_INFINITY &&
      area > SLIVER_RATIO * edge2
    ) {
      valid[t] = 1;
      validCount++;
    }
  }
  return { valid, validCount };
}

/**
 * The grid angle that lines the grid up with the walls, or 0 (the session axes) when no angle is
 * clearly better. Walls make sharp edges in the floor's projections: when the grid is aligned,
 * the floor points pile up between the same wall lines along each axis, and a misaligned grid
 * smears them. So the search maximises the sum of squared bin counts of the projections onto
 * both grid axes, using the vertices of up to ANGLE_SAMPLE_TRIANGLES triangles and 0.2 m bins:
 * 3° steps over 90° (the score repeats every 90°), then 0.25° steps within 3° of the best and
 * 0.05° steps within 0.25°. A misaligned corridor spreads over more bins the further it is
 * turned, so the coarse steps find the right peak. Lining up with the walls gives a tight grid
 * for a corridor in any direction and straight outlines with few vertices. The exact extent is
 * computed afterwards from every vertex.
 *
 * The sample is drawn at random with a fixed seed (sampleTriangles), not every nth triangle: a
 * mesh stored in row or block order makes every nth triangle a lattice with sharp projections of
 * its own, and the search would line the grid up with that instead of the walls.
 */
export function chooseGridAngle(triangles: TriangleInput, scan: ScanResult): number {
  const sample = sampleTriangles(scan);
  const xs: number[] = [];
  const zs: number[] = [];
  let sumX = 0;
  let sumZ = 0;
  for (let s = 0; s < sample.length; s++) {
    const o = sample[s]! * 6;
    for (let k = 0; k < 6; k += 2) {
      const x = triangles[o + k]!;
      const z = triangles[o + k + 1]!;
      xs.push(x);
      zs.push(z);
      sumX += x;
      sumZ += z;
    }
  }
  // Centre the points; every projection then lies within +-radius.
  const n = xs.length;
  const cx = sumX / n;
  const cz = sumZ / n;
  let radius2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - cx;
    const dz = zs[i]! - cz;
    xs[i] = dx;
    zs[i] = dz;
    if (dx * dx + dz * dz > radius2) radius2 = dx * dx + dz * dz;
  }
  const radius = Math.sqrt(radius2);
  const bin = Math.max(ANGLE_BIN_M, (2 * radius) / (ANGLE_MAX_BINS - 3));
  const bins = Math.floor((2 * radius) / bin) + 3;
  const histU = new Int32Array(bins);
  const histW = new Int32Array(bins);
  const sharpness = (angle: number): number => {
    const cos = Math.cos(angle) / bin;
    const sin = Math.sin(angle) / bin;
    // Half a bin of slack keeps rounding at the edge from reaching index -1.
    const offset = radius / bin + 0.5;
    let score = 0;
    for (let i = 0; i < n; i++) {
      const x = xs[i]!;
      const z = zs[i]!;
      const u = Math.floor(x * cos + z * sin + offset);
      const w = Math.floor(z * cos - x * sin + offset);
      // Adding the k+1th point to a bin raises the sum of squares by 2k + 1.
      score += 2 * histU[u]! + 2 * histW[w]! + 2;
      histU[u] = histU[u]! + 1;
      histW[w] = histW[w]! + 1;
    }
    histU.fill(0);
    histW.fill(0);
    return score;
  };
  const degree = Math.PI / 180;
  const axisScore = sharpness(0);
  let best = 0;
  let bestScore = axisScore;
  const search = (centre: number, step: number, steps: number): void => {
    for (let i = -steps; i <= steps; i++) {
      const angle = centre + i * step;
      const score = sharpness(angle);
      if (score > bestScore) {
        bestScore = score;
        best = angle;
      }
    }
  };
  search(45 * degree, 3 * degree, 15);
  search(best, 0.25 * degree, 12);
  search(best, 0.05 * degree, 5);
  if (!(bestScore > axisScore * (1 + MIN_ROTATION_GAIN))) return 0;
  // Angles 90° apart give the same grid turned; keep it in [0°, 90°).
  const quarter = Math.PI / 2;
  return ((best % quarter) + quarter) % quarter;
}

/**
 * Indices of the triangles for the grid-angle search: every valid triangle when there are at most
 * ANGLE_SAMPLE_TRIANGLES, otherwise that many distinct ranks among the valid triangles drawn with
 * a fixed seed (a repeated draw is taken once). Sorting the ranks lets one pass over `valid` find
 * them, the same cost as taking every nth triangle, and the result doesn't depend on the order
 * the mesh is stored in.
 */
export function sampleTriangles(scan: ScanResult): Int32Array {
  const { valid, validCount } = scan;
  if (validCount <= ANGLE_SAMPLE_TRIANGLES) {
    const all = new Int32Array(validCount);
    for (let t = 0, k = 0; t < valid.length; t++) if (valid[t] !== 0) all[k++] = t;
    return all;
  }
  // Floyd's algorithm: ANGLE_SAMPLE_TRIANGLES distinct ranks, uniformly at random.
  const random = prng(ANGLE_SAMPLE_SEED);
  const chosen = new Set<number>();
  for (let j = validCount - ANGLE_SAMPLE_TRIANGLES; j < validCount; j++) {
    const rank = Math.floor(random() * (j + 1));
    chosen.add(chosen.has(rank) ? j : rank);
  }
  const ranks = new Int32Array(chosen.size);
  let k = 0;
  for (const rank of chosen) ranks[k++] = rank;
  ranks.sort();
  const picked = new Int32Array(ranks.length);
  for (let t = 0, rank = 0, next = 0; t < valid.length && next < ranks.length; t++) {
    if (valid[t] === 0) continue;
    if (ranks[next] === rank) picked[next++] = t;
    rank++;
  }
  return picked;
}

/**
 * The grid frame for the valid triangles: their extent along the grid axes plus `padCells` empty
 * cells on every side, so the close never reaches the edge and every traced outline is closed.
 * Throws FloorplanExtentError when the grid would need more than maxCells cells.
 */
export function frameFor(
  triangles: TriangleInput,
  scan: ScanResult,
  angleRad: number,
  cellSizeM: number,
  padCells: number,
  maxCells: number,
): GridFrame {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  let minU = Number.POSITIVE_INFINITY;
  let maxU = Number.NEGATIVE_INFINITY;
  let minW = Number.POSITIVE_INFINITY;
  let maxW = Number.NEGATIVE_INFINITY;
  for (let t = 0; t < scan.valid.length; t++) {
    if (scan.valid[t] === 0) continue;
    const o = t * 6;
    for (let k = 0; k < 6; k += 2) {
      const x = triangles[o + k]!;
      const z = triangles[o + k + 1]!;
      const u = x * cos + z * sin;
      const w = z * cos - x * sin;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (w < minW) minW = w;
      if (w > maxW) maxW = w;
    }
  }
  const minCol = Math.floor(minU / cellSizeM) - padCells;
  const minRow = Math.floor(minW / cellSizeM) - padCells;
  const width = Math.floor(maxU / cellSizeM) + padCells - minCol + 1;
  const height = Math.floor(maxW / cellSizeM) + padCells - minRow + 1;
  const cells = width * height;
  if (!(cells <= maxCells)) {
    throw new FloorplanExtentError([maxU - minU, maxW - minW], cellSizeM, cells, maxCells);
  }
  return makeFrame(cellSizeM, angleRad, minCol * cellSizeM, minRow * cellSizeM, width, height);
}
