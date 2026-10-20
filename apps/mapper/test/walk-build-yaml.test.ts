// .github/workflows/walk-build.yml (the lean recorder design, section 10; ADR 0009 "Builds and
// accounts"): started by hand only, in the protected walk environment, read-only, with nothing of
// the build's output in the public log but masked error lines, `eas upload`'s output discarded,
// and never an Actions artifact. Also the masking itself (scripts/walk-build-log-lib.mts), on
// synthetic lines.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { errorLines, MAX_LINES, maskLine } from "../scripts/walk-build-log-lib.mts";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const yaml = read("../../../.github/workflows/walk-build.yml");
const ci = read("../../../.github/workflows/ci.yml");
/** The workflow without its comments. */
const code = yaml
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .map((line) => line.replace(/\s+#.*$/, ""))
  .join("\n");
const lines = code.split("\n");

/**
 * The shell lines of every run step (block or single-line), trimmed, without echo lines: what the
 * runner executes, as opposed to step names and messages.
 */
function shellLines(): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const single = /^\s*(?:- )?run: (?!\|)(.+)$/.exec(line);
    if (single) {
      out.push((single[1] ?? "").trim());
      continue;
    }
    const block = /^(\s*)(?:- )?run: \|$/.exec(line);
    if (!block) continue;
    const indent = (block[1] ?? "").length;
    for (i++; i < lines.length; i++) {
      const body = lines[i] ?? "";
      if (body.trim() !== "" && body.length - body.trimStart().length <= indent) {
        i--;
        break;
      }
      if (body.trim() !== "") out.push(body.trim());
    }
  }
  return out.filter((command) => !command.startsWith("echo "));
}
const commands = shellLines();

/** The lines of the top-level block `key:`, up to the next top-level key. */
function topLevelBlock(key: string): string[] {
  const start = lines.indexOf(`${key}:`);
  if (start === -1) return [];
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    if (line.trim() !== "") block.push(line);
  }
  return block;
}

const usesPins = (text: string): Map<string, string> =>
  new Map(
    [...text.matchAll(/uses: ([\w./-]+)@(\S+)/g)].map((match) => [match[1] ?? "", match[2] ?? ""]),
  );

describe("walk-build.yml", () => {
  test("never makes an Actions artifact or caches the build", () => {
    expect(yaml).not.toMatch(/upload-artifact/);
    expect(yaml).not.toMatch(/retention-days/);
    expect(code).not.toMatch(/actions\/cache/);
  });

  test("runs only when started by hand", () => {
    expect(topLevelBlock("on")).toEqual(["  workflow_dispatch:"]);
  });

  test("reads the repository only, and checks out without keeping the token", () => {
    expect(topLevelBlock("permissions")).toEqual(["  contents: read"]);
    expect(code).not.toMatch(/:\s*write\b/);
    const checkouts = code.match(/uses: actions\/checkout@/g) ?? [];
    expect(checkouts.length).toBeGreaterThan(0);
    expect(code.match(/persist-credentials: false/g)?.length).toBe(checkouts.length);
  });

  test("on macos-26 in the protected walk environment, with EXPO_TOKEN as its only secret", () => {
    expect(code).toMatch(/^ {4}runs-on: macos-26$/m);
    expect(code).toMatch(/^ {4}environment: walk$/m);
    const secrets = new Set([...code.matchAll(/secrets\.(\w+)/g)].map((match) => match[1]));
    expect([...secrets]).toEqual(["EXPO_TOKEN"]);
    expect(code).not.toMatch(/pull_request_target|workflow_run/);
  });

  test("pins every action by commit, the same commits as ci.yml", () => {
    const pins = usesPins(code);
    expect(pins.size).toBeGreaterThan(0);
    const ciPins = usesPins(ci);
    for (const [action, ref] of pins) {
      expect(ref, action).toMatch(/^[0-9a-f]{40}$/);
      expect(ref, action).toBe(ciPins.get(action));
    }
  });

  test("pins eas-cli exactly, and installs it quietly", () => {
    expect(code).toMatch(/^ {6}EAS_CLI_VERSION: \d+\.\d+\.\d+$/m);
    expect(code).toMatch(/^ {6}EAS_CLI_BEFORE: "\d{4}-\d{2}-\d{2}T00:00:00Z"$/m);
    const install = commands.find((line) => line.includes("npm install --global"));
    expect(install).toContain('"eas-cli@$EAS_CLI_VERSION"');
    expect(install).toContain('--before "$EAS_CLI_BEFORE"');
    expect(install).toMatch(/> \/dev\/null 2>&1/);
  });

  test("builds the walk profile locally with its output in a file", () => {
    const builds = commands.filter((line) => /\beas build\b/.test(line));
    expect(builds).toHaveLength(1);
    const build = builds[0] ?? "";
    for (const flag of [
      "--local",
      "--profile walk",
      "--platform ios",
      "--non-interactive",
      '--output "$RUNNER_TEMP/walk.ipa"',
    ]) {
      expect(build).toContain(flag);
    }
    expect(build.trimEnd()).toMatch(/> "\$RUNNER_TEMP\/build\.log" 2>&1$/);
  });

  test("uploads to EAS with its output discarded", () => {
    const uploads = commands.filter((line) => /\beas upload\b/.test(line));
    expect(uploads).toHaveLength(1);
    const upload = uploads[0] ?? "";
    for (const flag of [
      "--platform ios",
      '--build-path "$RUNNER_TEMP/walk.ipa"',
      "--non-interactive",
    ]) {
      expect(upload).toContain(flag);
    }
    expect(upload).toMatch(/> \/dev\/null 2>&1/);
  });

  test("every eas command's output is redirected", () => {
    const easLines = commands.filter((line) => /(^|[\s!;(])eas\s/.test(line));
    expect(easLines.length).toBeGreaterThanOrEqual(3);
    for (const line of easLines) {
      expect(line, line.trim()).toMatch(/> (\/dev\/null|"\$RUNNER_TEMP\/build\.log") 2>&1/);
    }
  });

  test("prints the build log only through the masking script, between stop-commands markers", () => {
    const mentions = commands.filter((line) => line.includes("build.log"));
    for (const line of mentions) {
      const allowed =
        line.includes("eas build") ||
        line.includes('node scripts/walk-build-log.mts "$RUNNER_TEMP/build.log"') ||
        line.includes("rm -f");
      expect(allowed, line.trim()).toBe(true);
    }
    expect(code).not.toMatch(/\b(cat|tail|head|less|more|tee|grep|sed|awk)\b[^\n]*build\.log/);
    expect(code).not.toMatch(/set -x|set -o xtrace/);
    const stop = lines.findIndex((line) => line.includes('echo "::stop-commands::$marker"'));
    const print = lines.findIndex((line) => line.includes("node scripts/walk-build-log.mts"));
    const resume = lines.findIndex((line) => line.includes('echo "::$marker::"'));
    expect(stop).toBeGreaterThan(-1);
    expect(print).toBeGreaterThan(stop);
    expect(resume).toBeGreaterThan(print);
  });

  test("removes the .ipa and the log whatever happened", () => {
    const step = code.indexOf("- name: Remove the build and its log");
    expect(step).toBeGreaterThan(-1);
    const rest = code.slice(step);
    expect(rest).toMatch(/if: always\(\)/);
    expect(rest).toContain('rm -f "$RUNNER_TEMP/walk.ipa" "$RUNNER_TEMP/build.log"');
  });
});

describe("the build log's masking", () => {
  test("masks URLs, e-mail addresses, UUIDs, UDIDs, long hex, team ids and user names", () => {
    expect(
      maskLine(
        "error: Provisioning profile 0f7d0e65-6f2e-4b43-9a55-5d7f4f0c5b0e doesn't include device 00008140-001A2B3C4D5E801C",
      ),
    ).toBe("error: Provisioning profile <uuid> doesn't include device <udid>");
    expect(maskLine("error: see https://expo.dev/accounts/someone/builds/abc?x=1 now")).toBe(
      "error: see <url> now",
    );
    expect(maskLine("error: signed by owner@example.com")).toBe("error: signed by <email>");
    expect(maskLine(`error: device ${"a1".repeat(20)} at commit ${"0".repeat(40)}`)).toBe(
      "error: device <hex> at commit <hex>",
    );
    expect(maskLine("error: No profile for team 'AB12CD34EF' matching")).toBe(
      "error: No profile for team '<team>' matching",
    );
    expect(maskLine("error: /Users/runner/work/x.swift:3: missing")).toBe(
      "error: /Users/<user>/work/x.swift:3: missing",
    );
    // Words of ten capitals without a digit, and code, are left alone.
    expect(maskLine("error: PODFILELCK and CaptureView.swift:12")).toBe(
      "error: PODFILELCK and CaptureView.swift:12",
    );
  });

  test("keeps only error lines, prefixed so none can be a workflow command, and bounded", () => {
    const log = [
      "Building…",
      "::set-output name=x::error: injected",
      '  error: Signing for "Mapper" requires a development team',
      "warning: something",
      "[RUN_FASTLANE] ** ARCHIVE FAILED ** error: 65",
    ].join("\n");
    const out = errorLines(log);
    expect(out).toEqual([
      "| ::set-output name=x::error: injected",
      '| error: Signing for "Mapper" requires a development team',
      "| [RUN_FASTLANE] ** ARCHIVE FAILED ** error: 65",
    ]);
    for (const line of out) expect(line.startsWith("::")).toBe(false);

    const many = Array.from({ length: MAX_LINES + 5 }, (_, i) => `error: line ${i}`).join("\n");
    const bounded = errorLines(many);
    expect(bounded).toHaveLength(MAX_LINES + 1);
    expect(bounded.at(-1)).toBe("| (5 more error lines)");
    expect(maskLine(`error: ${"x".repeat(1000)}`).length).toBeLessThanOrEqual(401);
  });
});
