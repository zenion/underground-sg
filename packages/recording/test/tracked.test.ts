// The git check (ADR 0010, "Git and EAS"): its rules, and planted recordings in throwaway git
// repos. This repo's own tree and the real pre-push hook are in repo/tracked.test.ts (`pnpm test:repo`).

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { SYNTHETIC_SET_NAMES } from "../src/index.ts";
import {
  checkIndex,
  checkPaths,
  checkPush,
  inSyntheticSet,
  isRecordingFile,
  SYNTHETIC_SETS_DIR,
} from "../src/node/index.ts";
import {
  DEVICE,
  git,
  ok,
  REPO_DIR,
  removeRepositories,
  repository,
  SET,
  SYNTHETIC,
} from "./git-repos.ts";

const CHECK = join(REPO_DIR, "packages", "recording", "scripts", "check-tracked.ts");

afterAll(removeRepositories);

describe("the rules", () => {
  test("names the recorder's, the bundle's and the export's files", () => {
    for (const path of [
      "recording.json",
      "x/frames.jsonl",
      "x/boundary.jsonl",
      "x/location.jsonl",
      "rec-1/mesh/history.bin",
      "x/poses.jsonl",
      "x/gnss.jsonl",
      "replay-1/parts.json",
      "replay-1/0000.part",
      "rec-1/candidates/000123.jpg",
      "capture-1/manifest.json",
      "x/Capture-1/MANIFEST.JSON",
      "x/GNSS.jsonl",
    ]) {
      expect(isRecordingFile(path), path).toBe(true);
    }
  });

  test("leaves other files alone, the Swift goldens named by type included", () => {
    for (const path of [
      "package.json",
      "apps/mapper/modules/capture-native/Tests/CaptureCoreTests/Golden/GnssLine.jsonl",
      "apps/mapper/modules/capture-native/Tests/CaptureCoreTests/Golden/RecordingManifest.json",
      "apps/mapper/modules/capture-native/Tests/CaptureCoreTests/Golden/ExportParts.json",
      "apps/mapper/manifest.json",
      "apps/mapper/modules/capture-native/expo-module.config.json",
      "docs/candidates.md",
      "imu.jsonl",
    ]) {
      expect(isRecordingFile(path), path).toBe(false);
    }
  });

  test("knows a generated set's directory", () => {
    expect(inSyntheticSet(`${SET}/frames.jsonl`)).toBe(true);
    expect(inSyntheticSet(`${SYNTHETIC_SETS_DIR}frames.jsonl`)).toBe(false);
    expect(inSyntheticSet(`${SYNTHETIC_SETS_DIR}rec-1/frames.jsonl`)).toBe(false);
    expect(inSyntheticSet(`${SYNTHETIC_SETS_DIR}replay-1/0000.part`)).toBe(false);
    expect(inSyntheticSet(`packages/recording/fixtures/frames.jsonl`)).toBe(false);
  });

  test("knows only the sets synth writes, by exact name", () => {
    for (const set of SYNTHETIC_SET_NAMES) {
      expect(inSyntheticSet(`${SYNTHETIC_SETS_DIR}${set}/rec-1/frames.jsonl`), set).toBe(true);
    }
    for (const set of ["other", "walk-copy", "Corridor-Lean", "corridor-lean-2", "corridor"]) {
      expect(inSyntheticSet(`${SYNTHETIC_SETS_DIR}${set}/rec-1/frames.jsonl`), set).toBe(false);
    }
  });

  test("a recording copied in beside the sets is outside them, recording.json or not", () => {
    const stray = `${SYNTHETIC_SETS_DIR}other/rec-x`;
    const problems = checkPaths(
      [
        `${stray}/location.jsonl`,
        `${stray}/frames.jsonl`,
        `${stray}/boundary.jsonl`,
        `${SET}/location.jsonl`,
      ],
      () => true,
    );
    expect(problems.map((p) => [p.code, p.path])).toEqual([
      ["recording_file_outside_sets", `${stray}/location.jsonl`],
      ["recording_file_outside_sets", `${stray}/frames.jsonl`],
      ["recording_file_outside_sets", `${stray}/boundary.jsonl`],
    ]);
  });

  test("a synthetic recording.json outside the named sets doesn't count for requireSets", () => {
    const stray = `${SYNTHETIC_SETS_DIR}other/rec-x/recording.json`;
    expect(
      checkPaths([stray], () => true, { requireSets: true }).map((p) => [p.code, p.path]),
    ).toEqual([
      ["recording_file_outside_sets", stray],
      ["no_synthetic_recording", null],
    ]);
  });

  test("a recording.json must be synthetic, inside a set or not", () => {
    const problems = checkPaths([`${SET}/recording.json`, "notes/recording.json"], () => false);
    expect(problems.map((p) => [p.code, p.path])).toEqual([
      ["recording_not_synthetic", `${SET}/recording.json`],
      ["recording_not_synthetic", "notes/recording.json"],
      ["recording_file_outside_sets", "notes/recording.json"],
    ]);
  });

  test("requireSets wants a synthetic recording.json in a set", () => {
    expect(checkPaths(["README.md"], () => true, { requireSets: true })[0]?.code).toBe(
      "no_synthetic_recording",
    );
    expect(checkPaths([`${SET}/recording.json`], () => true, { requireSets: true })).toEqual([]);
  });
});

describe("a repository's index", () => {
  test("passes with a synthetic set", () => {
    const dir = repository({
      [`${SET}/recording.json`]: SYNTHETIC,
      [`${SET}/frames.jsonl`]: "{}\n",
      [`${SET}/location.jsonl`]: "{}\n",
      [`${SET}/mesh/history.bin`]: "x",
    });
    expect(checkIndex(dir, { requireSets: true })).toEqual([]);
  });

  test("fails on a planted origin: device recording, even inside a set", () => {
    const dir = repository({ [`${SET}/recording.json`]: DEVICE });
    expect(checkIndex(dir).map((p) => [p.code, p.path])).toEqual([
      ["recording_not_synthetic", `${SET}/recording.json`],
    ]);
  });

  test("fails on a recording.json that isn't JSON", () => {
    const dir = repository({ [`${SET}/recording.json`]: "not json" });
    expect(checkIndex(dir)[0]?.code).toBe("recording_not_synthetic");
  });

  test("fails on a planted gnss.jsonl", () => {
    const dir = repository({ "test/fixtures/capture-1/gnss.jsonl": "{}\n" });
    expect(checkIndex(dir).map((p) => [p.code, p.path])).toEqual([
      ["recording_file_outside_sets", "test/fixtures/capture-1/gnss.jsonl"],
    ]);
  });

  test("fails on a location.jsonl planted beside the sets, with no recording.json", () => {
    const stray = `${SYNTHETIC_SETS_DIR}other/rec-x/location.jsonl`;
    const dir = repository({ [`${SET}/recording.json`]: SYNTHETIC, [stray]: "{}\n" });
    expect(checkIndex(dir, { requireSets: true }).map((p) => [p.code, p.path])).toEqual([
      ["recording_file_outside_sets", stray],
    ]);
  });

  test("fails without a set when sets are required", () => {
    const dir = repository({ "README.md": "x" });
    expect(checkIndex(dir, { requireSets: true })[0]?.code).toBe("no_synthetic_recording");
  });
});

describe("a push", () => {
  test("checks every commit it would publish, not only the tip", () => {
    const dir = repository({ "a/gnss.jsonl": "{}\n" }, { "a/gnss.jsonl": null });
    const tip = ok(git(dir, ["rev-parse", "HEAD"])).trim();
    const problems = checkPush(dir, `refs/heads/main ${tip} refs/heads/main ${"0".repeat(40)}\n`);
    expect(problems.map((p) => [p.code, p.path])).toEqual([
      ["recording_file_outside_sets", "a/gnss.jsonl"],
    ]);
    expect(problems[0]?.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test("a deleted ref publishes nothing", () => {
    const dir = repository({ "a/gnss.jsonl": "{}\n" });
    const zero = "0".repeat(40);
    expect(checkPush(dir, `(delete) ${zero} refs/heads/old ${zero}\n`)).toEqual([]);
  });

  test("the check's CLI fails on problems and passes a clean tree", () => {
    const bad = repository({ "x/poses.jsonl": "{}\n" });
    const failed = spawnSync(process.execPath, [CHECK], { cwd: bad, encoding: "utf8" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("x/poses.jsonl");
    const good = repository({ [`${SET}/recording.json`]: SYNTHETIC });
    const passed = spawnSync(process.execPath, [CHECK, "--require-sets"], {
      cwd: good,
      encoding: "utf8",
    });
    expect(passed.status).toBe(0);
  });
});
