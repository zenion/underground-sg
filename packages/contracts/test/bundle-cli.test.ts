// The validate-bundle CLI, run as `node src/bundle-validator/cli.ts` in a child process.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import type { ValidationReport } from "../src/bundle-validator/index.ts";
import {
  bundle,
  editManifest,
  minimalSpec,
  removeBundleDirectories,
  writeBundleDirectory,
} from "./bundle-fixture.ts";
import { bundleTar } from "./tar-writer.ts";

afterAll(removeBundleDirectories);

const CLI = fileURLToPath(new URL("../src/bundle-validator/cli.ts", import.meta.url));
const TIMEOUT_MS = 30_000;

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("validate-bundle", () => {
  const valid = writeBundleDirectory(bundle());

  test(
    "a valid directory exits 0 and says so",
    () => {
      const { code, stdout } = run(valid);
      expect(code).toBe(0);
      expect(stdout).toMatch(/: valid, 0 errors, 0 warnings/);
      expect(stdout).toMatch(/limited tracking 25\.0% \(1 of 4 frames\)/);
    },
    TIMEOUT_MS,
  );

  test(
    "a valid tar exits 0; --json prints the report",
    () => {
      const tarPath = join(valid, "..", "bundle.tar");
      writeFileSync(tarPath, bundleTar(bundle()));
      const { code, stdout } = run(tarPath, "--json");
      expect(code).toBe(0);
      const report = JSON.parse(stdout) as ValidationReport;
      expect(report).toMatchObject({
        valid: true,
        source: "tar",
        errors: [],
        failure_reason: null,
      });
      expect(report.info.limited_tracking_share).toBe(0.25);
    },
    TIMEOUT_MS,
  );

  test(
    "an invalid bundle exits 1 and lists each problem with its code, file and message",
    () => {
      const files = editManifest(bundle(), (manifest) => {
        manifest.frame_count = 7;
      });
      const { code, stdout } = run(writeBundleDirectory(files));
      expect(code).toBe(1);
      expect(stdout).toMatch(/INVALID, 1 error, 0 warnings/);
      expect(stdout).toMatch(
        /error\s+manifest\.frame_count\s+manifest\.json\s+frame_count is 7, but poses\.jsonl has 4 lines/,
      );
    },
    TIMEOUT_MS,
  );

  test(
    "--quarantined lists keyframes whose files were removed",
    () => {
      const spec = minimalSpec();
      const pose = spec.poses[1];
      if (pose !== undefined) pose.keyframe = true;
      spec.manifest.keyframe_count = 3;
      spec.blur.splice(1, 0, { frame: 1, boxes: [] });
      const files = new Map(bundle(spec));
      files.delete("keyframes/000001.jpg");
      files.delete("depth/000001.png");
      const directory = writeBundleDirectory(files);
      expect(run(directory).code).toBe(1);
      expect(run(directory, "--quarantined", "1").code).toBe(0);
      expect(run(directory, "--quarantined=1,2").code).toBe(1);
      expect(run(directory, "--quarantined", "").code).toBe(1);
    },
    TIMEOUT_MS,
  );

  test.each<[string, string[], RegExp]>([
    ["no path", [], /exactly one bundle path/],
    ["two paths", ["a", "b"], /exactly one bundle path/],
    ["an unknown option", ["x", "--fix"], /Unknown option/],
    ["a bad frame list", ["x", "--quarantined", "12,abc"], /--quarantined/],
    ["a frame index of seven digits", ["x", "--quarantined", "1000000"], /--quarantined/],
    ["a path that does not exist", [join("no", "such", "bundle.tar")], /Cannot read/],
  ])(
    "%s exits 2",
    (_name, args, message) => {
      const { code, stderr } = run(...args);
      expect(code).toBe(2);
      expect(stderr).toMatch(message);
    },
    TIMEOUT_MS,
  );

  test(
    "--help exits 0",
    () => {
      const { code, stdout } = run("--help");
      expect(code).toBe(0);
      expect(stdout).toMatch(/^Usage: validate-bundle/);
    },
    TIMEOUT_MS,
  );
});
