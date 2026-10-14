// The package is environment-neutral: the webapp and the mapper app's DOM component import it, and
// the mapper app runs Hermes (no eval, no WebAssembly). `tsc -p tsconfig.neutral.json` checks for
// Node globals and node: imports; this test checks what tsc can't: at run time the entry imports
// only its own files and @usg/contracts' neutral entry. The style spec is a type-only import (its
// runtime, with the validator, is for the tests).

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(PACKAGE_DIR, "src");

describe("the package entry", () => {
  test.each(readdirSync(SRC).filter((file) => file.endsWith(".ts")))(
    "src/%s imports at run time only its own files and @usg/contracts",
    (file) => {
      const text = readFileSync(join(SRC, file), "utf8");
      // Static (from "x"), side-effect (import "x") and dynamic (import("x")) imports, with
      // whether the import is type-only.
      const imports = [
        ...text.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[^"';]*?\bfrom\s*)?\(?\s*"([^"]+)"/g),
      ].map((match) => ({ typeOnly: match[1] !== undefined, specifier: match[2] ?? "" }));
      if (file === "index.ts") expect(imports.length).toBeGreaterThan(0);
      for (const { typeOnly, specifier } of imports) {
        if (typeOnly) continue;
        expect(
          specifier.startsWith("./") || specifier === "@usg/contracts",
          `${file} imports ${specifier} at run time`,
        ).toBe(true);
      }
    },
  );

  test("the . entry is src/index.ts, and the glyphs are exported", () => {
    const require = createRequire(import.meta.url);
    expect(require.resolve("@usg/map-style")).toBe(join(SRC, "index.ts"));
    expect(require.resolve("@usg/map-style/glyphs/OFL.txt")).toBe(
      join(PACKAGE_DIR, "glyphs", "OFL.txt"),
    );
  });

  test("the neutral typecheck compiles the entry without Node types", () => {
    const config = JSON.parse(
      readFileSync(join(PACKAGE_DIR, "tsconfig.neutral.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(config["files"]).toEqual(["src/index.ts"]);
    expect(config["compilerOptions"]).toMatchObject({
      types: [],
      noUncheckedSideEffectImports: true,
    });
  });
});
