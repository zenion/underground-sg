// The no-pose-logging rule (scripts/no-pose-logging.mts): the app's source passes, and planted
// cases that would log, throw or format a pose, a fix or a session time fail.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the planted cases are source code in strings.

import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  appSourceFiles,
  describeFinding,
  identifierWords,
  type PoseRule,
  scanSources,
} from "../scripts/no-pose-logging.mts";

const APP = fileURLToPath(new URL("../", import.meta.url));

function scan(source: string, file = "src/planted.ts") {
  return scanSources([{ file, source }]);
}

function rules(source: string, file?: string): PoseRule[] {
  return scan(source, file).map((finding) => finding.rule);
}

describe("the app", () => {
  test("has no pose, fix or session time in a log, error, throw or template, and no node: import", () => {
    const files = appSourceFiles(APP);
    expect(files.map((file) => file.file)).toEqual(
      expect.arrayContaining([
        "src/capture/native.ts",
        "src/capture/boundary-trace.ts",
        "src/walk/flow.ts",
        "src/app/capture.tsx",
        "modules/capture-native/index.ts",
        "modules/capture-native/src/types.ts",
      ]),
    );
    expect(files.some((file) => file.file.includes("node_modules"))).toBe(false);
    expect(scanSources(files).map(describeFinding)).toEqual([]);
  });

  test("the boundary trace's exemption is needed and covers only templates", () => {
    const files = appSourceFiles(APP);
    const unexempt = scanSources(files, {}).filter(
      (finding) => finding.file === "src/capture/boundary-trace.ts",
    );
    expect(unexempt.length).toBeGreaterThan(0);
    expect(new Set(unexempt.map((finding) => finding.rule))).toEqual(new Set(["template"]));
  });
});

describe("planted cases fail", () => {
  test.each([
    ["console.log(pose);", "console"],
    ["console.warn('at', result.hit.point);", "console"],
    ["console.error({ cameraTransform });", "console"],
    ["console.info(...poses);", "console"],
    ["throw new Error(`bad pose ${pose}`);", "error"],
    ["const e = new Error(String(camera));", "error"],
    ["const e = new TypeError('no ' + fix.lat);", "error"],
    ["throw cameraTransform;", "throw"],
    ["throw { where: position };", "throw"],
    ["const s = `${fix.latitude},${fix.longitude}`;", "template"],
    ["const s = `${gnssFix}`;", "template"],
    ["const s = `at ${startT} s`;", "template"],
    ["console.log(value.unwrap());", "console"],
    ["import { readFileSync } from 'node:fs';", "node-import"],
    ["export * from 'node:path';", "node-import"],
    ["const fs = require('node:fs');", "node-import"],
  ])("%s", (source, rule) => {
    expect(rules(source)).toContain(rule);
  });

  test("throwing an Error built from a pose is found twice: the error and the throw", () => {
    expect(rules("throw new Error(`${pose}`);").sort()).toEqual(["error", "template", "throw"]);
  });

  test("a name declared Redacted or SessionTime anywhere is sensitive everywhere", () => {
    const findings = scanSources([
      {
        file: "src/a.ts",
        source: "export interface Result { where: Redacted<number> | null; when: SessionTime }",
      },
      { file: "src/b.ts", source: "console.log(result.where, result.when);" },
      {
        file: "src/c.ts",
        source: "export function f(spot: Redacted<number>) { return `${spot}`; }",
      },
      {
        file: "src/d.ts",
        source: "const mark: SessionTime | null = null; throw new Error(String(mark));",
      },
    ]);
    expect(findings.map(describeFinding)).toEqual([
      "src/b.ts:1: console mentions where",
      "src/b.ts:1: console mentions when",
      "src/c.ts:1: template mentions spot",
      "src/d.ts:1: throw mentions mark",
      "src/d.ts:1: error mentions mark",
    ]);
  });

  test("in a screen: a pose formatted in JSX", () => {
    const source = [
      "export function Screen() {",
      "  return <Text>{`Hit at ${hit.point}`} isn't shown</Text>;",
      "}",
    ].join("\n");
    expect(scan(source, "src/app/screen.tsx")).toEqual([
      { file: "src/app/screen.tsx", line: 2, rule: "template", name: "hit" },
    ]);
  });
});

describe("clean cases pass", () => {
  test.each([
    'console.log("pose");',
    "console.log(count, frames);",
    "// console.log(pose);",
    "/* throw cameraTransform; */",
    "const s = `${frames} frames, the pose is redacted`;",
    'const e = new Error("camera failed");',
    "console.log({ position: count });",
    "throw new Error(String(reason as CameraError));",
    "function f(x: Redacted<number>) { return x; }",
    "const location = { motion: 'granted' };",
    "import { parse } from '@babel/parser';",
  ])("%s", (source) => {
    expect(scan(source)).toEqual([]);
  });

  test("JSX text with apostrophes", () => {
    const source = "export const A = () => <Note>It can't record; don't worry</Note>;";
    expect(scan(source, "src/app/a.tsx")).toEqual([]);
  });
});

test("identifier words", () => {
  expect(identifierWords("cameraTransform")).toEqual(["camera", "transform"]);
  expect(identifierWords("startT")).toEqual(["start", "t"]);
  expect(identifierWords("GNSSFix")).toEqual(["gnss", "fix"]);
  expect(identifierWords("hit_point2")).toEqual(["hit", "point"]);
  expect(identifierWords("toFixed")).toEqual(["to", "fixed"]);
});
