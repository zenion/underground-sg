// The corridor-lean set's scene mesh: @usg/floorplan's small synthetic corridor (a 40 m link with
// a side hall, pillars, an unscanned patch and noise), lifted onto the walk's floor heights and
// cut into mesh anchors of 5 m, as ARKit splits its mesh into chunks. Each triangle appears once
// the camera has been within REACH_M of it, so anchors are added part-scanned and updated as the
// walk goes on, and the far end of the side hall is never scanned. One phantom anchor (a polished
// floor's reflection) is added and later removed, as ARKit does.

import { syntheticCorridorMesh } from "@usg/floorplan/synthetic";
import {
  END_MARK_T,
  type Frame,
  floorY,
  PATH_FROM_X,
  PATH_TO_X,
  PATH_Z,
  WALK_FROM_T,
  WALK_SPEED,
} from "./walk.ts";

/** How far LiDAR meshes from the camera's path. */
export const REACH_M = 6;
/** Chunks along the link (design x) and their bands across it (design z). */
const CHUNK_M = 5;
const CHUNKS_ALONG = 8;
const BAND_EDGES = [0, 6] as const;
const BAND_CENTRES = [-2, 3, 10] as const;
/** `ARMeshClassification` floor: the synthetic noise lies on the floor class too, as in a scan. */
const FLOOR_CLASS = 2;
const NONE_CLASS = 0;

/** A mesh anchor's triangles, each with the time the scan first reached it. */
export interface MeshChunk {
  /** Stable name, for the anchor's UUID. */
  readonly name: string;
  /** The anchor's origin in the world frame (identity rotation, as ARKit's mesh anchors). */
  readonly origin: readonly [number, number, number];
  /** World x, y, z of each triangle's three corners, float32. */
  readonly corners: Float32Array;
  /** When each triangle was first scanned, in session seconds. */
  readonly seenAt: Float64Array;
  readonly classification: number;
}

/** Geometry for a mesh-history block: vertices in the anchor's frame, faces with classes. */
export interface MeshGeometry {
  readonly vertices: Float32Array;
  readonly faces: Uint32Array;
  readonly classes: Uint8Array;
}

/** When the walk first brought the camera within REACH_M of design point (x, z), or Infinity. */
export function scannedAt(x: number, z: number): number {
  const dz = Math.abs(z - PATH_Z);
  if (dz > REACH_M) return Number.POSITIVE_INFINITY;
  const from = x - Math.sqrt(REACH_M * REACH_M - dz * dz);
  if (from <= PATH_FROM_X) return 0;
  if (from > PATH_TO_X) return Number.POSITIVE_INFINITY;
  return WALK_FROM_T + (from - PATH_FROM_X) / WALK_SPEED;
}

function bandOf(z: number): number {
  return z < BAND_EDGES[0] ? 0 : z < BAND_EDGES[1] ? 1 : 2;
}

/** The synthetic corridor cut into chunks, in a fixed order; chunks never scanned are left out. */
export function corridorChunks(frame: Frame): MeshChunk[] {
  const mesh = syntheticCorridorMesh("small");
  if (Math.abs(mesh.angleRad - frame.angleRad) > 1e-12) {
    throw new Error("the walk's frame must use the synthetic corridor's rotation");
  }
  const triangles = mesh.triangles;
  const count = triangles.length / 6;
  const members: number[][] = Array.from({ length: 3 * CHUNKS_ALONG }, () => []);
  const centres: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    let cx = 0;
    let cz = 0;
    for (let corner = 0; corner < 3; corner++) {
      const [x, z] = frame.fromPlan(
        triangles[6 * i + 2 * corner] as number,
        triangles[6 * i + 2 * corner + 1] as number,
        mesh.offset,
      );
      cx += x / 3;
      cz += z / 3;
    }
    centres.push([cx, cz]);
    if (scannedAt(cx, cz) > END_MARK_T) continue;
    const along = Math.min(CHUNKS_ALONG - 1, Math.max(0, Math.floor(cx / CHUNK_M)));
    members[bandOf(cz) * CHUNKS_ALONG + along]?.push(i);
  }
  const chunks: MeshChunk[] = [];
  members.forEach((indices, key) => {
    if (indices.length === 0) return;
    const band = Math.floor(key / CHUNKS_ALONG);
    const along = key % CHUNKS_ALONG;
    const designX = along * CHUNK_M + CHUNK_M / 2;
    const [ox, oz] = frame.toWorld(designX, BAND_CENTRES[band] as number);
    const corners = new Float32Array(9 * indices.length);
    const seenAt = new Float64Array(indices.length);
    indices.forEach((triangle, k) => {
      const centre = centres[triangle] as [number, number];
      seenAt[k] = scannedAt(centre[0], centre[1]);
      for (let corner = 0; corner < 3; corner++) {
        const px = triangles[6 * triangle + 2 * corner] as number;
        const pz = triangles[6 * triangle + 2 * corner + 1] as number;
        const [wx, wz] = frame.planToWorld(px, pz, mesh.offset);
        const [dx] = frame.fromPlan(px, pz, mesh.offset);
        corners[9 * k + 3 * corner] = wx;
        corners[9 * k + 3 * corner + 1] = floorY(dx);
        corners[9 * k + 3 * corner + 2] = wz;
      }
    });
    chunks.push({
      name: `mesh/${band}-${along}`,
      origin: [roundMm(ox), roundMm(floorY(designX)), roundMm(oz)],
      corners,
      seenAt,
      classification: FLOOR_CLASS,
    });
  });
  return chunks;
}

/** The phantom anchor: a reflection 0.8 m below the polished B1 floor beside a pillar. */
export function phantomChunk(frame: Frame): MeshChunk {
  const [ox, oz] = frame.toWorld(17, 4);
  const y = floorY(17) - 0.8;
  const quad: [number, number][] = [
    [16.7, 3.8],
    [17.3, 3.8],
    [17.3, 4.2],
    [16.7, 4.2],
  ];
  const world = quad.map(([x, z]) => frame.toWorld(x, z));
  const order = [0, 1, 2, 0, 2, 3];
  const corners = new Float32Array(order.length * 3);
  order.forEach((index, k) => {
    const [wx, wz] = world[index] as [number, number];
    corners[3 * k] = wx;
    corners[3 * k + 1] = y;
    corners[3 * k + 2] = wz;
  });
  return {
    name: "mesh/phantom",
    origin: [roundMm(ox), roundMm(y), roundMm(oz)],
    corners,
    seenAt: new Float64Array([0, 0]),
    classification: NONE_CLASS,
  };
}

function roundMm(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Triangles of `chunk` scanned by `t`. */
export function scannedCount(chunk: MeshChunk, t: number): number {
  let count = 0;
  for (const seen of chunk.seenAt) if (seen <= t) count++;
  return count;
}

/**
 * The chunk's scanned triangles at `t` as block geometry: corners welded into shared vertices
 * (in first-use order), relative to `origin`, the anchor's position.
 */
export function chunkGeometry(
  chunk: MeshChunk,
  t: number,
  origin: readonly [number, number, number],
): MeshGeometry {
  const index = new Map<string, number>();
  const vertices: number[] = [];
  const faces: number[] = [];
  for (let k = 0; k < chunk.seenAt.length; k++) {
    if ((chunk.seenAt[k] as number) > t) continue;
    for (let corner = 0; corner < 3; corner++) {
      const at = 9 * k + 3 * corner;
      const local = [0, 1, 2].map((axis) =>
        Math.fround((chunk.corners[at + axis] as number) - (origin[axis] as number)),
      );
      const key = local.join(",");
      let vertex = index.get(key);
      if (vertex === undefined) {
        vertex = vertices.length / 3;
        index.set(key, vertex);
        vertices.push(...local);
      }
      faces.push(vertex);
    }
  }
  return {
    vertices: Float32Array.from(vertices),
    faces: Uint32Array.from(faces),
    classes: new Uint8Array(faces.length / 3).fill(chunk.classification),
  };
}

/** A block's bytes before DEFLATE: float32 vertices, uint32 indices, uint8 classes, little-endian. */
export function blockBytes(geometry: MeshGeometry): Uint8Array {
  const { vertices, faces, classes } = geometry;
  const out = new Uint8Array(4 * vertices.length + 4 * faces.length + classes.length);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const value of vertices) {
    view.setFloat32(at, value, true);
    at += 4;
  }
  for (const value of faces) {
    view.setUint32(at, value, true);
    at += 4;
  }
  out.set(classes, at);
  return out;
}

/** World x,z pairs of the chunks' floor triangles scanned by `t`: the floorTriangles result. */
export function floorTriangles(chunks: readonly MeshChunk[], t: number): Float32Array {
  const values: number[] = [];
  for (const chunk of chunks) {
    if (chunk.classification !== FLOOR_CLASS) continue;
    for (let k = 0; k < chunk.seenAt.length; k++) {
      if ((chunk.seenAt[k] as number) > t) continue;
      for (let corner = 0; corner < 3; corner++) {
        values.push(chunk.corners[9 * k + 3 * corner] as number);
        values.push(chunk.corners[9 * k + 3 * corner + 2] as number);
      }
    }
  }
  return Float32Array.from(values);
}
