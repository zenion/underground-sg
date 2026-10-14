// The container: the strict tar reader, the directory walker, the path rules and the limits.

import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  BundleIoError,
  DEFAULT_BUNDLE_LIMITS,
  type ProblemCode,
  resolveLimits,
  validateBundle,
  validateBundleDirectory,
  validateBundleTar,
} from "../src/bundle-validator/index.ts";
import {
  BUNDLE_DIR,
  bundle,
  concat,
  removeBundleDirectories,
  text,
  writeBundleDirectory,
} from "./bundle-fixture.ts";
import { bundleEntries, bundleTar, chunks, type TarEntry, writeTar } from "./tar-writer.ts";
import {
  codes,
  expectClean,
  expectProblem,
  validateAsDirectory,
  validateAsTar,
} from "./validator-helpers.ts";

afterAll(removeBundleDirectories);

const files = bundle();

/** The valid bundle's tar entries with `extra` added after them. */
function tarWith(...extra: TarEntry[]): Uint8Array {
  return writeTar([...bundleEntries(files), ...extra]);
}

function validateBytes(bytes: Uint8Array) {
  return validateBundleTar(chunks(bytes, 1000));
}

describe("tar members", () => {
  const data = text("x");
  test.each<[string, TarEntry, ProblemCode]>([
    ["a .. segment", { name: `${BUNDLE_DIR}/../evil.json`, data }, "path.dot_dot"],
    ["a .. escape at the start", { name: "../evil.json", data }, "path.dot_dot"],
    ["an absolute path", { name: "/etc/passwd", data }, "path.absolute"],
    ["a Windows drive path", { name: "C:/Windows/evil.dll", data }, "path.absolute"],
    ["a backslash", { name: `${BUNDLE_DIR}\\tags.json`, data }, "path.backslash"],
    ["a ./ prefix", { name: `./${BUNDLE_DIR}/tags.json`, data }, "path.not_normalised"],
    ["an empty segment", { name: `${BUNDLE_DIR}//tags.json`, data }, "path.not_normalised"],
    ["an empty name", { name: "", data }, "path.invalid"],
    ["a file name ending in /", { name: `${BUNDLE_DIR}/notes/`, data }, "path.invalid"],
    [
      "a non-ASCII name",
      { name: "", nameBytes: text(`${BUNDLE_DIR}/k\u00e9yframes/000000.jpg`), data },
      "path.invalid",
    ],
    [
      "a file outside the bundle directory",
      { name: "manifest.json", data },
      "path.outside_bundle_directory",
    ],
    [
      "a second bundle directory",
      { name: "capture-0c4f1a2b-3d5e-4f60-8a7b-9c0d1e2f3a4b/tags.json", data },
      "path.outside_bundle_directory",
    ],
    ["an unknown file", { name: `${BUNDLE_DIR}/notes.txt`, data }, "path.outside_layout"],
    [
      "a frame name not zero-padded",
      { name: `${BUNDLE_DIR}/keyframes/1.jpg`, data },
      "path.outside_layout",
    ],
    ["a keyframe PNG", { name: `${BUNDLE_DIR}/keyframes/000000.png`, data }, "path.outside_layout"],
    [
      "a nested file",
      { name: `${BUNDLE_DIR}/keyframes/a/000000.jpg`, data },
      "path.outside_layout",
    ],
    ["an unknown directory", { name: `${BUNDLE_DIR}/extra/`, type: "5" }, "path.outside_layout"],
    [
      "a symbolic link",
      { name: `${BUNDLE_DIR}/link.json`, type: "2", linkname: "/etc/passwd" },
      "entry.link",
    ],
    [
      "a hard link",
      { name: `${BUNDLE_DIR}/tags2.json`, type: "1", linkname: `${BUNDLE_DIR}/tags.json` },
      "entry.link",
    ],
    ["a character device", { name: `${BUNDLE_DIR}/dev`, type: "3" }, "entry.special_file"],
    ["a block device", { name: `${BUNDLE_DIR}/disk`, type: "4" }, "entry.special_file"],
    ["a FIFO", { name: `${BUNDLE_DIR}/pipe`, type: "6" }, "entry.special_file"],
    [
      "a pax extended header",
      { name: "PaxHeader/x", type: "x", data: text("30 path=capture-x/a.json\n") },
      "tar.unsupported_entry",
    ],
    [
      "a pax global header",
      { name: "pax_global_header", type: "g", data: text("20 comment=hello\n") },
      "tar.unsupported_entry",
    ],
    [
      "a GNU long name",
      { name: "././@LongLink", type: "L", data: text("long name\u0000") },
      "tar.unsupported_entry",
    ],
    [
      "a duplicate member",
      { name: `${BUNDLE_DIR}/tags.json`, data: text("[]") },
      "entry.duplicate",
    ],
    ["a directory listed twice", { name: `${BUNDLE_DIR}/mesh/`, type: "5" }, "entry.duplicate"],
  ])("%s is rejected", async (_name, entry, code) => {
    const report = await validateBytes(tarWith(entry));
    expect(report.valid).toBe(false);
    expectProblem(report, code);
    // The rest of the bundle is still read and checked.
    expect(report.info.checks_skipped).toEqual([]);
  });

  test("a directory entry with data is rejected", async () => {
    const entries = bundleEntries(files).map((entry) =>
      entry.name === `${BUNDLE_DIR}/mesh/` ? { ...entry, data: text("x") } : entry,
    );
    expectProblem(await validateBytes(writeTar(entries)), "tar.bad_header", "mesh/");
  });

  test("a bundle directory with an uppercase UUID is rejected once", async () => {
    const top = BUNDLE_DIR.toUpperCase().replace("CAPTURE", "capture");
    const report = await validateBytes(writeTar(bundleEntries(files, top)));
    const outside = report.errors.filter((p) => p.code === "path.outside_bundle_directory");
    expect(outside).toHaveLength(1);
    expect(outside[0]?.file).toBe(top);
  });

  test("GNU-style headers are accepted", async () => {
    const entries = bundleEntries(files).map((entry) => ({ ...entry, magic: "gnu" as const }));
    expectClean(await validateBytes(writeTar(entries)));
  });

  test("the POSIX prefix field is joined to the name", async () => {
    const entries = bundleEntries(files).map((entry) => {
      const slash = entry.name.indexOf("/");
      return entry.type === "5"
        ? entry
        : { ...entry, prefix: entry.name.slice(0, slash), name: entry.name.slice(slash + 1) };
    });
    expectClean(await validateBytes(writeTar(entries)));
  });

  test("zero padding after the end-of-archive marker is accepted (tar's 10 KiB records)", async () => {
    const tar = bundleTar(files);
    const padded = concat([tar, new Uint8Array(10_240 - (tar.length % 10_240))]);
    expectClean(await validateBytes(padded));
  });
});

describe("malformed tars", () => {
  const tar = bundleTar(files);

  test.each<[string, () => Uint8Array, ProblemCode]>([
    ["an empty stream", () => new Uint8Array(0), "tar.truncated"],
    ["a cut inside a member", () => tar.subarray(0, tar.length - 1024 - 100), "tar.truncated"],
    ["a cut inside a header", () => tar.subarray(0, 512 * 2 + 100), "tar.truncated"],
    [
      "no end-of-archive marker",
      () => writeTar(bundleEntries(files), { endBlocks: 0 }),
      "tar.truncated",
    ],
    [
      "a single zero block at the end",
      () => writeTar(bundleEntries(files), { endBlocks: 1 }),
      "tar.truncated",
    ],
    [
      "a bad header checksum",
      () =>
        writeTar([
          ...bundleEntries(files).slice(0, 3),
          { name: `${BUNDLE_DIR}/x`, checksumError: 1 },
        ]),
      "tar.bad_checksum",
    ],
    [
      "a header without the ustar magic",
      () => writeTar([{ name: `${BUNDLE_DIR}/`, type: "5", magic: "none" }]),
      "tar.bad_header",
    ],
    [
      "gzip data",
      () => concat([new Uint8Array([0x1f, 0x8b, 8, 0]), new Uint8Array(1020)]),
      "tar.bad_header",
    ],
    ["text that is not a tar", () => text("ply\n".repeat(200)), "tar.bad_header"],
    [
      "a zero block followed by a header",
      () => concat([new Uint8Array(512), writeTar(bundleEntries(files))]),
      "tar.bad_header",
    ],
  ])("%s fails and stops the cross-file checks", async (_name, build, code) => {
    const report = await validateBytes(build());
    expect(report.valid).toBe(false);
    expectProblem(report, code);
    expect(report.info.checks_skipped[0]).toMatch(/could not be read to the end/);
  });

  test("a gzip input is named as such", async () => {
    const report = await validateBytes(
      concat([new Uint8Array([0x1f, 0x8b]), new Uint8Array(1022)]),
    );
    expect(report.errors[0]?.message).toMatch(/gzip/);
  });

  test("a base-256 size field is rejected", async () => {
    const tarBytes = writeTar([{ name: `${BUNDLE_DIR}/`, type: "5" }]);
    tarBytes[124] = 0x80;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (tarBytes[i] ?? 0);
    tarBytes.set(text(`${sum.toString(8).padStart(6, "0")}\u0000 `), 148);
    const report = await validateBytes(tarBytes);
    expectProblem(report, "tar.bad_header");
    expect(report.errors[0]?.message).toMatch(/[Bb]ase-256/);
  });

  test("data after the end-of-archive marker is rejected", async () => {
    const report = await validateBytes(
      writeTar(bundleEntries(files), { trailing: text("garbage") }),
    );
    expectProblem(report, "tar.trailing_data");
    // The archive itself was complete, so the other checks ran.
    expect(report.info.checks_skipped).toEqual([]);
  });

  test("a source that fails is an IO error, not a verdict", async () => {
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield tar.subarray(0, 1024);
      throw new Error("connection reset");
    }
    await expect(validateBundleTar(failing())).rejects.toBeInstanceOf(BundleIoError);
  });

  test("a source of strings is an IO error", async () => {
    async function* strings(): AsyncGenerator<string> {
      yield "not bytes";
    }
    await expect(validateBundleTar(strings())).rejects.toBeInstanceOf(BundleIoError);
  });

  test("the source is closed when reading stops early", async () => {
    let closed = false;
    async function* source(): AsyncGenerator<Uint8Array> {
      try {
        yield text("x".repeat(600));
        yield new Uint8Array(100_000);
      } finally {
        closed = true;
      }
    }
    const report = await validateBundleTar(source());
    expect(report.valid).toBe(false);
    expect(closed).toBe(true);
  });
});

describe("bundle directories", () => {
  test("a directory with the wrong name is reported once, and its contents still checked", async () => {
    const report = await validateAsDirectory(files, {}, "my-bundle");
    expect(codes(report)).toEqual(["path.outside_bundle_directory"]);
    expect(report.info.frames).toBe(4);
  });

  test("a directory named after another capture is rejected", async () => {
    const report = await validateAsDirectory(
      files,
      {},
      "capture-0c4f1a2b-3d5e-4f60-8a7b-9c0d1e2f3a4b",
    );
    expectProblem(report, "bundle.capture_id_mismatch");
  });

  test("unknown files and directories are rejected; unknown directories are not walked", async () => {
    const root = writeBundleDirectory(files);
    writeFileSync(join(root, "notes.txt"), "hello");
    mkdirSync(join(root, "extra", "deeper"), { recursive: true });
    writeFileSync(join(root, "extra", "deeper", "anchors.json"), "[]");
    mkdirSync(join(root, "keyframes", "nested"));
    const report = await validateBundleDirectory(root);
    expectProblem(report, "path.outside_layout", "notes.txt");
    expectProblem(report, "path.outside_layout", "extra/");
    expectProblem(report, "path.outside_layout", "keyframes/nested/");
    expect(report.errors.some((p) => p.file?.includes("deeper") === true)).toBe(false);
  });

  test("a linked directory (a junction on Windows) is rejected and not followed", async () => {
    const root = writeBundleDirectory(files);
    const target = join(root, "..", "outside");
    mkdirSync(target);
    writeFileSync(join(target, "000009.png"), "secret");
    symlinkSync(target, join(root, "preview"), "junction");
    const report = await validateBundleDirectory(root);
    expectProblem(report, "entry.link", "preview");
    expect(JSON.stringify(report)).not.toContain("000009");
  });

  test("a linked file is rejected and not read", async (context) => {
    const root = writeBundleDirectory(files);
    const outside = join(root, "..", "elsewhere.json");
    writeFileSync(outside, "[]");
    try {
      symlinkSync(outside, join(root, "gnss.jsonl"), "file");
    } catch (error) {
      // Windows needs Developer Mode or admin rights for file symlinks.
      if ((error as NodeJS.ErrnoException).code === "EPERM") context.skip();
      throw error;
    }
    const report = await validateBundleDirectory(root);
    expectProblem(report, "entry.link", "gnss.jsonl");
  });

  test("a path that does not exist is an IO error", async () => {
    await expect(
      validateBundle(join(writeBundleDirectory(files), "missing")),
    ).rejects.toBeInstanceOf(BundleIoError);
    await expect(
      validateBundleDirectory(join(writeBundleDirectory(files), "manifest.json")),
    ).rejects.toBeInstanceOf(BundleIoError);
  });
});

describe("limits", () => {
  test("the defaults are the documented values", () => {
    const doc = readFileSync(new URL("../../../docs/capture-bundle.md", import.meta.url), "utf8");
    for (const [name, value] of Object.entries(DEFAULT_BUNDLE_LIMITS)) {
      expect(doc, `docs/capture-bundle.md gives ${name}`).toContain(`\`${name}\``);
      const row = doc.split("\n").find((line) => line.includes(`\`${name}\``)) ?? "";
      expect(row, name).toContain(describeLimit(name, value as number));
    }
  });

  test("limits must be positive integers", () => {
    expect(() => resolveLimits({ maxEntries: 0 })).toThrow(TypeError);
    expect(() => resolveLimits({ maxJsonBytes: 1.5 })).toThrow(TypeError);
    expect(resolveLimits({ maxEntries: 5 }).maxEntries).toBe(5);
  });

  const cases: [string, Partial<typeof DEFAULT_BUNDLE_LIMITS>, ProblemCode, string | null][] = [
    ["maxEntries", { maxEntries: 10 }, "limits.entry_count", null],
    ["maxJsonBytes", { maxJsonBytes: 100 }, "limits.file_size", "anchors.json"],
    ["maxJsonlBytes", { maxJsonlBytes: 100 }, "limits.file_size", "poses.jsonl"],
    ["maxJsonlLineBytes", { maxJsonlLineBytes: 100 }, "limits.line_length", "poses.jsonl"],
    ["maxJpegBytes", { maxJpegBytes: 100 }, "limits.file_size", "keyframes/000000.jpg"],
    ["maxPngBytes", { maxPngBytes: 100 }, "limits.file_size", "depth/000000.png"],
    ["maxPlyBytes", { maxPlyBytes: 100 }, "limits.file_size", "mesh/scene.ply"],
    ["maxPlyHeaderBytes", { maxPlyHeaderBytes: 100 }, "ply.header", "mesh/scene.ply"],
    ["maxPlyVertices", { maxPlyVertices: 4 }, "limits.ply_vertices", "mesh/scene.ply"],
    ["maxPlyFaces", { maxPlyFaces: 2 }, "limits.ply_faces", "mesh/scene.ply"],
    ["maxImagePixels", { maxImagePixels: 191 }, "limits.image_pixels", "manifest.json"],
  ];

  test.each(cases)("%s", async (_name, limits, code, file) => {
    for (const report of [
      await validateAsTar(files, { limits }),
      await validateAsDirectory(files, { limits }),
    ]) {
      expect(report.valid).toBe(false);
      expectProblem(report, code, file);
    }
  });

  test("maxBundleBytes, for a tar and for a directory", async () => {
    const tarReport = await validateAsTar(files, { limits: { maxBundleBytes: 8000 } });
    expectProblem(tarReport, "limits.bundle_size");
    expect(tarReport.info.checks_skipped[0]).toMatch(/could not be read to the end/);
    const dirReport = await validateAsDirectory(files, { limits: { maxBundleBytes: 2000 } });
    expectProblem(dirReport, "limits.bundle_size");
  });

  test("a huge declared member size stops the read before any of it is read", async () => {
    let read = 0;
    const tarBytes = writeTar([
      { name: `${BUNDLE_DIR}/`, type: "5" },
      { name: `${BUNDLE_DIR}/mesh/scene.ply`, size: 8 ** 11 - 1 },
    ]);
    async function* counting(): AsyncGenerator<Uint8Array> {
      for await (const chunk of chunks(tarBytes, 512)) {
        read += chunk.length;
        yield chunk;
      }
    }
    const report = await validateBundleTar(counting());
    expectProblem(report, "limits.bundle_size");
    expect(read).toBeLessThanOrEqual(2048);
  });

  test("a file over its limit is not read but its listing is still checked", async () => {
    const report = await validateAsTar(files, { limits: { maxJpegBytes: 100 } });
    expect(report.errors.map((p) => p.code)).toEqual(["limits.file_size", "limits.file_size"]);
  });
});

/** How docs/capture-bundle.md writes a limit's value. */
/** A limit as the doc's table gives it: a count, or a size in bytes (16 MiB). */
function describeLimit(name: string, value: number): string {
  if (!name.endsWith("Bytes")) return value.toLocaleString("en-GB");
  const units: [number, string][] = [
    [1024 ** 3, "GiB"],
    [1024 ** 2, "MiB"],
    [1024, "KiB"],
  ];
  for (const [size, unit] of units) {
    if (value >= size && value % size === 0) return `${value / size} ${unit}`;
  }
  return value.toLocaleString("en-GB");
}
