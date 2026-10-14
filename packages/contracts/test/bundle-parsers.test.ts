// Unit tests for the streaming parsers: JPEG and PNG headers, the PLY mesh and JSONL lines.

import { describe, expect, test } from "vitest";
import {
  type JpegInfo,
  JpegParser,
  PngParser,
  parsePngHeader,
} from "../src/bundle-validator/images.ts";
import { LineSplitter } from "../src/bundle-validator/jsonl.ts";
import { resolveLimits } from "../src/bundle-validator/limits.ts";
import { PlyParser, type PlyProblem } from "../src/bundle-validator/ply.ts";
import {
  concat,
  jpeg,
  jpegSegment,
  ply,
  plyHeader,
  png,
  scenePly,
  text,
} from "./bundle-fixture.ts";

function inPieces(bytes: Uint8Array, size: number): Uint8Array[] {
  const pieces: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) pieces.push(bytes.subarray(at, at + size));
  return pieces;
}

function parseJpeg(bytes: Uint8Array, pieceSize = bytes.length || 1) {
  const parser = new JpegParser();
  for (const piece of inPieces(bytes, pieceSize)) parser.push(piece);
  return parser.end();
}

function parsePng(bytes: Uint8Array, pieceSize = bytes.length || 1) {
  const parser = new PngParser();
  for (const piece of inPieces(bytes, pieceSize)) parser.push(piece);
  return parser.end();
}

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
/** An SOF0 segment for a one-component width x height. */
const sof0 = (width: number, height: number) =>
  jpegSegment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);
/** A one-component scan header, a little entropy-coded data, and EOI. */
const SCAN_AND_EOI = [...jpegSegment(0xda, [1, 1, 0x00, 0, 63, 0]), 0x12, 0x34, ...EOI];

/** The JPEG with `extra` inserted after SOI (and so before the frame header). */
function withSegmentAfterSoi(extra: readonly number[]): Uint8Array {
  const base = jpeg(16, 12);
  return concat([base.subarray(0, 2), new Uint8Array(extra), base.subarray(2)]);
}

/** An Exif APP1 segment with a little-endian TIFF header and an IFD0 of one entry. */
function exifSegment(nextIfd: number): number[] {
  const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0]; // II, 42, IFD0 at offset 8
  const ifd0 = [1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 1, 0, 0, 0]; // Orientation = 1
  const next = [nextIfd & 0xff, (nextIfd >> 8) & 0xff, 0, 0];
  return jpegSegment(0xe1, [...text("Exif\0\0"), ...tiff, ...ifd0, ...next]);
}

describe("JPEG", () => {
  test.each([1, 2, 7, 1000])("is walked to EOI in pieces of %i bytes", (size) => {
    expect(parseJpeg(jpeg(16, 12), size)).toEqual({
      ok: true,
      value: { width: 16, height: 12, components: 3, extraImage: null } satisfies JpegInfo,
    });
    expect(parseJpeg(jpeg(1920, 1440), size)).toMatchObject({
      ok: true,
      value: { width: 1920, height: 1440, components: 3 },
    });
  });

  test("greyscale, progressive (SOF2) and other SOF markers", () => {
    expect(parseJpeg(jpeg(16, 12, { components: 1 }))).toMatchObject({
      ok: true,
      value: { components: 1 },
    });
    expect(parseJpeg(jpeg(16, 12, { sof: 0xc2 }))).toMatchObject({
      ok: true,
      value: { width: 16 },
    });
    expect(parseJpeg(jpeg(16, 12, { sof: 0xc1 }))).toMatchObject({ ok: true });
  });

  test("fill bytes before a marker, standalone markers and FF bytes inside a segment", () => {
    const bytes = new Uint8Array([
      ...SOI,
      0xff,
      0xff,
      0xff, // fill bytes, then the APP1 marker below
      0xe1,
      0,
      6,
      0xff,
      0xd9,
      0xff,
      0xda, // segment data that looks like markers is skipped by length
      0xff,
      0xd0, // RST0 has no length
      ...sof0(640, 480),
      ...SCAN_AND_EOI,
    ]);
    const expected = { width: 640, height: 480, components: 1, extraImage: null };
    expect(parseJpeg(bytes)).toEqual({ ok: true, value: expected });
    expect(parseJpeg(bytes, 1)).toEqual({ ok: true, value: expected });
  });

  test("DHT (C4), JPG (C8) and DAC (CC) are not frame headers", () => {
    const bytes = new Uint8Array([
      ...SOI,
      ...[0xff, 0xc4, 0, 2],
      ...[0xff, 0xc8, 0, 2],
      ...[0xff, 0xcc, 0, 4, 1, 2],
      ...sof0(8, 8),
      ...SCAN_AND_EOI,
    ]);
    expect(parseJpeg(bytes)).toMatchObject({ ok: true, value: { width: 8, height: 8 } });
  });

  test("entropy-coded data: FF 00, restart markers, fill bytes, and a second scan", () => {
    const bytes = new Uint8Array([
      ...SOI,
      ...sof0(8, 8),
      ...jpegSegment(0xda, [1, 1, 0x00, 0, 63, 0]),
      ...[0x12, 0xff, 0x00, 0x34, 0xff, 0xd3, 0x56, 0xff, 0xff, 0xd4, 0x78], // FF 00, RST3, RST4
      ...jpegSegment(0xc4, [0x10, 1, ...new Array<number>(15).fill(0), 0]), // a DHT between scans
      ...jpegSegment(0xda, [1, 1, 0x00, 1, 63, 0]),
      0x9a,
      ...EOI,
    ]);
    for (const size of [1, 3, 100]) {
      expect(parseJpeg(bytes, size)).toMatchObject({ ok: true, value: { extraImage: null } });
    }
  });

  test.each<[string, Uint8Array, RegExp]>([
    [
      "a JFIF thumbnail",
      withSegmentAfterSoi(
        jpegSegment(0xe0, [...text("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 1, 1, 0x80, 0x80, 0x80]),
      ),
      /JFIF thumbnail/,
    ],
    [
      "a JFXX thumbnail",
      withSegmentAfterSoi(jpegSegment(0xe0, [...text("JFXX\0"), 0x10, ...SOI, ...EOI])),
      /JFXX/,
    ],
    ["an Exif thumbnail (IFD1)", withSegmentAfterSoi(exifSegment(26)), /Exif thumbnail/],
    [
      "an MPF segment",
      withSegmentAfterSoi(jpegSegment(0xe2, [...text("MPF\0"), 0x49, 0x49, 42, 0])),
      /MPF/,
    ],
    ["bytes after EOI", concat([jpeg(16, 12), jpeg(16, 12)]), /bytes after the end of image/],
  ])("%s is reported as an extra image", (_name, bytes, reason) => {
    for (const size of [1, 5, 100_000]) {
      const result = parseJpeg(bytes, size);
      expect(result).toMatchObject({
        ok: true,
        value: { extraImage: expect.stringMatching(reason) },
      });
    }
  });

  test("Exif without a thumbnail and an ICC profile are not extra images", () => {
    const bytes = withSegmentAfterSoi([
      ...exifSegment(0),
      ...jpegSegment(0xe2, [...text("ICC_PROFILE\0"), 1, 1, 0, 0, 0, 0]),
    ]);
    expect(parseJpeg(bytes)).toMatchObject({ ok: true, value: { extraImage: null } });
  });

  test.each<[string, number[], RegExp]>([
    ["no SOI", [0x89, 0x50, 0x4e, 0x47], /SOI/],
    ["empty", [], /ends before a frame header/],
    ["SOS before SOF", [...SOI, 0xff, 0xda, 0, 8], /SOS/],
    ["EOI before SOF", [...SOI, ...EOI], /EOI/],
    ["EOI before a scan", [...SOI, ...sof0(8, 8), ...EOI], /EOI\) before a scan/],
    ["only SOI and a frame header", [...SOI, ...sof0(8, 8)], /ends before a scan/],
    ["no EOI", [...SOI, ...sof0(8, 8), ...jpegSegment(0xda, [1, 1, 0, 0, 63, 0]), 1], /EOI/],
    ["a second SOI", [...SOI, ...SOI], /second SOI/],
    ["a second frame header", [...SOI, ...sof0(8, 8), ...sof0(8, 8)], /second frame header/],
    ["data between segments", [...SOI, 0x00, 0x01], /marker/],
    ["FF 00 as a marker", [...SOI, 0xff, 0x00], /FF 00/],
    ["a segment length below 2", [...SOI, 0xff, 0xe0, 0, 1], /length/],
    ["a short frame header", [...SOI, 0xff, 0xc0, 0, 7, 8, 0, 1, 0, 1], /shorter/],
    ["a short scan header", [...SOI, ...sof0(8, 8), 0xff, 0xda, 0, 7, 1, 1, 0, 0, 63], /shorter/],
    ["height 0", [...SOI, ...sof0(16, 0)], /height 0/],
    ["width 0", [...SOI, ...sof0(0, 12)], /width 0/],
    [
      "a frame header longer than its components",
      [...SOI, ...jpegSegment(0xc0, [8, 0, 8, 0, 8, 1, 1, 0x11, 0, 0, 0, 0])],
      /number of components/,
    ],
    ["a malformed Exif segment", [...SOI, ...jpegSegment(0xe1, [...text("Exif\0\0"), 1])], /Exif/],
    ["cut inside an APP segment", [...SOI, 0xff, 0xe0, 0, 16, 1, 2, 3], /ends before/],
    ["cut inside the frame header", [...SOI, 0xff, 0xc0, 0, 11, 8, 0], /ends before/],
  ])("%s is invalid", (_name, bytes, message) => {
    const result = parseJpeg(new Uint8Array(bytes));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(message);
  });
});

describe("PNG", () => {
  test.each([1, 7, 33, 100_000])("is walked to IEND in pieces of %i bytes", (size) => {
    expect(parsePng(png(256, 192, 16, 1500), size)).toEqual({
      ok: true,
      value: {
        width: 256,
        height: 192,
        bitDepth: 16,
        colourType: 0,
        crcOk: true,
        trailingBytes: 0,
      },
    });
  });

  test("bytes after IEND are counted", () => {
    const one = png(4, 3, 8, 0);
    expect(parsePng(concat([one, one]), 5)).toMatchObject({
      ok: true,
      value: { trailingBytes: one.length },
    });
  });

  test.each<[string, (bytes: Uint8Array) => Uint8Array, RegExp]>([
    ["only the signature and IHDR", (bytes) => bytes.subarray(0, 33), /ends before an IDAT/],
    ["no IEND", (bytes) => bytes.subarray(0, bytes.length - 12), /ends before its IEND/],
    ["cut inside a chunk", (bytes) => bytes.subarray(0, 50), /ends before/],
    [
      "IEND with no IDAT",
      (bytes) => concat([bytes.subarray(0, 33), bytes.subarray(bytes.length - 12)]),
      /No IDAT/,
    ],
    ["a second IHDR", (bytes) => concat([bytes.subarray(0, 33), bytes.subarray(8)]), /second IHDR/],
    [
      "a chunk type that is not letters",
      (bytes) => {
        const copy = bytes.slice();
        copy.set(text("ID1T"), 37);
        return copy;
      },
      /four ASCII letters/,
    ],
  ])("%s is invalid", (_name, change, message) => {
    const result = parsePng(change(png(4, 3, 8, 0)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(message);
  });
});

describe("PNG header", () => {
  test("16-bit and 8-bit greyscale", () => {
    expect(parsePngHeader(png(256, 192, 16, 1500))).toEqual({
      ok: true,
      value: { width: 256, height: 192, bitDepth: 16, colourType: 0, crcOk: true },
    });
    expect(parsePngHeader(png(256, 192, 8, 2).subarray(0, 33))).toMatchObject({
      ok: true,
      value: { bitDepth: 8 },
    });
  });

  test("a bad CRC is reported, not fatal", () => {
    const bytes = png(4, 3, 8, 0);
    bytes[30] = (bytes[30] ?? 0) ^ 1;
    expect(parsePngHeader(bytes)).toMatchObject({ ok: true, value: { crcOk: false } });
  });

  test.each<[string, (bytes: Uint8Array) => Uint8Array, RegExp]>([
    ["too short", (bytes) => bytes.subarray(0, 32), /short/],
    ["a wrong signature", (bytes) => concat([text("GIF89a.."), bytes.subarray(8)]), /signature/],
    [
      "a first chunk that is not IHDR",
      (bytes) => {
        const copy = bytes.slice();
        copy.set(text("IDAT"), 12);
        return copy;
      },
      /IHDR/,
    ],
    [
      "width 0",
      (bytes) => {
        const copy = bytes.slice();
        copy.set([0, 0, 0, 0], 16);
        return copy;
      },
      /width or height/,
    ],
    [
      "bit depth 16 with palette colour",
      (bytes) => {
        const copy = bytes.slice();
        copy[25] = 3;
        return copy;
      },
      /colour type 3 with bit depth 16/,
    ],
    [
      "an unknown interlace method",
      (bytes) => {
        const copy = bytes.slice();
        copy[28] = 2;
        return copy;
      },
      /interlace/,
    ],
  ])("%s is invalid", (_name, change, message) => {
    const result = parsePngHeader(change(png(256, 192, 16, 1500)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(message);
  });
});

function parsePly(bytes: Uint8Array, pieceSize = bytes.length || 1, limits = resolveLimits()) {
  const problems: PlyProblem[] = [];
  const parser = new PlyParser(limits, (problem) => problems.push(problem));
  for (const piece of inPieces(bytes, pieceSize)) parser.push(piece);
  return { result: parser.end(), problems };
}

describe("PLY", () => {
  test.each([1, 3, 13, 100_000])("parses the scene mesh in pieces of %i bytes", (size) => {
    expect(parsePly(scenePly(), size)).toEqual({ result: { vertices: 5, faces: 3 }, problems: [] });
  });

  test("an empty mesh", () => {
    expect(parsePly(ply([], []))).toEqual({ result: { vertices: 0, faces: 0 }, problems: [] });
  });

  test.each<[string, string]>([
    ["a count with a sign", plyHeader(0, 0).replace("vertex 0", "vertex +0")],
    ["a count with a leading zero", plyHeader(1, 0).replace("vertex 1", "vertex 01")],
    ["a negative count", plyHeader(0, 0).replace("face 0", "face -1")],
    ["a big-endian format", plyHeader(0, 0).replace("little", "big")],
    ["format version 1.1", plyHeader(0, 0).replace("1.0", "1.1")],
    [
      "an extra property",
      plyHeader(0, 0).replace("property float z\n", "property float z\nproperty uchar red\n"),
    ],
    ["an int vertex index list", plyHeader(0, 0).replace("uchar uint", "uchar int")],
    [
      "the elements swapped",
      plyHeader(0, 0)
        .replace("element vertex 0", "element face 0")
        .replace("element face 0\nproperty list", "element vertex 0\nproperty list"),
    ],
    ["a trailing space", plyHeader(0, 0).replace("ply\n", "ply \n")],
    ["a tab", plyHeader(0, 0).replace("format ", "format\t")],
    ["no magic line", plyHeader(0, 0).replace("ply\n", "")],
  ])("a header with %s is rejected", (_name, header) => {
    const { result, problems } = parsePly(text(header));
    expect(result).toBeNull();
    expect(problems.map((problem) => problem.code)).toEqual(["ply.header"]);
  });

  test("no end_header", () => {
    const { problems } = parsePly(text("ply\nformat binary_little_endian 1.0\n"));
    expect(problems.map((problem) => problem.code)).toEqual(["ply.header"]);
  });

  test("the header length limit", () => {
    const { problems } = parsePly(
      text(`ply\n${"x".repeat(100)}`),
      7,
      resolveLimits({ maxPlyHeaderBytes: 64 }),
    );
    expect(problems).toEqual([
      { code: "ply.header", message: expect.stringMatching(/first 64 bytes/) },
    ]);
  });

  test("counts over the limits stop the parse before the body", () => {
    const header = text(plyHeader(10_000_001, 0));
    expect(parsePly(header).problems.map((problem) => problem.code)).toEqual([
      "limits.ply_vertices",
    ]);
    const faces = text(plyHeader(0, 99_999_999));
    expect(parsePly(faces).problems.map((problem) => problem.code)).toEqual(["limits.ply_faces"]);
  });

  test("bad indices and classifications are reported five at a time, then counted", () => {
    const faces = Array.from({ length: 8 }, () => ({ indices: [0, 1, 7], classification: 9 }));
    const { problems } = parsePly(
      ply(
        [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
        faces,
      ),
      5,
    );
    const byCode = (code: string) => problems.filter((problem) => problem.code === code);
    expect(byCode("ply.vertex_index")).toHaveLength(6);
    expect(byCode("ply.classification")).toHaveLength(6);
    expect(byCode("ply.vertex_index")[5]?.message).toMatch(/^8 faces in all/);
  });

  test("a body cut inside a vertex or a face", () => {
    const mesh = scenePly();
    for (const cut of [mesh.length - 1, mesh.length - 20, mesh.length - 50]) {
      expect(parsePly(mesh.subarray(0, cut), 4).problems.map((problem) => problem.code)).toEqual([
        "ply.truncated",
      ]);
    }
  });

  test("a file cut short in transit reports nothing more", () => {
    const parser = new PlyParser(resolveLimits(), () => {
      throw new Error("no problems expected");
    });
    parser.push(scenePly().subarray(0, 250));
    expect(parser.end(false)).toBeNull();
  });
});

describe("JSONL lines", () => {
  function split(chunks: string[], max = 100) {
    const lines: [number, string][] = [];
    const tooLong: number[] = [];
    const splitter = new LineSplitter(
      max,
      (bytes, line) => lines.push([line, new TextDecoder().decode(bytes)]),
      (line) => tooLong.push(line),
    );
    for (const chunk of chunks) splitter.push(text(chunk));
    splitter.end();
    return { lines, tooLong };
  }

  test("lines across chunks, and a last line without a newline", () => {
    expect(split(['{"a":', '1}\n{"b"', ":2}\n", '{"c":3}']).lines).toEqual([
      [1, '{"a":1}'],
      [2, '{"b":2}'],
      [3, '{"c":3}'],
    ]);
  });

  test("blank lines are passed on; a final newline adds no line", () => {
    expect(split(["a\n\nb\n"]).lines).toEqual([
      [1, "a"],
      [2, ""],
      [3, "b"],
    ]);
    expect(split([""]).lines).toEqual([]);
  });

  test("a line over the limit is reported by number, whole or in pieces", () => {
    const long = "x".repeat(150);
    expect(split([`a\n${long}\nb\n`])).toEqual({
      lines: [
        [1, "a"],
        [3, "b"],
      ],
      tooLong: [2],
    });
    expect(split(["a\n", long.slice(0, 80), long.slice(80), "\nb"])).toEqual({
      lines: [
        [1, "a"],
        [3, "b"],
      ],
      tooLong: [2],
    });
    expect(split([long]).tooLong).toEqual([1]);
  });
});
