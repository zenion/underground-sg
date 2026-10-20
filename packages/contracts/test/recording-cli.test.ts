// The validate-recording CLI, run as `node src/recording-validator/cli.ts` in a child process.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import type { RecordingValidationReport } from "../src/recording-validator/index.ts";
import {
  exportParts,
  leanSpec,
  recording,
  removeRecordingDirectories,
  replaySet,
  setTar,
  writePartsDirectory,
  writeRecordingDirectory,
  writeTemporaryFile,
} from "./recording-fixture.ts";

afterAll(removeRecordingDirectories);

const CLI = fileURLToPath(new URL("../src/recording-validator/cli.ts", import.meta.url));
const TIMEOUT_MS = 30_000;

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("validate-recording", () => {
  test(
    "a valid recording directory exits 0 and prints counts",
    () => {
      const { code, stdout } = run(writeRecordingDirectory(recording()));
      expect(code).toBe(0);
      expect(stdout).toMatch(/\(directory\): valid, 0 errors, 0 warnings/);
      expect(stdout).toMatch(/lean, ended end_anchor, closed/);
      expect(stdout).toMatch(/frames\.jsonl 11/);
    },
    TIMEOUT_MS,
  );

  test(
    "a valid set's tar exits 0; --json prints the report with the bundle's",
    () => {
      const path = writeTemporaryFile("set.tar", setTar(replaySet()));
      const { code, stdout } = run(path, "--json");
      expect(code).toBe(0);
      const report = JSON.parse(stdout) as RecordingValidationReport;
      expect(report).toMatchObject({
        valid: true,
        source: "tar",
        errors: [],
        failure_reason: null,
      });
      expect(report.bundles).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  test(
    "--parts reads an export's folder",
    () => {
      const dir = writePartsDirectory(exportParts(setTar(replaySet()), 16 * 1024 * 1024));
      const { code, stdout } = run("--parts", dir);
      expect(code).toBe(0);
      expect(stdout).toMatch(/\(parts\): valid/);
      expect(stdout).toMatch(/1 part, tar /);
      expect(stdout).toMatch(/\| .*capture-.*\(tar\): valid/);
    },
    TIMEOUT_MS,
  );

  test(
    "an invalid recording exits 1, one line per problem, with no values",
    () => {
      const files = recording(leanSpec(), (spec) => {
        const event = spec.events[3];
        if (event !== undefined) event.detail = "warm";
      });
      const { code, stdout } = run(writeRecordingDirectory(files));
      expect(code).toBe(1);
      expect(stdout).toMatch(/INVALID, 1 error, 0 warnings/);
      expect(stdout).toMatch(
        /error {4}events\.detail {2}events\.jsonl:4 {2}The detail of a thermal event/,
      );
      expect(stdout).not.toContain("warm");
    },
    TIMEOUT_MS,
  );

  test(
    "a missing path, bad usage or a parts folder that isn't one exit 2",
    () => {
      const missing = run(join(writeTemporaryFile("x", new Uint8Array(0)), "..", "nope"));
      expect(missing.code).toBe(2);
      expect(missing.stderr).toMatch(/^validate-recording: Cannot read/);
      expect(run().code).toBe(2);
      expect(run("a", "b").code).toBe(2);
      expect(run("--parts", "a", "b").code).toBe(2);
      expect(run("--nope").code).toBe(2);
      const notDirectory = run("--parts", writeTemporaryFile("y", new Uint8Array(0)));
      expect(notDirectory.code).toBe(2);
    },
    TIMEOUT_MS,
  );

  test(
    "--help exits 0",
    () => {
      const { code, stdout } = run("--help");
      expect(code).toBe(0);
      expect(stdout).toMatch(/^Usage: validate-recording <path>/);
    },
    TIMEOUT_MS,
  );
});
