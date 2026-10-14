// Fuzz tests: random byte changes and cuts to the tar, the PLY, the PNGs, the JPEGs and the JSONL
// never make the validator throw or hang; it returns a report. Deterministic: a fixed seed and a
// bounded number of runs, both overridable, for example
//   FUZZ_SEED=7 FUZZ_RUNS=5000 pnpm --filter @usg/contracts exec vitest run test/bundle-fuzz.test.ts

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { JpegParser, PngParser, parsePngHeader } from "../src/bundle-validator/images.ts";
import { type ValidationReport, validateBundleTar } from "../src/bundle-validator/index.ts";
import { resolveLimits } from "../src/bundle-validator/limits.ts";
import { PlyParser } from "../src/bundle-validator/ply.ts";
import { type BundleFiles, bundle, fullSpec, withManifest } from "./bundle-fixture.ts";
import { bundleTar } from "./tar-writer.ts";

const SEED = Number(process.env["FUZZ_SEED"] ?? 20261015);
const RUNS = Number(process.env["FUZZ_RUNS"] ?? 150);
/** Each validation of a small mutated bundle must finish well within this. */
const BUDGET_MS = 2_000;
const TEST_TIMEOUT_MS = 120_000;

interface Mutation {
  readonly edits: readonly { readonly at: number; readonly byte: number }[];
  readonly cut: number | null;
  readonly insert: { readonly at: number; readonly bytes: Uint8Array } | null;
  readonly chunkSize: number;
}

const mutation: fc.Arbitrary<Mutation> = fc.record({
  edits: fc.array(fc.record({ at: fc.nat(), byte: fc.integer({ min: 0, max: 255 }) }), {
    maxLength: 12,
  }),
  cut: fc.option(fc.nat(), { nil: null }),
  insert: fc.option(
    fc.record({ at: fc.nat(), bytes: fc.uint8Array({ minLength: 1, maxLength: 600 }) }),
    { nil: null },
  ),
  chunkSize: fc.oneof(fc.integer({ min: 1, max: 64 }), fc.integer({ min: 65, max: 70_000 })),
});

function mutate(base: Uint8Array, m: Mutation): Uint8Array {
  let bytes = base.slice();
  for (const edit of m.edits) {
    if (bytes.length > 0) bytes[edit.at % bytes.length] = edit.byte;
  }
  if (m.insert !== null) {
    const at = m.insert.at % (bytes.length + 1);
    const grown = new Uint8Array(bytes.length + m.insert.bytes.length);
    grown.set(bytes.subarray(0, at));
    grown.set(m.insert.bytes, at);
    grown.set(bytes.subarray(at), at + m.insert.bytes.length);
    bytes = grown;
  }
  if (m.cut !== null) bytes = bytes.subarray(0, m.cut % (bytes.length + 1));
  return bytes;
}

async function* chunks(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

async function timedValidation(bytes: Uint8Array, chunkSize: number): Promise<ValidationReport> {
  const started = performance.now();
  const report = await validateBundleTar(chunks(bytes, chunkSize));
  const elapsed = performance.now() - started;
  expect(elapsed).toBeLessThan(BUDGET_MS);
  expect(typeof report.valid).toBe("boolean");
  expect(report.valid).toBe(report.errors.length === 0);
  return report;
}

const options = { seed: SEED, numRuns: RUNS };
const files = bundle(fullSpec());
const tar = bundleTar(files);

/** The bundle with one file replaced by mutated bytes (and manifest.files updated to match). */
function withFile(path: string, bytes: Uint8Array): Uint8Array {
  const changed: BundleFiles = new Map(files);
  changed.set(path, bytes);
  const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json"))) as Record<
    string,
    unknown
  >;
  return bundleTar(withManifest(changed, manifest));
}

function original(path: string): Uint8Array {
  const bytes = files.get(path);
  if (bytes === undefined) throw new Error(`No ${path} in the fixture`);
  return bytes;
}

describe(`fuzz (seed ${SEED}, ${RUNS} runs)`, () => {
  test(
    "a mutated tar gives a report",
    async () => {
      await fc.assert(
        fc.asyncProperty(mutation, async (m) => {
          await timedValidation(mutate(tar, m), m.chunkSize);
        }),
        options,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "mutated tar headers give a report",
    async () => {
      // Edits only in the first 4 KiB, where the headers of the directory entries are.
      const headerEdit = fc.record({
        edits: fc.array(fc.record({ at: fc.nat(4095), byte: fc.integer({ min: 0, max: 255 }) }), {
          minLength: 1,
          maxLength: 6,
        }),
        cut: fc.constant(null),
        insert: fc.constant(null),
        chunkSize: fc.integer({ min: 1, max: 4096 }),
      });
      await fc.assert(
        fc.asyncProperty(headerEdit, async (m) => {
          await timedValidation(mutate(tar, m), m.chunkSize);
        }),
        options,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test.each([
    "mesh/scene.ply",
    "depth/000000.png",
    "confidence/000003.png",
    "keyframes/000003.jpg",
    "poses.jsonl",
    "privacy/blur.jsonl",
    "manifest.json",
  ])(
    "a mutated %s inside a bundle gives a report",
    async (path) => {
      await fc.assert(
        fc.asyncProperty(mutation, async (m) => {
          const report = await timedValidation(
            withFile(path, mutate(original(path), m)),
            m.chunkSize,
          );
          // The rest of the bundle is unchanged, so it is still read to the end.
          expect(report.info.checks_skipped.join(" ")).not.toMatch(/could not be read/);
        }),
        options,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the PLY parser takes any bytes",
    () => {
      fc.assert(
        fc.property(mutation, (m) => {
          const parser = new PlyParser(resolveLimits(), () => {});
          const bytes = mutate(original("mesh/scene.ply"), m);
          for (let at = 0; at < bytes.length; at += m.chunkSize) {
            parser.push(bytes.subarray(at, at + m.chunkSize));
          }
          parser.end();
        }),
        { ...options, numRuns: RUNS * 4 },
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the image parsers take any bytes",
    () => {
      fc.assert(
        fc.property(mutation, fc.uint8Array({ maxLength: 64 }), (m, random) => {
          const jpeg = new JpegParser();
          const bytes = mutate(original("keyframes/000003.jpg"), m);
          for (let at = 0; at < bytes.length; at += m.chunkSize) {
            jpeg.push(bytes.subarray(at, at + m.chunkSize));
          }
          jpeg.end();
          new JpegParser().push(random);
          const png = new PngParser();
          const pngBytes = mutate(original("depth/000000.png"), m);
          for (let at = 0; at < pngBytes.length; at += m.chunkSize) {
            png.push(pngBytes.subarray(at, at + m.chunkSize));
          }
          png.end();
          new PngParser().push(random);
          parsePngHeader(pngBytes.subarray(0, 33));
          parsePngHeader(random);
        }),
        { ...options, numRuns: RUNS * 4 },
      );
    },
    TEST_TIMEOUT_MS,
  );
});
