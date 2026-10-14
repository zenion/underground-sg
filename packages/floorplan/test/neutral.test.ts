import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(PACKAGE_DIR, "src");
/** The package's entries: `.` and `./synthetic` (the mapper app's on-phone benchmark uses both). */
const ENTRIES = ["src/index.ts", "src/synthetic.ts"];

// Environment neutrality itself (no Node or DOM globals) is checked by the typecheck:
// `tsc -p tsconfig.neutral.json` compiles the entries with only the ES2024 library. These tests
// check what tsc can't: the import graph, the package's dependencies, and APIs Hermes lacks or
// that the mapper app must not use.
describe("environment neutrality", () => {
  test("the entries import only this package's own source files", () => {
    const seen = new Set<string>();
    const pending = ENTRIES.map((entry) => join(PACKAGE_DIR, entry));
    while (pending.length > 0) {
      const file = pending.pop() ?? "";
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(file, "utf8");
      // Static (from "x"), side-effect (import "x") and dynamic (import("x")) imports.
      const specifiers = [...text.matchAll(/\b(?:from|import)\s*\(?\s*"([^"]+)"/g)].map(
        (match) => match[1] ?? "",
      );
      for (const specifier of specifiers) {
        expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\/[\w-]+\.ts$/);
        pending.push(join(dirname(file), specifier));
      }
    }
    // Every source file is reachable from an entry, so the neutral typecheck covers them all.
    expect([...seen].map((file) => file.slice(SRC_DIR.length + 1)).sort()).toEqual(
      readdirSync(SRC_DIR).sort(),
    );
  });

  test("the source uses nothing Node-only or unavailable in Hermes", () => {
    const forbidden: [RegExp, string][] = [
      [/\bnode:/, "a node: import"],
      [/\bprocess\b/, "process"],
      [/\bBuffer\b/, "Buffer"],
      [/\brequire\s*\(/, "require()"],
      [/\beval\b/, "eval"],
      [/\bnew\s+Function\b|\bFunction\s*\(/, "new Function"],
      [/\bWebAssembly\b/, "WebAssembly"],
      [/\bimport\s*\(/, "dynamic import()"],
      [/\b(?:window|document|self)\./, "a DOM global"],
      [/\bstructuredClone\b|\bSharedArrayBuffer\b|\bAtomics\b/, "an API Hermes may lack"],
    ];
    for (const file of readdirSync(SRC_DIR)) {
      // Code only: comments may name what the code avoids.
      const text = readFileSync(join(SRC_DIR, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      for (const [pattern, what] of forbidden) {
        expect(pattern.test(text), `${file} uses ${what}`).toBe(false);
      }
    }
  });

  test("the package has no runtime dependencies", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(manifest["dependencies"]).toBeUndefined();
    expect(manifest["peerDependencies"]).toBeUndefined();
  });

  test("the neutral typecheck compiles the entries without Node types", () => {
    const config = JSON.parse(
      readFileSync(join(PACKAGE_DIR, "tsconfig.neutral.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(config["files"]).toEqual(ENTRIES);
    expect(config["compilerOptions"]).toMatchObject({
      lib: ["es2024"],
      types: [],
      noUncheckedSideEffectImports: true,
    });
    const scripts = (
      JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts["typecheck"]).toContain("tsc -p tsconfig.neutral.json");
  });

  test("the . and ./synthetic exports are the entries", () => {
    const require = createRequire(import.meta.url);
    expect(require.resolve("@usg/floorplan")).toBe(join(SRC_DIR, "index.ts"));
    expect(require.resolve("@usg/floorplan/synthetic")).toBe(join(SRC_DIR, "synthetic.ts"));
  });
});
