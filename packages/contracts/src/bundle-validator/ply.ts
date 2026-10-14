// A streaming parser for mesh/scene.ply. The header must be exactly the one in
// docs/capture-bundle.md, with only the two counts varying; the counts are checked against the
// limits before the body is read, and the body is checked record by record without storing it.

import type { BundleLimits } from "./limits.ts";
import type { ProblemCode } from "./report.ts";

/** The header lines, with {vertices} and {faces} for the counts. */
export const PLY_HEADER_LINES = [
  "ply",
  "format binary_little_endian 1.0",
  "element vertex {vertices}",
  "property float x",
  "property float y",
  "property float z",
  "element face {faces}",
  "property list uchar uint vertex_indices",
  "property uchar classification",
  "end_header",
] as const;

/** ARMeshClassification values run from 0 (none) to 7 (door). */
export const MAX_CLASSIFICATION = 7;

const END_HEADER = "end_header\n";
const VERTEX_BYTES = 12;
/** Bad faces reported one by one; the rest are counted. */
const DETAILED_RECORDS = 5;
const COUNT_PATTERN = /^(0|[1-9][0-9]{0,9})$/;

export interface PlyProblem {
  readonly code: ProblemCode;
  readonly message: string;
}

export interface PlyResult {
  readonly vertices: number;
  readonly faces: number;
}

/** The counts from a header that matches the documented one, or the first mismatch. */
function parseHeader(
  text: string,
): { ok: true; vertices: number; faces: number } | { ok: false; message: string } {
  const lines = text.split("\n");
  // The text ends with "end_header\n", so the split leaves one empty string at the end.
  lines.pop();
  if (lines.length !== PLY_HEADER_LINES.length) {
    return {
      ok: false,
      message: `The header has ${lines.length} lines; the documented header has ${PLY_HEADER_LINES.length}`,
    };
  }
  let vertices = -1;
  let faces = -1;
  for (const [i, expected] of PLY_HEADER_LINES.entries()) {
    const line = lines[i] ?? "";
    const countName = expected.endsWith("{vertices}")
      ? "vertices"
      : expected.endsWith("{faces}")
        ? "faces"
        : null;
    if (countName === null) {
      if (line !== expected) {
        return { ok: false, message: `Header line ${i + 1} must be "${expected}"` };
      }
      continue;
    }
    const prefix = expected.slice(0, expected.indexOf("{"));
    const count = line.startsWith(prefix) ? line.slice(prefix.length) : "";
    if (!COUNT_PATTERN.test(count)) {
      return {
        ok: false,
        message: `Header line ${i + 1} must be "${prefix}<count>" with a decimal count`,
      };
    }
    if (countName === "vertices") vertices = Number(count);
    else faces = Number(count);
  }
  return { ok: true, vertices, faces };
}

/**
 * Push the file's chunks, then call `end`. Problems go to `report`; per-record problems are
 * counted, and the first few are reported with the record's index.
 */
export class PlyParser {
  readonly #limits: BundleLimits;
  readonly #report: (problem: PlyProblem) => void;
  #header: number[] | null = [];
  #stopped = false;
  #vertices = 0;
  #faces = 0;
  #verticesLeft = 0;
  #facesLeft = 0;
  #carry: Uint8Array = new Uint8Array(0);
  #trailingBytes = 0;
  #nonFinite = 0;
  #nonTriangles = 0;
  #firstNonTriangle = -1;
  #badIndexFaces = 0;
  #badClassFaces = 0;

  constructor(limits: BundleLimits, report: (problem: PlyProblem) => void) {
    this.#limits = limits;
    this.#report = report;
  }

  #stop(code: ProblemCode, message: string): void {
    this.#report({ code, message });
    this.#stopped = true;
  }

  push(chunk: Uint8Array): void {
    if (this.#stopped) return;
    let body = chunk;
    if (this.#header !== null) {
      const rest = this.#readHeader(chunk);
      if (rest === null) return;
      body = rest;
    }
    this.#readBody(body);
  }

  /** Collects header bytes; returns the rest of the chunk once the header is complete. */
  #readHeader(chunk: Uint8Array): Uint8Array | null {
    const header = this.#header ?? [];
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i] ?? 0;
      header.push(byte);
      if (byte > 0x7e || (byte < 0x20 && byte !== 0x0a)) {
        this.#stop("ply.header", "The header has a byte that is not printable ASCII or \\n");
        return null;
      }
      if (header.length > this.#limits.maxPlyHeaderBytes) {
        this.#stop(
          "ply.header",
          `No end_header line in the first ${this.#limits.maxPlyHeaderBytes} bytes (maxPlyHeaderBytes)`,
        );
        return null;
      }
      if (byte === 0x0a && header.length >= END_HEADER.length) {
        const text = String.fromCharCode(...header);
        if (text.endsWith(`\n${END_HEADER}`) || text === END_HEADER) {
          this.#header = null;
          return this.#startBody(text) ? chunk.subarray(i + 1) : null;
        }
      }
    }
    return null;
  }

  #startBody(text: string): boolean {
    const parsed = parseHeader(text);
    if (!parsed.ok) {
      this.#stop("ply.header", parsed.message);
      return false;
    }
    if (parsed.vertices > this.#limits.maxPlyVertices) {
      this.#stop(
        "limits.ply_vertices",
        `${parsed.vertices} vertices; the limit is ${this.#limits.maxPlyVertices} (maxPlyVertices)`,
      );
      return false;
    }
    if (parsed.faces > this.#limits.maxPlyFaces) {
      this.#stop(
        "limits.ply_faces",
        `${parsed.faces} faces; the limit is ${this.#limits.maxPlyFaces} (maxPlyFaces)`,
      );
      return false;
    }
    this.#vertices = parsed.vertices;
    this.#faces = parsed.faces;
    this.#verticesLeft = parsed.vertices;
    this.#facesLeft = parsed.faces;
    return true;
  }

  #readBody(chunk: Uint8Array): void {
    let data = chunk;
    if (this.#carry.length > 0) {
      data = new Uint8Array(this.#carry.length + chunk.length);
      data.set(this.#carry);
      data.set(chunk, this.#carry.length);
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let at = 0;

    const vertexCount = Math.min(this.#verticesLeft, Math.floor(data.length / VERTEX_BYTES));
    for (let v = 0; v < vertexCount; v++, at += VERTEX_BYTES) {
      for (let axis = 0; axis < 3; axis++) {
        if (!Number.isFinite(view.getFloat32(at + axis * 4, true))) this.#nonFinite++;
      }
    }
    this.#verticesLeft -= vertexCount;

    if (this.#verticesLeft === 0) {
      while (this.#facesLeft > 0 && at < data.length) {
        const count = data[at] ?? 0;
        const recordBytes = 1 + count * 4 + 1;
        if (data.length - at < recordBytes) break;
        const face = this.#faces - this.#facesLeft;
        if (count !== 3 && this.#nonTriangles++ === 0) this.#firstNonTriangle = face;
        let badIndex = -1;
        for (let k = 0; k < count && badIndex < 0; k++) {
          const index = view.getUint32(at + 1 + k * 4, true);
          if (index >= this.#vertices) badIndex = index;
        }
        if (badIndex >= 0 && this.#badIndexFaces++ < DETAILED_RECORDS) {
          this.#report({
            code: "ply.vertex_index",
            message: `Face ${face} refers to vertex ${badIndex}, but there are ${this.#vertices} vertices`,
          });
        }
        const classification = data[at + recordBytes - 1] ?? 0;
        if (classification > MAX_CLASSIFICATION && this.#badClassFaces++ < DETAILED_RECORDS) {
          this.#report({
            code: "ply.classification",
            message: `Face ${face} has classification ${classification}; values run from 0 to ${MAX_CLASSIFICATION}`,
          });
        }
        at += recordBytes;
        this.#facesLeft--;
      }
      if (this.#facesLeft === 0) {
        this.#trailingBytes += data.length - at;
        at = data.length;
      }
    }
    // Keep the incomplete record (at most 1 + 255 * 4 + 1 bytes) for the next chunk.
    this.#carry = data.slice(at);
  }

  /** Call after the last chunk; `complete` is false if the file was cut short in transit. */
  end(complete = true): PlyResult | null {
    if (this.#stopped || !complete) return null;
    if (this.#header !== null) {
      this.#report({
        code: "ply.header",
        message: "No end_header line: not a complete PLY header",
      });
      return null;
    }
    if (this.#verticesLeft > 0 || this.#facesLeft > 0) {
      this.#report({
        code: "ply.truncated",
        message: `The body ends with ${this.#verticesLeft} of ${this.#vertices} vertices and ${this.#facesLeft} of ${this.#faces} faces still to come`,
      });
    }
    if (this.#badIndexFaces > DETAILED_RECORDS) {
      this.#report({
        code: "ply.vertex_index",
        message: `${this.#badIndexFaces} faces in all refer to vertices beyond the vertex count`,
      });
    }
    if (this.#badClassFaces > DETAILED_RECORDS) {
      this.#report({
        code: "ply.classification",
        message: `${this.#badClassFaces} faces in all have a classification above ${MAX_CLASSIFICATION}`,
      });
    }
    if (this.#nonTriangles > 0) {
      this.#report({
        code: "ply.non_triangle_face",
        message: `${this.#nonTriangles} ${this.#nonTriangles === 1 ? "face does" : "faces do"} not have 3 vertex indices (the first is face ${this.#firstNonTriangle}); every face is a triangle`,
      });
    }
    if (this.#nonFinite > 0) {
      this.#report({
        code: "ply.non_finite_vertex",
        message: `${this.#nonFinite} vertex coordinates are NaN or infinite`,
      });
    }
    if (this.#trailingBytes > 0) {
      this.#report({
        code: "ply.trailing_bytes",
        message: `${this.#trailingBytes} bytes after the last face`,
      });
    }
    return { vertices: this.#vertices, faces: this.#faces };
  }
}
