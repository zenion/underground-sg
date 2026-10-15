import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { FONT_STACK, GLYPH_RANGES } from "../src/index.ts";

const GLYPHS_DIR = new URL("../glyphs/", import.meta.url);
const README = readFileSync(new URL("README.md", GLYPHS_DIR), "utf8");

function readGlyphs(range: string): Uint8Array {
  return readFileSync(new URL(`${encodeURIComponent(FONT_STACK)}/${range}.pbf`, GLYPHS_DIR));
}

// A minimal protobuf reader for the glyph PBF format (MapLibre's glyphs.proto): message glyphs
// { repeated fontstack stacks = 1; }, fontstack { string name = 1; string range = 2; repeated
// glyph glyphs = 3; }, glyph { uint32 id = 1; bytes bitmap = 2; ... }.

interface Field {
  number: number;
  wireType: number;
  value: number | Uint8Array;
}

function* fields(bytes: Uint8Array): Generator<Field> {
  let at = 0;
  const varint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[at++];
      if (byte === undefined) throw new Error("truncated varint");
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
  };
  while (at < bytes.length) {
    const key = varint();
    const number = Math.floor(key / 8);
    const wireType = key % 8;
    if (wireType === 0) yield { number, wireType, value: varint() };
    else if (wireType === 2) {
      const length = varint();
      yield { number, wireType, value: bytes.subarray(at, at + length) };
      at += length;
    } else if (wireType === 5) {
      at += 4;
    } else if (wireType === 1) {
      at += 8;
    } else throw new Error(`unexpected wire type ${wireType}`);
  }
}

interface FontStack {
  name: string;
  range: string;
  glyphIds: number[];
}

function decode(bytes: Uint8Array): FontStack[] {
  const stacks: FontStack[] = [];
  for (const stack of fields(bytes)) {
    if (stack.number !== 1 || !(stack.value instanceof Uint8Array)) throw new Error("not a stack");
    const decoded: FontStack = { name: "", range: "", glyphIds: [] };
    for (const field of fields(stack.value)) {
      if (field.number === 1 && field.value instanceof Uint8Array) {
        decoded.name = new TextDecoder().decode(field.value);
      } else if (field.number === 2 && field.value instanceof Uint8Array) {
        decoded.range = new TextDecoder().decode(field.value);
      } else if (field.number === 3 && field.value instanceof Uint8Array) {
        for (const glyphField of fields(field.value)) {
          if (glyphField.number === 1 && typeof glyphField.value === "number") {
            decoded.glyphIds.push(glyphField.value);
          }
        }
      }
    }
    stacks.push(decoded);
  }
  return stacks;
}

describe("vendored glyphs", () => {
  test("glyphs/ holds one font stack with exactly the listed ranges", () => {
    expect(readdirSync(GLYPHS_DIR).sort()).toEqual([FONT_STACK, "OFL.txt", "README.md"].sort());
    expect(readdirSync(new URL(`${encodeURIComponent(FONT_STACK)}/`, GLYPHS_DIR)).sort()).toEqual(
      GLYPH_RANGES.map((range) => `${range}.pbf`).sort(),
    );
  });

  test.each(GLYPH_RANGES)("%s.pbf matches the size and SHA-256 in glyphs/README.md", (range) => {
    const bytes = readGlyphs(range);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(README).toContain(`| \`${FONT_STACK}/${range}.pbf\` | `);
    expect(README).toMatch(
      new RegExp(`${range}\\.pbf\` \\|[^|]*\\| ${bytes.byteLength} \\| \`${sha256}\``),
    );
  });

  test.each(GLYPH_RANGES)("%s.pbf is one font stack of its range", (range) => {
    const stacks = decode(readGlyphs(range));
    expect(stacks).toHaveLength(1);
    const [start, end] = range.split("-").map(Number) as [number, number];
    expect(stacks[0]?.range).toBe(range);
    for (const glyphId of stacks[0]?.glyphIds ?? []) {
      expect(glyphId).toBeGreaterThanOrEqual(start);
      expect(glyphId).toBeLessThanOrEqual(end);
    }
  });

  test("0-255.pbf has every printable Basic Latin and Latin-1 character", () => {
    const ids = new Set(decode(readGlyphs("0-255"))[0]?.glyphIds);
    const printable = [
      ...Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => 0x20 + i),
      ...Array.from({ length: 0xff - 0xa0 + 1 }, (_, i) => 0xa0 + i),
    ];
    expect(printable.filter((code) => !ids.has(code))).toEqual([]);
  });

  test("8192-8447.pbf has curly quotes, dashes, the ellipsis and the euro sign", () => {
    const ids = new Set(decode(readGlyphs("8192-8447"))[0]?.glyphIds);
    for (const char of "‘’“”–—…€") expect(ids.has(char.codePointAt(0) ?? 0), char).toBe(true);
  });

  test("the licence ships with the glyphs", () => {
    const licence = readFileSync(new URL("OFL.txt", GLYPHS_DIR), "utf8");
    expect(licence).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(licence).toContain("The Noto Project Authors");
    expect(README).toContain("[OFL.txt](OFL.txt)");
  });
});
