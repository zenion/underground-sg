// The mesh-history block check: each block of mesh/history.bin, found through its line in
// mesh/history.jsonl, is one raw DEFLATE stream (RFC 1951) of exactly 12 bytes a vertex (float32
// x, y, z) plus 13 a face (three uint32 indices and a uint8 classification), all little-endian.
// The index comes after the bin in a sorted tar, so this reads the bin a second time, once, in
// offset order; each block is inflated alone, into at most its expected size.

import { inflateRawSync } from "node:zlib";
import type { RangeReader } from "../bundle-validator/source.ts";
import type { RecordingProblemCode } from "./codes.ts";

/** One block, from a mesh/history.jsonl line that isn't a remove. */
export interface MeshBlock {
  /** The index line, 1-based. */
  readonly line: number;
  readonly offset: number;
  readonly bytes: number;
  readonly vertices: number;
  readonly faces: number;
}

/** ARMeshClassification's values: none, wall, floor, ceiling, table, seat, window, door. */
const MAX_CLASSIFICATION = 7;

/** A block's size once inflated. */
export function inflatedSize(block: Pick<MeshBlock, "vertices" | "faces">): number {
  return 12 * block.vertices + 13 * block.faces;
}

/**
 * The most bytes a raw DEFLATE stream of `size` bytes can take: stored blocks cost 5 bytes per
 * 65,535, and zlib's bound is well inside this. A longer block can't be valid, so it is never
 * buffered.
 */
function maxDeflatedSize(size: number): number {
  return size + Math.ceil(size / 8) + Math.ceil(size / 64) + 64;
}

type Report = (code: RecordingProblemCode, line: number, message: string) => void;

interface InflateResult {
  readonly buffer: Buffer;
  readonly engine: { readonly bytesWritten: number };
}

function inflate(block: MeshBlock, data: Uint8Array, expected: number, report: Report) {
  let result: InflateResult;
  try {
    result = inflateRawSync(data, {
      maxOutputLength: Math.max(1, expected),
      info: true,
    }) as unknown as InflateResult;
  } catch (cause) {
    const tooLarge = (cause as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE";
    report(
      "mesh.block_invalid",
      block.line,
      tooLarge
        ? `The block inflates to more than ${expected} bytes (12 a vertex for ${block.vertices}, 13 a face for ${block.faces})`
        : "The block is not a complete raw DEFLATE stream",
    );
    return null;
  }
  const inflated = result.buffer;
  if (inflated.length !== expected) {
    report(
      "mesh.block_invalid",
      block.line,
      `The block inflates to ${inflated.length} bytes, not ${expected} (12 a vertex for ${block.vertices}, 13 a face for ${block.faces})`,
    );
    return null;
  }
  if (result.engine.bytesWritten !== data.length) {
    report(
      "mesh.block_invalid",
      block.line,
      `${data.length - result.engine.bytesWritten} bytes of the block follow the end of its DEFLATE stream`,
    );
    return null;
  }
  return inflated;
}

/** Checks the faces of an inflated block: indices below the vertex count, classifications. */
function checkFaces(block: MeshBlock, inflated: Buffer, report: Report): void {
  const indicesAt = 12 * block.vertices;
  const classesAt = indicesAt + 12 * block.faces;
  for (let face = 0; face < block.faces; face++) {
    for (let corner = 0; corner < 3; corner++) {
      if (inflated.readUInt32LE(indicesAt + 12 * face + 4 * corner) >= block.vertices) {
        report(
          "mesh.vertex_index",
          block.line,
          `Face ${face} refers to a vertex beyond the block's ${block.vertices} vertices`,
        );
        return;
      }
    }
  }
  for (let face = 0; face < block.faces; face++) {
    if ((inflated[classesAt + face] ?? 0) > MAX_CLASSIFICATION) {
      report(
        "mesh.classification",
        block.line,
        `Face ${face}'s classification is not 0 to ${MAX_CLASSIFICATION}`,
      );
      return;
    }
  }
}

/**
 * Checks `blocks`, which must be sorted by offset, not overlap and lie inside the bin, reading
 * the bin's bytes through `read`. Returns the inflated bytes checked.
 */
export async function checkMeshBlocks(
  blocks: readonly MeshBlock[],
  read: RangeReader,
  maxMeshBlockBytes: number,
  report: Report,
): Promise<number> {
  const first = blocks[0];
  const last = blocks.at(-1);
  if (first === undefined || last === undefined) return 0;
  const skip = blocks.map((block) => {
    const expected = inflatedSize(block);
    if (expected > maxMeshBlockBytes) {
      report(
        "limits.mesh_block",
        block.line,
        `${block.vertices} vertices and ${block.faces} faces inflate to ${expected} bytes; the limit is ${maxMeshBlockBytes} (maxMeshBlockBytes)`,
      );
      return true;
    }
    if (block.bytes > maxDeflatedSize(expected)) {
      report(
        "mesh.block_invalid",
        block.line,
        `The block is ${block.bytes} bytes, longer than any DEFLATE stream of ${expected} bytes`,
      );
      return true;
    }
    return false;
  });

  let inflatedBytes = 0;
  let index = 0;
  let position = first.offset;
  let buffer: Uint8Array | null = null;
  const end = last.offset + last.bytes;
  for await (const chunk of read(first.offset, end - first.offset)) {
    let at = 0;
    while (at < chunk.length && index < blocks.length) {
      const block = blocks[index] as MeshBlock;
      if (position < block.offset) {
        const gap = Math.min(block.offset - position, chunk.length - at);
        at += gap;
        position += gap;
        continue;
      }
      const take = Math.min(block.offset + block.bytes - position, chunk.length - at);
      if (skip[index] !== true) {
        buffer ??= new Uint8Array(block.bytes);
        buffer.set(chunk.subarray(at, at + take), position - block.offset);
      }
      at += take;
      position += take;
      if (position === block.offset + block.bytes) {
        if (buffer !== null) {
          const expected = inflatedSize(block);
          const inflated = inflate(block, buffer, expected, report);
          if (inflated !== null) {
            inflatedBytes += expected;
            checkFaces(block, inflated, report);
          }
        }
        buffer = null;
        index++;
      }
    }
  }
  return inflatedBytes;
}
