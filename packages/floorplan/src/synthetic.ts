// Synthetic floor meshes, generated in code with a seeded PRNG so every run sees the same
// triangles. Nothing here was recorded in a venue (CLAUDE.md fixture rule). The tests use them,
// and so does the mapper app's on-phone benchmark (`@usg/floorplan/synthetic`), which times
// buildFloorplan in Hermes without needing a recorded mesh.

import { prng } from "./random.ts";

/** An axis-aligned rectangle in the design frame, metres. */
export interface Rect {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
}

export const rect = (x0: number, z0: number, x1: number, z1: number): Rect => ({ x0, z0, x1, z1 });

export const rectArea = (r: Rect): number => (r.x1 - r.x0) * (r.z1 - r.z0);

const inside = (r: Rect, x: number, z: number): boolean =>
  x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1;

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;

export { prng };

/** Collects triangles as x,z pairs. */
export class Triangles {
  readonly values: number[] = [];

  add(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): this {
    this.values.push(ax, az, bx, bz, cx, cz);
    return this;
  }

  /**
   * Tessellates a rectangle into squares of about `step` metres, two triangles each, leaving out
   * triangles whose centroid lies in any of `skip`.
   */
  addRect(r: Rect, step = 0.25, skip: readonly Rect[] = []): this {
    const nx = Math.max(1, Math.round((r.x1 - r.x0) / step));
    const nz = Math.max(1, Math.round((r.z1 - r.z0) / step));
    const sx = (r.x1 - r.x0) / nx;
    const sz = (r.z1 - r.z0) / nz;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const xa = r.x0 + i * sx;
        const xb = i === nx - 1 ? r.x1 : xa + sx;
        const za = r.z0 + j * sz;
        const zb = j === nz - 1 ? r.z1 : za + sz;
        this.addQuad(xa, za, xb, za, xb, zb, xa, zb, skip);
      }
    }
    return this;
  }

  addQuad(
    ax: number,
    az: number,
    bx: number,
    bz: number,
    cx: number,
    cz: number,
    dx: number,
    dz: number,
    skip: readonly Rect[] = [],
  ): this {
    if (!skip.some((s) => inside(s, (ax + bx + cx) / 3, (az + bz + cz) / 3))) {
      this.add(ax, az, bx, bz, cx, cz);
    }
    if (!skip.some((s) => inside(s, (ax + cx + dx) / 3, (az + cz + dz) / 3))) {
      this.add(ax, az, cx, cz, dx, dz);
    }
    return this;
  }

  get count(): number {
    return this.values.length / 6;
  }

  toFloat32(): Float32Array {
    return Float32Array.from(this.values);
  }
}

/** Rotates x,z pairs by `angle` radians (x' = x cos - z sin, z' = x sin + z cos) and translates. */
export function transform(values: ArrayLike<number>, angle: number, tx = 0, tz = 0): Float32Array {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 2) {
    const x = values[i] as number;
    const z = values[i + 1] as number;
    out[i] = x * cos - z * sin + tx;
    out[i + 1] = x * sin + z * cos + tz;
  }
  return out;
}

/** A synthetic corridor mesh and what an ideal floor plan of it would contain. */
export interface CorridorMesh {
  readonly triangles: Float32Array;
  /** Triangles that tile the floor, and noise triangles (strays, duplicates, degenerate). */
  readonly floorTriangles: number;
  readonly noiseTriangles: number;
  /** Floor area: the rectangles minus pillars and the unscanned patch (bridged gaps count). */
  readonly walkableAreaM2: number;
  /** Pillars plus the unscanned patch. */
  readonly holes: number;
  readonly holeAreaM2: number;
  /** The rotation and translation applied to the design frame. */
  readonly angleRad: number;
  readonly offset: readonly [number, number];
}

/** Sizes of the synthetic corridor: about 25k, 106k and 1.1M triangles. */
export type CorridorSize = "small" | "realistic" | "dense";

/** Every mesh is rotated and shifted by this, as an arbitrary session heading and origin. */
const ANGLE_RAD = 0.6;
const OFFSET = [-3.2, 1.7] as const;

/** Edge of the dense mesh's lattice squares, metres. */
const DENSE_VOXEL_M = 0.05;

/**
 * A corridor along x from 0 to `lengthM` and along z from 0 to `widthM`, with side regions,
 * pillars, an unscanned patch, unmeshed strips and noise.
 */
interface CorridorLayout {
  readonly lengthM: number;
  readonly widthM: number;
  /** Walkable rectangles: the corridor first, then side halls and exits. */
  readonly regions: readonly Rect[];
  readonly pillars: readonly Rect[];
  /** Floor the scan missed: a hole in the plan. */
  readonly patch: Rect;
  /** Strips across the corridor where the floor wasn't meshed (glass, a reflection). */
  readonly strips: readonly Rect[];
  /** Stray triangles beyond the walls, below z = 0 and above the corridor (start z of each band). */
  readonly strays: number;
  readonly strayBands: readonly [number, number];
  /** Overlapping duplicates inside the corridor: x from start over span, z likewise. */
  readonly duplicates: number;
  readonly duplicateX: readonly [number, number];
  readonly duplicateZ: readonly [number, number];
  /** Degenerate slivers anywhere along the corridor. */
  readonly slivers: number;
}

const REALISTIC: CorridorLayout = {
  lengthM: 150,
  widthM: 6,
  regions: [
    rect(0, 0, 150, 6), // the corridor
    rect(20, 6, 36, 18), // hall A
    rect(68, -10, 82, 0), // hall B
    rect(108, 6, 128, 14), // hall C
    rect(140, -9, 143, 0), // exit stub
  ],
  pillars: [
    ...Array.from({ length: 10 }, (_, k) => rect(7 + 15 * k, 2.5, 8 + 15 * k, 3.5)),
    rect(25, 11, 26, 12),
    rect(30, 11, 31, 12),
    rect(117.5, 9.5, 118.5, 10.5),
  ],
  patch: rect(74, -7, 75.5, -6),
  strips: [rect(50, 0, 50.25, 6), rect(100.5, 0, 100.75, 6)],
  strays: 600,
  strayBands: [-4, 6.6],
  duplicates: 300,
  duplicateX: [1, 148],
  duplicateZ: [0.5, 2],
  slivers: 50,
};

const SMALL: CorridorLayout = {
  lengthM: 40,
  widthM: 6,
  regions: [
    rect(0, 0, 40, 6), // the corridor
    rect(14, 6, 26, 14), // a side hall
  ],
  pillars: [
    rect(7, 2.5, 8, 3.5),
    rect(22, 2.5, 23, 3.5),
    rect(33, 2.5, 34, 3.5),
    rect(19.5, 9.5, 20.5, 10.5),
  ],
  patch: rect(23, 11, 24.5, 12),
  strips: [rect(30, 0, 30.25, 6)],
  strays: 160,
  strayBands: [-4, 6.6],
  duplicates: 80,
  duplicateX: [1, 38],
  duplicateZ: [0.5, 2],
  slivers: 14,
};

/** The default seed: the same mesh every run. */
export const SYNTHETIC_SEED = 20261015;

/**
 * A synthetic underground pedestrian link as an ARKit scan would leave it.
 *
 * - `realistic`: 150 m x 6 m with three side halls and an exit stub, 13 pillars, about 106k
 *   triangles: the benchmark mesh in the README.
 * - `small`: 40 m x 6 m with one side hall and 4 pillars, about 25k triangles.
 * - `dense`: the realistic layout tessellated far more finely, about 1.1M triangles (see
 *   denseFloor): how much the timings depend on the mesh's density, which no recorded mesh has
 *   shown yet.
 *
 * All have 1 m pillars, an unscanned 1.5 m x 1 m patch, 0.25 m strips across the corridor where
 * the floor wasn't meshed, 1.5% of triangles dropped at random, and noise: stray triangles beyond
 * the walls, overlapping duplicates and degenerate slivers. In `small` and `realistic`, triangle
 * sizes vary by a factor of five in edge length from one 1 m block to the next and interior
 * vertices are jittered. The whole mesh is rotated and shifted as an ARKit session with an
 * arbitrary heading would record it.
 */
export function syntheticCorridorMesh(size: CorridorSize, seed = SYNTHETIC_SEED): CorridorMesh {
  if (size === "dense") return denseCorridorMesh(REALISTIC, seed, DENSE_VOXEL_M);
  return corridorMesh(size === "small" ? SMALL : REALISTIC, seed);
}

/** The realistic benchmark mesh: `syntheticCorridorMesh("realistic", seed)`. */
export function uplCorridorMesh(seed = SYNTHETIC_SEED): CorridorMesh {
  return corridorMesh(REALISTIC, seed);
}

function corridorMesh(layout: CorridorLayout, seed: number): CorridorMesh {
  const random = prng(seed);
  const { regions, pillars, patch, strips } = layout;
  const skip = [...pillars, patch, ...strips];

  const steps = [0.1, 0.125, 0.25, 0.5];
  const weights = [0.15, 0.25, 0.35, 0.25];
  const pickStep = (): number => {
    let u = random();
    for (let k = 0; k < steps.length; k++) {
      u -= weights[k] as number;
      if (u < 0) return steps[k] as number;
    }
    return steps[steps.length - 1] as number;
  };

  const mesh = new Triangles();
  for (const region of regions) {
    for (let bx = region.x0; bx < region.x1; bx++) {
      for (let bz = region.z0; bz < region.z1; bz++) {
        const block = rect(bx, bz, bx + 1, bz + 1);
        // Blocks with a pillar, the patch or a strip use small triangles, so the cut-outs keep
        // their size (big triangles would round them to half-metre steps).
        const step = skip.some((s) => overlaps(s, block)) ? 0.125 : pickStep();
        addBlock(mesh, block, step, random, skip);
      }
    }
  }
  const floorTriangles = mesh.count;
  addNoise(mesh, layout, random);
  return summarise(
    layout,
    transform(mesh.values, ANGLE_RAD, OFFSET[0], OFFSET[1]),
    floorTriangles,
    mesh.count - floorTriangles,
  );
}

/**
 * The dense variant: the floor straight in the session frame (denseFloor), then the same noise as
 * the other sizes, rotated and shifted into the session frame like them.
 */
function denseCorridorMesh(layout: CorridorLayout, seed: number, voxelM: number): CorridorMesh {
  const random = prng(seed);
  const floor = denseFloor(layout, voxelM, random);
  const noise = new Triangles();
  addNoise(noise, layout, random);
  const noiseValues = transform(noise.values, ANGLE_RAD, OFFSET[0], OFFSET[1]);
  const triangles = new Float32Array(floor.length + noiseValues.length);
  triangles.set(floor);
  triangles.set(noiseValues, floor.length);
  return summarise(layout, triangles, floor.length / 6, noise.count);
}

function summarise(
  layout: CorridorLayout,
  triangles: Float32Array,
  floorTriangles: number,
  noiseTriangles: number,
): CorridorMesh {
  const { regions, pillars, patch } = layout;
  const grossArea = regions.reduce((sum, r) => sum + rectArea(r), 0);
  const holeAreaM2 = [...pillars, patch].reduce((sum, r) => sum + rectArea(r), 0);
  return {
    triangles,
    floorTriangles,
    noiseTriangles,
    walkableAreaM2: grossArea - holeAreaM2,
    holes: pillars.length + 1,
    holeAreaM2,
    angleRad: ANGLE_RAD,
    offset: OFFSET,
  };
}

/**
 * Noise, in the design frame: stray floor triangles beyond the walls (shop floors through glass,
 * misclassified benches), at least 0.6 m from any walkable rectangle so they stay islands;
 * overlapping duplicates inside the corridor, as where two mesh anchors overlap; and degenerate
 * slivers (collinear and repeated vertices).
 */
function addNoise(mesh: Triangles, layout: CorridorLayout, random: () => number): void {
  const { regions } = layout;
  const keepOut = regions.map((r) => rect(r.x0 - 0.6, r.z0 - 0.6, r.x1 + 0.6, r.z1 + 0.6));
  const [nearBand, farBand] = layout.strayBands;
  for (let k = 0; k < layout.strays; ) {
    const x = random() * layout.lengthM;
    const z = random() < 0.5 ? nearBand + random() * 3.4 : farBand + random() * 3.4;
    const size = 0.05 + random() * 0.2;
    if (keepOut.some((r) => inside(r, x, z) || inside(r, x + size, z + size))) continue;
    mesh.add(x, z, x + size, z + random() * size, x + random() * size, z + size);
    k++;
  }
  // Overlapping duplicates inside the corridor, as where two mesh anchors overlap.
  for (let k = 0; k < layout.duplicates; k++) {
    const x = layout.duplicateX[0] + random() * layout.duplicateX[1];
    const z = layout.duplicateZ[0] + random() * layout.duplicateZ[1];
    const size = 0.1 + random() * 0.3;
    mesh.add(x, z, x + size, z, x, z + size);
  }
  // Degenerate slivers: collinear and repeated vertices.
  for (let k = 0; k < layout.slivers; k++) {
    const x = random() * layout.lengthM;
    const z = random() * layout.widthM;
    if (k % 2 === 0) mesh.add(x, z, x + 0.2, z + 0.1, x + 0.4, z + 0.2);
    else mesh.add(x, z, x, z, x, z);
  }
}

/**
 * The walkable area tessellated on a lattice of `voxelM` squares aligned with the session's axes,
 * two triangles each, written straight into the session frame. This models a reconstruction that
 * meshes the floor from voxels in the session's frame: the walls run at an angle to the lattice,
 * so every wall edge is a staircase of voxel steps, and the triangles are small and uniform. A
 * square is kept when its centre lies in a region (half-open, so neighbouring regions share no
 * squares) and not in a pillar, the patch or a strip; 1.5% of triangles are dropped at random.
 */
function denseFloor(layout: CorridorLayout, voxelM: number, random: () => number): Float32Array {
  const cos = Math.cos(ANGLE_RAD);
  const sin = Math.sin(ANGLE_RAD);
  const [tx, tz] = OFFSET;
  const regions = layout.regions;
  const skip = [...layout.pillars, layout.patch, ...layout.strips];
  // Each rectangle's extent along the session's z axis, to find the rows it crosses.
  const zRange = (r: Rect): readonly [number, number] => {
    const zs = [r.x0, r.x1].flatMap((x) => [r.z0, r.z1].map((z) => x * sin + z * cos + tz));
    return [Math.min(...zs), Math.max(...zs)];
  };
  const regionZ = regions.map(zRange);
  const skipZ = skip.map(zRange);
  const minZ = Math.min(...regionZ.map(([lo]) => lo));
  const maxZ = Math.max(...regionZ.map(([, hi]) => hi));
  const gross = regions.reduce((sum, r) => sum + rectArea(r), 0);
  const out = new FloatList(Math.ceil((gross / (voxelM * voxelM)) * 12 * 1.01));
  const rowSkip: Rect[] = [];
  for (let j = Math.floor(minZ / voxelM); j * voxelM < maxZ; j++) {
    const dz = (j + 0.5) * voxelM - tz;
    rowSkip.length = 0;
    for (let k = 0; k < skip.length; k++) {
      const range = skipZ[k] as readonly [number, number];
      if (dz + tz >= range[0] && dz + tz <= range[1]) rowSkip.push(skip[k] as Rect);
    }
    for (let k = 0; k < regions.length; k++) {
      const range = regionZ[k] as readonly [number, number];
      if (dz + tz < range[0] || dz + tz > range[1]) continue;
      const r = regions[k] as Rect;
      // Along the row, with dx = X - tx: x = dx cos + dz sin and z = dz cos - dx sin.
      const [xFrom, xTo] = solveRange(cos, dz * sin, r.x0, r.x1);
      const [zFrom, zTo] = solveRange(-sin, dz * cos, r.z0, r.z1);
      const from = Math.max(xFrom, zFrom) + tx;
      const to = Math.min(xTo, zTo) + tx;
      if (from > to) continue;
      for (let i = Math.floor(from / voxelM) - 1, last = Math.ceil(to / voxelM); i <= last; i++) {
        const dx = (i + 0.5) * voxelM - tx;
        const x = dx * cos + dz * sin;
        const z = dz * cos - dx * sin;
        if (x < r.x0 || x >= r.x1 || z < r.z0 || z >= r.z1) continue;
        let skipped = false;
        for (let s = 0; s < rowSkip.length && !skipped; s++) {
          skipped = inside(rowSkip[s] as Rect, x, z);
        }
        if (skipped) continue;
        const x0 = i * voxelM;
        const z0 = j * voxelM;
        const x1 = x0 + voxelM;
        const z1 = z0 + voxelM;
        if (random() >= 0.015) out.push(x0, z0, x1, z0, x1, z1);
        if (random() >= 0.015) out.push(x0, z0, x1, z1, x0, z1);
      }
    }
  }
  return out.values();
}

/** The interval of t for which lo <= k t + m < hi (ends included: callers test exactly). */
function solveRange(k: number, m: number, lo: number, hi: number): [number, number] {
  if (k > 0) return [(lo - m) / k, (hi - m) / k];
  if (k < 0) return [(hi - m) / k, (lo - m) / k];
  return m >= lo && m < hi
    ? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]
    : [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
}

/** A growable Float32Array of triangles, so a million of them never sit in a JS number array. */
class FloatList {
  private data: Float32Array;
  private length = 0;

  constructor(capacity: number) {
    this.data = new Float32Array(Math.max(6, capacity));
  }

  push(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): void {
    if (this.length + 6 > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const d = this.data;
    const n = this.length;
    d[n] = ax;
    d[n + 1] = az;
    d[n + 2] = bx;
    d[n + 3] = bz;
    d[n + 4] = cx;
    d[n + 5] = cz;
    this.length = n + 6;
  }

  values(): Float32Array {
    return this.data.subarray(0, this.length);
  }
}

/**
 * One 1 m block as an n x n grid of squares with jittered interior vertices (block-edge vertices
 * stay put, so neighbouring blocks meet without cracks, only T-junctions), dropping 1.5% of
 * triangles at random.
 */
function addBlock(
  mesh: Triangles,
  block: Rect,
  step: number,
  random: () => number,
  skip: readonly Rect[],
): void {
  const n = Math.round(1 / step);
  const xs = new Float64Array((n + 1) * (n + 1));
  const zs = new Float64Array((n + 1) * (n + 1));
  const jitter = 0.15 * step;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const edge = i === 0 || j === 0 || i === n || j === n;
      const k = i * (n + 1) + j;
      xs[k] = block.x0 + i * step + (edge ? 0 : (random() * 2 - 1) * jitter);
      zs[k] = block.z0 + j * step + (edge ? 0 : (random() * 2 - 1) * jitter);
    }
  }
  const at = (i: number, j: number): [number, number] => {
    const k = i * (n + 1) + j;
    return [xs[k] as number, zs[k] as number];
  };
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const [ax, az] = at(i, j);
      const [bx, bz] = at(i + 1, j);
      const [cx, cz] = at(i + 1, j + 1);
      const [dx, dz] = at(i, j + 1);
      if (
        random() >= 0.015 &&
        !skip.some((s) => inside(s, (ax + bx + cx) / 3, (az + bz + cz) / 3))
      ) {
        mesh.add(ax, az, bx, bz, cx, cz);
      }
      if (
        random() >= 0.015 &&
        !skip.some((s) => inside(s, (ax + cx + dx) / 3, (az + cz + dz) / 3))
      ) {
        mesh.add(ax, az, cx, cz, dx, dz);
      }
    }
  }
}
