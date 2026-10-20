// The `.` entry stays environment-neutral, so the mapper app can import it later (the
// trace-playing fake). `tsc -p tsconfig.neutral.json` compiles it with only the ES2024 library;
// these tests check what tsc can't: the import graph and APIs Hermes lacks.

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, test } from "vitest";

const PACKAGE_DIR = join(import.meta.dirname, "..");
const SRC_DIR = join(PACKAGE_DIR, "src");
/** Packages the neutral source may import: both are environment-neutral themselves. */
const NEUTRAL_PACKAGES = ["@usg/contracts", "@usg/floorplan/synthetic"];

function neutralFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts") && !path.startsWith(`node${sep}`))
    .map((path) => join(SRC_DIR, path));
}

describe("environment neutrality", () => {
  test("the entry reaches every neutral file and imports only neutral packages", () => {
    const seen = new Set<string>();
    const pending = [join(SRC_DIR, "index.ts")];
    while (pending.length > 0) {
      const file = pending.pop() ?? "";
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(file, "utf8");
      const specifiers = [...text.matchAll(/\b(?:from|import)\s*\(?\s*"([^"]+)"/g)].map(
        (match) => match[1] ?? "",
      );
      for (const specifier of specifiers) {
        if (specifier.startsWith(".")) {
          expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\.?\/[\w/-]+\.ts$/);
          expect(specifier, `${file} imports the node entry`).not.toMatch(/(^|\/)node\//);
          pending.push(join(dirname(file), specifier));
        } else {
          expect(NEUTRAL_PACKAGES, `${file} imports ${specifier}`).toContain(specifier);
        }
      }
    }
    const rel = (files: Iterable<string>) => [...files].map((f) => relative(SRC_DIR, f)).sort();
    expect(rel(seen)).toEqual(rel(neutralFiles()));
  });

  test("the neutral source uses nothing Node-only or unavailable in Hermes", () => {
    const forbidden: [RegExp, string][] = [
      [/\bnode:/, "a node: import"],
      [/\bprocess\b/, "process"],
      [/\bBuffer\b/, "Buffer"],
      [/\bTextEncoder\b|\bTextDecoder\b/, "TextEncoder or TextDecoder"],
      [/\brequire\s*\(/, "require()"],
      [/\beval\b/, "eval"],
      [/\bWebAssembly\b/, "WebAssembly"],
      [/\bimport\s*\(/, "dynamic import()"],
      [/\b(?:window|document|self)\./, "a DOM global"],
    ];
    for (const file of neutralFiles()) {
      const text = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      for (const [pattern, what] of forbidden) {
        expect(pattern.test(text), `${relative(SRC_DIR, file)} uses ${what}`).toBe(false);
      }
    }
  });

  test("the typecheck compiles the entry without Node types", () => {
    const config = JSON.parse(readFileSync(join(PACKAGE_DIR, "tsconfig.neutral.json"), "utf8"));
    expect(config.files).toEqual(["src/index.ts"]);
    expect(config.compilerOptions).toMatchObject({ lib: ["es2024"], types: [] });
  });

  test("the . and ./node exports are the entries", () => {
    const require = createRequire(import.meta.url);
    expect(require.resolve("@usg/recording")).toBe(join(SRC_DIR, "index.ts"));
    expect(require.resolve("@usg/recording/node")).toBe(join(SRC_DIR, "node", "index.ts"));
  });
});
