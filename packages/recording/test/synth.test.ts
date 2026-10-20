// `pnpm rec synth` and the corridor-lean set: valid, the same bytes every run, matching the tracked
// copy, synthetic through and through, and refused anywhere but fixtures/synthetic/ and .data/.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import type {
  AnchorHistoryLine,
  BoundaryLine,
  GnssLine,
  MeshHistoryLine,
  RecordingManifest,
} from "@usg/contracts";
import { validateRecording } from "@usg/contracts/recording-validator";
import { CORE_VENUE } from "@usg/db/seed/core-venues";
import { buildFloorplan } from "@usg/floorplan";
import { afterAll, describe, expect, test } from "vitest";
import {
  CORRIDOR_LEAN,
  corridorLean,
  ESPLANADE_MRT_VENUE,
  EXIT_F_DOOR,
  SYNTHETIC_SET_NAMES,
} from "../src/index.ts";
import {
  checkOutputDir,
  DATA_DIR,
  NODE_DIGESTS,
  OutputPathError,
  removeStrayDirectories,
  SYNTHETIC_DIR,
  synthesize,
  syntheticSets,
  uuidV5,
  writeSet,
} from "../src/node/index.ts";

const PACKAGE_DIR = join(import.meta.dirname, "..");
const CLI = join(PACKAGE_DIR, "src", "node", "cli.ts");

const temporary: string[] = [];
function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "usg-synth-"));
  temporary.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const set = corridorLean(NODE_DIGESTS);
const recDir = `rec-${set.recordingId}`;

function file(path: string): Uint8Array {
  const bytes = set.files.get(`${recDir}/${path}`);
  if (bytes === undefined) throw new Error(`no ${path} in the set`);
  return bytes;
}

function lines<T>(path: string): T[] {
  return new TextDecoder()
    .decode(file(path))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as T);
}

const manifest = JSON.parse(new TextDecoder().decode(file("recording.json"))) as RecordingManifest;

/** Byte equality; toEqual walks typed arrays element by element, too slowly for megabytes. */
function same(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  return a !== undefined && b !== undefined && Buffer.compare(a, b) === 0;
}

/** Every file under `dir`, by its path relative to `dir` with / separators. */
function readTree(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(relative(dir, path).split(sep).join("/"), readFileSync(path));
  }
  return files;
}

describe("the corridor-lean set", () => {
  test("passes validate-recording as a replay set, with no warnings", async () => {
    const out = temporaryDir();
    const {
      sets: [written],
      removed,
    } = synthesize(out, [out]);
    expect(removed).toEqual([]);
    expect(written?.name).toBe(CORRIDOR_LEAN);
    const report = await validateRecording(join(out, CORRIDOR_LEAN));
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.source).toBe("set_directory");
  });

  test("is the same bytes on every run", () => {
    const again = corridorLean(NODE_DIGESTS);
    expect([...again.files.keys()]).toEqual([...set.files.keys()]);
    for (const [path, bytes] of set.files)
      expect(same(again.files.get(path), bytes), path).toBe(true);
  });

  test("matches the tracked copy in fixtures/synthetic/ (else run pnpm rec synth)", () => {
    const tracked = join(SYNTHETIC_DIR, CORRIDOR_LEAN);
    if (!existsSync(tracked)) throw new Error("fixtures/synthetic/corridor-lean is missing");
    const onDisk = readTree(tracked);
    expect([...onDisk.keys()].sort()).toEqual([...set.files.keys()].sort());
    for (const [path, bytes] of set.files) {
      expect(same(onDisk.get(path), bytes), `${path} differs: run pnpm rec synth`).toBe(true);
    }
  });

  test("is a synthetic lean recording with no bundles", () => {
    expect(set.recordingId).toBe(uuidV5(`${CORRIDOR_LEAN}/recording`));
    expect([...new Set([...set.files.keys()].map((path) => path.split("/")[0]))]).toEqual([recDir]);
    expect(manifest.origin).toBe("synthetic");
    expect(manifest.build.profile).toBe("synthetic");
    expect(manifest.profile).toBe("lean");
    expect(manifest.segments).toEqual([]);
    expect(manifest.detector_versions).toBeNull();
    expect(manifest.closed).toBe(true);
    expect(manifest.window.ended).toBe("end_anchor");
  });

  test("names Esplanade MRT by its seed id", () => {
    expect(ESPLANADE_MRT_VENUE).toBe(CORE_VENUE.esplanadeMrt);
    expect(manifest.venues).toEqual([CORE_VENUE.esplanadeMrt]);
  });

  test("has every block of its mesh history as raw DEFLATE of 12 bytes a vertex and 13 a face", () => {
    const bin = file("mesh/history.bin");
    const history = lines<MeshHistoryLine>("mesh/history.jsonl");
    let end = 0;
    for (const line of history) {
      if (line.op === "remove") continue;
      const offset = line.offset as number;
      const bytes = line.bytes as number;
      expect(offset).toBe(end);
      end = offset + bytes;
      const inflated = inflateRawSync(bin.subarray(offset, end));
      expect(inflated.length).toBe(12 * (line.vertices as number) + 13 * (line.faces as number));
    }
    expect(end).toBe(bin.length);
    expect(history.some((line) => line.op === "update" && !line.final)).toBe(true);
    expect(history.some((line) => line.op === "remove")).toBe(true);
  });

  test("its final snapshot repeats each anchor's last block", () => {
    const bin = file("mesh/history.bin");
    const history = lines<MeshHistoryLine>("mesh/history.jsonl");
    const last = new Map<string, Uint8Array>();
    const block = (line: MeshHistoryLine) =>
      bin.subarray(line.offset as number, (line.offset as number) + (line.bytes as number));
    const finals = history.filter((line) => line.final);
    expect(finals.length).toBeGreaterThan(0);
    for (const line of history) {
      if (line.final) expect(same(block(line), last.get(line.anchor)), line.anchor).toBe(true);
      else if (line.op !== "remove") last.set(line.anchor, block(line));
    }
    expect(finals.every((line) => line.t === manifest.window.end_t)).toBe(true);
  });

  test("moves one mesh anchor without new geometry, in anchors.jsonl only", () => {
    const anchors = lines<AnchorHistoryLine>("anchors.jsonl");
    const moves = anchors.filter((line) => line.kind === "mesh" && line.op === "update");
    expect(moves).toHaveLength(1);
    const history = lines<MeshHistoryLine>("mesh/history.jsonl");
    const move = moves[0] as AnchorHistoryLine;
    expect(history.some((line) => line.anchor === move.anchor && line.t === move.t)).toBe(false);
  });

  test("has real coordinates only in location.jsonl, near Exit F, after the street-facing mark", () => {
    const fixes = lines<GnssLine>("location.jsonl");
    expect(fixes.length).toBeGreaterThan(0);
    const first = fixes[0] as GnssLine;
    const metres = (fix: GnssLine) =>
      Math.hypot(
        (fix.lat - first.lat) * 111_320,
        (fix.lon - first.lon) * 111_320 * Math.cos((first.lat * Math.PI) / 180),
      );
    for (const fix of fixes) {
      expect(metres(fix)).toBeLessThan(50);
      expect(fix.t).toBeGreaterThanOrEqual(manifest.window.start_t);
      expect(fix.t).toBeLessThanOrEqual(manifest.window.start_t + 30);
    }
    expect(Math.abs(first.lat - EXIT_F_DOOR.lat)).toBeLessThan(0.0005);
    expect(Math.abs(first.lon - EXIT_F_DOOR.lon)).toBeLessThan(0.0005);
  });

  test("its floor-triangles result builds a floor plan of the link", () => {
    const boundary = lines<BoundaryLine>("boundary.jsonl");
    const binary = boundary.find((line) => line.kind === "floorTriangles")?.binary;
    expect(binary).toBeTruthy();
    const bytes = file(binary as string);
    const triangles = new Float32Array(bytes.slice().buffer);
    const { polygons } = buildFloorplan(triangles);
    expect(polygons.length).toBeGreaterThan(0);
    // The link is 40 m by 6 m plus the part of the side hall the walk scanned.
    expect(polygons[0]?.areaM2).toBeGreaterThan(200);
  });
});

describe("output paths", () => {
  test("allows fixtures/synthetic/ and .data/, and paths inside them", () => {
    const roots = [SYNTHETIC_DIR, DATA_DIR];
    for (const dir of [
      SYNTHETIC_DIR,
      join(SYNTHETIC_DIR, "x"),
      DATA_DIR,
      join(DATA_DIR, "a", "b"),
    ]) {
      expect(() => checkOutputDir(dir, roots)).not.toThrow();
    }
  });

  test("refuses anything else, a sibling with the same prefix and a .. escape included", () => {
    const roots = [SYNTHETIC_DIR, DATA_DIR];
    for (const dir of [
      PACKAGE_DIR,
      `${SYNTHETIC_DIR}-copy`,
      join(SYNTHETIC_DIR, "..", "elsewhere"),
      `${DATA_DIR}2`,
      tmpdir(),
    ]) {
      expect(() => checkOutputDir(dir, roots), dir).toThrow(OutputPathError);
    }
  });

  test("refuses a set named like a recording or an export", () => {
    const out = temporaryDir();
    for (const name of ["rec-x", "replay-x"]) {
      expect(() => writeSet({ ...set, name }, out, [out])).toThrow(/rec- or replay-/);
    }
  });

  test("writeSet replaces the set's directory", () => {
    const out = temporaryDir();
    mkdirSync(join(out, CORRIDOR_LEAN, "stale"), { recursive: true });
    writeSet(set, out, [out]);
    expect(existsSync(join(out, CORRIDOR_LEAN, "stale"))).toBe(false);
    expect(readTree(join(out, CORRIDOR_LEAN)).size).toBe(set.files.size);
  });

  test("every set synth writes is named in SYNTHETIC_SET_NAMES, which the git check allows", () => {
    expect(syntheticSets().map((written) => written.name)).toEqual([...SYNTHETIC_SET_NAMES]);
  });

  test("in fixtures/synthetic/, synth removes every directory that isn't a set", () => {
    const out = temporaryDir();
    mkdirSync(join(out, "walk-copy", "rec-x"), { recursive: true });
    writeFileSync(join(out, "walk-copy", "rec-x", "location.jsonl"), "{}\n");
    writeFileSync(join(out, "notes.txt"), "kept\n");
    const { sets, removed } = synthesize(out, [out], { removeStrays: true });
    expect(sets.map((written) => written.name)).toEqual([CORRIDOR_LEAN]);
    expect(removed).toEqual(["walk-copy"]);
    expect(readdirSync(out).sort()).toEqual([CORRIDOR_LEAN, "notes.txt"]);
    expect(removeStrayDirectories(out)).toEqual([]);
  });

  test("elsewhere, as in .data/, synth leaves other directories alone", () => {
    const out = temporaryDir();
    mkdirSync(join(out, "mine"));
    expect(synthesize(out, [out]).removed).toEqual([]);
    expect(existsSync(join(out, "mine"))).toBe(true);
  });

  test("the CLI refuses an output outside the allowed roots", () => {
    const out = temporaryDir();
    const result = spawnSync(process.execPath, [CLI, "synth", "--out", out], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("refused");
    expect(readdirSync(out)).toEqual([]);
  });

  test("the CLI takes only synth", () => {
    const result = spawnSync(process.execPath, [CLI, "pull"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(spawnSync(process.execPath, [CLI, "--help"]).status).toBe(0);
  });
});
