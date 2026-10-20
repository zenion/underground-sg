// The git check (ADR 0010, "Git and EAS"): its rules, planted recordings in throwaway git repos,
// this repo's own tree, and the pre-push hook refusing a real push.

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  checkIndex,
  checkPaths,
  checkPush,
  inSyntheticSet,
  isRecordingFile,
  SYNTHETIC_SETS_DIR,
} from "../src/node/index.ts";

const REPO_DIR = join(import.meta.dirname, "..", "..", "..");
const HOOKS_DIR = join(REPO_DIR, ".githooks").replaceAll("\\", "/");
const CHECK = join(REPO_DIR, "packages", "recording", "scripts", "check-tracked.ts");

const SET = `${SYNTHETIC_SETS_DIR}corridor-lean/rec-5f0e8f0c-7a4e-5c1b-9d2e-3f4a5b6c7d8e`;
const SYNTHETIC = JSON.stringify({ recording_version: 1, origin: "synthetic" });
const DEVICE = JSON.stringify({ recording_version: 1, origin: "device" });

const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** git with no user or system configuration that could sign, prompt or run other hooks. */
function git(cwd: string, args: string[], input?: string): SpawnSyncReturns<string> {
  return spawnSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    {
      cwd,
      input,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    },
  );
}

function ok(result: SpawnSyncReturns<string>): string {
  if (result.status !== 0) throw new Error(`git failed: ${result.stderr}`);
  return result.stdout;
}

/** A new repository with `files` committed, one commit per entry of `commits`. */
function repository(...commits: Record<string, string | null>[]): string {
  const dir = mkdtempSync(join(tmpdir(), "usg-tracked-"));
  temporary.push(dir);
  ok(git(dir, ["init", "-q", "-b", "main"]));
  commits.forEach((files, i) => {
    for (const [path, text] of Object.entries(files)) {
      const target = join(dir, ...path.split("/"));
      if (text === null) {
        ok(git(dir, ["rm", "-q", path]));
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
      ok(git(dir, ["add", path]));
    }
    ok(git(dir, ["commit", "-q", "--allow-empty", "-m", `commit ${i}`]));
  });
  return dir;
}

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

  test("fails without a set when sets are required", () => {
    const dir = repository({ "README.md": "x" });
    expect(checkIndex(dir, { requireSets: true })[0]?.code).toBe("no_synthetic_recording");
  });

  test("this repository's tracked files pass", () => {
    expect(checkIndex(REPO_DIR)).toEqual([]);
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

  describe("the pre-push hook", () => {
    /** A repository with a bare remote, pushing with this repo's .githooks. */
    function pushing(...commits: Record<string, string | null>[]): SpawnSyncReturns<string> {
      const dir = repository(...commits);
      const remote = mkdtempSync(join(tmpdir(), "usg-remote-"));
      temporary.push(remote);
      ok(git(remote, ["init", "-q", "--bare"]));
      ok(git(dir, ["remote", "add", "origin", remote]));
      return git(dir, ["-c", `core.hooksPath=${HOOKS_DIR}`, "push", "-q", "origin", "main"]);
    }

    test("refuses a push with a planted origin: device recording", () => {
      const result = pushing({ "fixtures/rec-1/recording.json": DEVICE });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("recording_not_synthetic");
      expect(result.stderr).toContain("fixtures/rec-1/recording.json");
    });

    test("refuses a push with a planted gnss.jsonl, even one deleted again", () => {
      const result = pushing({ "data/gnss.jsonl": "{}\n" }, { "data/gnss.jsonl": null });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("recording_file_outside_sets");
      expect(result.stderr).toContain("data/gnss.jsonl");
    });

    test("lets a clean push through", () => {
      const result = pushing({ "README.md": "hello\n", [`${SET}/recording.json`]: SYNTHETIC });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    });
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
