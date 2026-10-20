import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { FloorPolygon } from "../src/index.ts";
import config from "../vitest.config.ts";
import { CheckError, check, checkWellFormed } from "./check.ts";

// The venue tests run on meshes recorded in a venue, and their output may reach an AI agent, which
// may see aggregate results only (CLAUDE.md). Vitest's matchers print both sides of a failed
// comparison and snapshots write and diff the values, so no file in the venue project may use
// them: the venue tests assert through check() in test/check.ts, whose messages name only the file
// and the item. This test reads the venue project's source, and every file it imports, and fails
// on any use of expect, assert or should (Vitest's chai and Node's assert print values too), chai
// itself or a snapshot matcher. It also fails on the stats and error fields that hold derived
// geometry, so the log can't print them: the grid's width and height (at 0.1 m cells, the floor's
// extent along the corridor), its angle (the corridor's heading) and FloorplanExtentError's extent.

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = join(PACKAGE_DIR, "test");
const VENUE_DIR = join(TEST_DIR, "venue");

const FORBIDDEN: [RegExp, string][] = [
  [/\bexpect\b/, "expect"],
  [/\bassert\b/, "assert"],
  [/\bshould\b/, "should"],
  [/\bchai\b/, "chai"],
  [/\b(?:gridWidth|gridHeight)\b/, "the grid's dimensions"],
  [/\bgridAngleRad\b/, "the grid angle"],
  [/\bextentM\b/, "the mesh's extent"],
  [
    /\b(?:toMatchSnapshot|toMatchInlineSnapshot|toMatchFileSnapshot|toThrowErrorMatchingSnapshot|toThrowErrorMatchingInlineSnapshot)\b/,
    "a snapshot matcher",
  ],
];

/**
 * The files under test/ reached from `entries` through relative imports, with their text. Imports
 * of packages (vitest, node:) are not followed, and neither are imports of the library in src/: it
 * defines the fields above and names them in its messages, and test/neutral.test.ts keeps it free
 * of dependencies and `node:` imports, so it can't reach Vitest or Node's assert.
 */
function reachable(
  entries: readonly string[],
  read: (file: string) => string,
): Map<string, string> {
  const files = new Map<string, string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop() ?? "";
    if (files.has(file)) continue;
    const text = read(file);
    files.set(file, text);
    // Static (from "x"), side-effect (import "x") and dynamic (import("x")) imports.
    for (const match of text.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const specifier = match[1] ?? "";
      if (!specifier.startsWith(".")) continue;
      const target = join(dirname(file), specifier);
      if (!relative(TEST_DIR, target).startsWith("..")) pending.push(target);
    }
  }
  return files;
}

/**
 * Every use of a forbidden name, as "<file> line <n> uses <what>". Comments that start a line
 * are skipped, so they may name what the code avoids; anything after code on a line is checked,
 * strings included, which errs on the strict side.
 */
function findValuePrinting(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  for (const [file, text] of files) {
    const code = text
      .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, (comment) => comment.replace(/[^\n]/g, ""))
      .replace(/^[ \t]*\/\/.*$/gm, "");
    code.split("\n").forEach((line, i) => {
      for (const [pattern, what] of FORBIDDEN) {
        if (pattern.test(line)) {
          found.push(
            `${relative(PACKAGE_DIR, file).replaceAll("\\", "/")} line ${i + 1} uses ${what}`,
          );
        }
      }
    });
  }
  return found;
}

/** Every .ts file under `dir`. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(dir, name))
    .sort();
}

/** Planted source: a map from file to text, read through the same walk. */
function planted(files: Record<string, string>): string[] {
  const map = new Map(Object.entries(files).map(([name, text]) => [join(VENUE_DIR, name), text]));
  const read = (file: string): string => {
    const text = map.get(file);
    if (text === undefined) throw new Error(`no planted file ${file}`);
    return text;
  };
  return findValuePrinting(reachable([join(VENUE_DIR, "planted.test.ts")], read));
}

describe("value-free venue tests", () => {
  test("the venue project is test/venue/, and the unit project leaves it out", () => {
    const projects = (config.test?.projects ?? []) as {
      test?: { name?: string; include?: string[]; exclude?: string[] };
    }[];
    const venue = projects.find((project) => project.test?.name === "venue");
    const unit = projects.find((project) => project.test?.name === "unit");
    expect(venue?.test?.include).toEqual(["test/venue/**/*.test.ts"]);
    expect(unit?.test?.exclude).toEqual(["test/venue/**"]);
    expect(projects).toHaveLength(2);
  });

  test("no file in the venue project, or imported by one, uses a forbidden name", () => {
    const files = reachable(sourceFiles(VENUE_DIR), (file) => readFileSync(file, "utf8"));
    const names = [...files.keys()].map((file) =>
      relative(PACKAGE_DIR, file).replaceAll("\\", "/"),
    );
    expect(names).toEqual(
      expect.arrayContaining([
        "test/venue/recorded.test.ts",
        "test/venue/fixtures.ts",
        "test/check.ts",
      ]),
    );
    expect(findValuePrinting(files)).toEqual([]);
  });

  test("a planted venue test calling expect fails it", () => {
    expect(
      planted({
        "planted.test.ts": [
          'import { expect, test } from "vitest";',
          'test("mesh", () => {',
          "  expect(ring[0]).toEqual(ring[ring.length - 1]);",
          "});",
        ].join("\n"),
      }),
    ).toEqual([
      "test/venue/planted.test.ts line 1 uses expect",
      "test/venue/planted.test.ts line 3 uses expect",
    ]);
  });

  test("each snapshot matcher fails it, however it is reached", () => {
    for (const matcher of [
      "toMatchSnapshot()",
      'toMatchInlineSnapshot("")',
      'toMatchFileSnapshot("out.txt")',
      "toThrowErrorMatchingSnapshot()",
      "toThrowErrorMatchingInlineSnapshot()",
    ]) {
      // Through the test context, so the file never names expect.
      const found = planted({
        "planted.test.ts": `test("mesh", (context) => {\n  context.expect(polygons).${matcher};\n});`,
      });
      expect(found).toContain("test/venue/planted.test.ts line 2 uses a snapshot matcher");
    }
  });

  test("a helper the venue test imports is checked too", () => {
    expect(
      planted({
        "planted.test.ts":
          'import { wellFormed } from "../planted-helper.ts";\nwellFormed(polygons);',
        "../planted-helper.ts": [
          'import * as vitest from "vitest";',
          "export function wellFormed(polygons) {",
          "  vitest.expect(polygons[0].areaM2).toBeCloseTo(area, 6);",
          "}",
        ].join("\n"),
      }),
    ).toEqual(["test/planted-helper.ts line 3 uses expect"]);
  });

  test("assert, a destructured expect and a dynamic import fail it", () => {
    expect(
      planted({
        "planted.test.ts": [
          'import { assert } from "vitest";',
          'test("mesh", ({ expect }) => {});',
          'const helper = await import("./planted-helper.ts");',
        ].join("\n"),
        "planted-helper.ts": 'import { strictEqual } from "node:assert";',
      }),
    ).toEqual([
      "test/venue/planted.test.ts line 1 uses assert",
      "test/venue/planted.test.ts line 2 uses expect",
      "test/venue/planted-helper.ts line 1 uses assert",
    ]);
  });

  test("Vitest's should and chai fail it", () => {
    expect(
      planted({
        "planted.test.ts": [
          'import { should } from "vitest";',
          "should();",
          "polygons.length.should.equal(count);",
          'import("./planted-helper.ts");',
        ].join("\n"),
        "planted-helper.ts": 'import { chai } from "vitest";\nchai.should();',
      }),
    ).toEqual([
      "test/venue/planted.test.ts line 1 uses should",
      "test/venue/planted.test.ts line 2 uses should",
      "test/venue/planted.test.ts line 3 uses should",
      "test/venue/planted-helper.ts line 1 uses chai",
      "test/venue/planted-helper.ts line 2 uses should",
      "test/venue/planted-helper.ts line 2 uses chai",
    ]);
  });

  test("logging the grid's size or angle or the mesh's extent fails it", () => {
    expect(
      planted({
        "planted.test.ts": [
          'console.log(stats.gridWidth + " x " + stats.gridHeight + " cells");',
          "const { gridAngleRad } = stats;",
          "if (error instanceof FloorplanExtentError) console.log(error.extentM);",
        ].join("\n"),
      }),
    ).toEqual([
      "test/venue/planted.test.ts line 1 uses the grid's dimensions",
      "test/venue/planted.test.ts line 2 uses the grid angle",
      "test/venue/planted.test.ts line 3 uses the mesh's extent",
    ]);
  });

  test("the library in src/ is not scanned, and a helper beside it in test/ is", () => {
    expect(
      planted({
        "planted.test.ts": [
          'import { buildFloorplan } from "../../src/index.ts";',
          'import { log } from "../planted-helper.ts";',
        ].join("\n"),
        "../planted-helper.ts": "export const log = (stats) => console.log(stats.gridHeight);",
      }),
    ).toEqual(["test/planted-helper.ts line 1 uses the grid's dimensions"]);
  });

  test("check() and comments that name what the code avoids pass it", () => {
    expect(
      planted({
        "planted.test.ts": [
          "// Never expect or toMatchSnapshot: their diffs print values.",
          "/*",
          " * assert and should print values too, and gridWidth is the floor's extent.",
          " */",
          'import { check } from "../check.ts";',
          'check(polygons.length > 0, "no polygons, expected at least one");',
        ].join("\n"),
        "../check.ts": "export function check(condition, message) {}",
      }),
    ).toEqual([]);
  });
});

describe("check messages", () => {
  // A 10 m square hall, counter-clockwise from above.
  const square = (): [number, number][] => [
    [12.5, 40.25],
    [22.5, 40.25],
    [22.5, 30.25],
    [12.5, 30.25],
    [12.5, 40.25],
  ];
  const message = (polygons: FloorPolygon[]): string => {
    try {
      checkWellFormed(polygons, "hall.ply polygons");
    } catch (error) {
      expect(error).toBeInstanceOf(CheckError);
      return (error as Error).message;
    }
    return "passed";
  };

  test("a well-formed polygon passes", () => {
    expect(message([{ outer: square(), holes: [], areaM2: 100 }])).toBe("passed");
  });

  test("each failure names the file and the item, and no value", () => {
    const open = square().slice(0, 4);
    open.push([12.5, 40.5]);
    expect(message([{ outer: open, holes: [], areaM2: 100 }])).toBe(
      "hall.ply polygons: outer ring of polygon 0 is not closed",
    );
    expect(message([{ outer: square().reverse(), holes: [], areaM2: 100 }])).toBe(
      "hall.ply polygons: outer ring of polygon 0 is not counter-clockwise",
    );
    expect(message([{ outer: square(), holes: [square()], areaM2: 0 }])).toBe(
      "hall.ply polygons: hole 0 of polygon 0 is not clockwise",
    );
    expect(message([{ outer: square(), holes: [], areaM2: 99.5 }])).toBe(
      "hall.ply polygons: areaM2 of polygon 0 doesn't match its rings",
    );
    const small = square().map(([x, z]): [number, number] => [x / 2, z / 2]);
    expect(
      message([
        { outer: small, holes: [], areaM2: 25 },
        { outer: square(), holes: [], areaM2: 100 },
      ]),
    ).toBe("hall.ply polygons: polygon 1 is larger than the one before it");
    expect(
      message([
        {
          outer: [...square().slice(0, 2), [Number.NaN, 30.25], ...square().slice(3)],
          holes: [],
          areaM2: 100,
        },
      ]),
    ).toBe("hall.ply polygons: outer ring of polygon 0 has a non-finite coordinate");
    expect(message([{ outer: square().slice(2), holes: [], areaM2: 0 }])).toBe(
      "hall.ply polygons: outer ring of polygon 0 has fewer than 4 points",
    );
  });

  test("check() throws a CheckError with the message as given", () => {
    expect(() => check(false, "station.f32: no polygons")).toThrow(
      new CheckError("station.f32: no polygons"),
    );
    expect(() => check(true, "unused")).not.toThrow();
  });
});
