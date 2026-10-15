// Recorded meshes for the venue tests. They come from captures in a venue, so they live in the
// git-ignored .data/fixtures/floorplan/ and never in git (CLAUDE.md fixture rule).
//
// Two formats:
// - `*.ply` (preferred, as it keeps the heights): a capture bundle's mesh/scene.ply
//   (docs/capture-bundle.md): binary little-endian, float x, y, z vertices, triangle faces with a
//   uchar classification. Faces classified as floor (2) are projected onto x/z, as the capture
//   module's floorTriangles does.
// - `*.f32`: what floorTriangles returns, saved as raw little-endian float32 x,z pairs.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".data",
  "fixtures",
  "floorplan",
);

export function fixtureFiles(): string[] {
  if (!existsSync(FIXTURE_DIR)) return [];
  return readdirSync(FIXTURE_DIR)
    .filter((name) => /\.(ply|f32)$/i.test(name))
    .sort();
}

const FLOOR = 2;

export function readFloorTriangles(name: string): Float32Array {
  const bytes = readFileSync(join(FIXTURE_DIR, name));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (/\.f32$/i.test(name)) {
    if (bytes.byteLength % 24 !== 0)
      throw new Error(`${name}: not whole triangles of float32 x,z pairs`);
    const out = new Float32Array(bytes.byteLength / 4);
    for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
    return out;
  }
  return readPlyFloor(name, bytes, view);
}

function readPlyFloor(name: string, bytes: Buffer, view: DataView): Float32Array {
  const marker = bytes.indexOf("end_header\n");
  if (marker < 0) throw new Error(`${name}: no PLY header`);
  const header = bytes
    .subarray(0, marker)
    .toString("latin1")
    .split("\n")
    .map((line) => line.trim());
  const expected = [
    "ply",
    "format binary_little_endian 1.0",
    /^element vertex \d+$/,
    "property float x",
    "property float y",
    "property float z",
    /^element face \d+$/,
    "property list uchar uint vertex_indices",
    "property uchar classification",
  ];
  const lines = header.filter((line) => line !== "" && !line.startsWith("comment"));
  if (
    lines.length !== expected.length ||
    !expected.every((want, i) =>
      typeof want === "string" ? lines[i] === want : want.test(lines[i] ?? ""),
    )
  ) {
    throw new Error(`${name}: not the mesh/scene.ply layout in docs/capture-bundle.md`);
  }
  const vertices = Number(lines[2]?.split(" ")[2]);
  const faces = Number(lines[6]?.split(" ")[2]);
  const vertexStart = marker + "end_header\n".length;
  const faceStart = vertexStart + vertices * 12;
  if (bytes.byteLength < faceStart + faces * 14) throw new Error(`${name}: truncated`);
  const out: number[] = [];
  for (let f = 0; f < faces; f++) {
    const o = faceStart + f * 14;
    if (view.getUint8(o) !== 3) throw new Error(`${name}: face ${f} is not a triangle`);
    if (view.getUint8(o + 13) !== FLOOR) continue;
    for (let k = 0; k < 3; k++) {
      const v = view.getUint32(o + 1 + 4 * k, true);
      if (v >= vertices) throw new Error(`${name}: face ${f} has a bad vertex index`);
      const p = vertexStart + v * 12;
      out.push(view.getFloat32(p, true), view.getFloat32(p + 8, true));
    }
  }
  return Float32Array.from(out);
}
