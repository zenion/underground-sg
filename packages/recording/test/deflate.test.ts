// The deterministic raw DEFLATE: what any inflater reads back, and the same bytes every run.

import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { prng } from "@usg/floorplan/synthetic";
import { describe, expect, test } from "vitest";
import { deflateRaw } from "../src/deflate.ts";

function randomBytes(length: number, seed: number): Uint8Array {
  const random = prng(seed);
  return Uint8Array.from({ length }, () => Math.floor(random() * 256));
}

function roundTrips(data: Uint8Array): Uint8Array {
  const compressed = deflateRaw(data);
  expect(new Uint8Array(inflateRawSync(compressed))).toEqual(data);
  return compressed;
}

describe("deflateRaw", () => {
  test("empty input", () => {
    roundTrips(new Uint8Array(0));
  });

  test("short inputs, below and at the minimum match", () => {
    for (const text of ["a", "ab", "abc", "abcabc", "aaaa"]) {
      roundTrips(new TextEncoder().encode(text));
    }
  });

  test("repetitive data compresses with matches, the longest 258 bytes", () => {
    const data = new Uint8Array(100_000).fill(7);
    const compressed = roundTrips(data);
    expect(compressed.length).toBeLessThan(1000);
  });

  test("matches as far back as the 32 KiB window", () => {
    const block = randomBytes(32_000, 1);
    const data = new Uint8Array(3 * block.length);
    for (let i = 0; i < 3; i++) data.set(block, i * block.length);
    const compressed = roundTrips(data);
    // The first copy costs about 8.4 bits a byte as fixed-code literals; the others are matches.
    expect(compressed.length).toBeLessThan(1.1 * block.length);
  });

  test("incompressible data falls back to stored blocks of at most 65,535 bytes", () => {
    const data = randomBytes(200_000, 2);
    const compressed = roundTrips(data);
    expect(compressed.length).toBe(data.length + 5 * Math.ceil(data.length / 65_535));
  });

  test("float32 mesh-like data", () => {
    const random = prng(3);
    const values = Float32Array.from({ length: 30_000 }, () => Math.round(random() * 400) / 16);
    roundTrips(new Uint8Array(values.buffer));
  });

  test("the same input gives the same bytes", () => {
    const data = randomBytes(50_000, 4).map((byte) => byte & 0x0f);
    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    expect(digest(deflateRaw(data))).toBe(digest(deflateRaw(Uint8Array.from(data))));
  });
});
