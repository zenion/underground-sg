// The Swift module's golden files (apps/mapper/modules/capture-native/Tests/CaptureCoreTests/
// Golden/) against the JSON Schemas. The Swift tests prove LineEncoder writes these bytes; this
// proves the schemas accept them, so what Swift writes is what the PC tools read. Each file is
// named after the root title of its schema: <Title>.jsonl holds lines, <Title>.json one document.
// Messages name the file and the line, never the values.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { describeSchemaError } from "../src/bundle-validator/schemas.ts";
import { ALL_SCHEMA_FILES, createAjv, readSchema } from "./schemas.ts";

const GOLDEN_DIR = new URL(
  "../../../apps/mapper/modules/capture-native/Tests/CaptureCoreTests/Golden/",
  import.meta.url,
);

/** The recording files the Swift recorder writes; each must have a golden. */
const REQUIRED = [
  "RecordingManifest",
  "RecordingFrameLine",
  "MotionLine",
  "AltitudeLine",
  "AnchorHistoryLine",
  "RecordingEventLine",
  "ActionLine",
  "TelemetryLine",
  "MeshHistoryLine",
  "ExportParts",
];

const ajv = createAjv();

/** Each schema file's `$id`, by its root title. */
const idByTitle = new Map<string, string>();
for (const file of ALL_SCHEMA_FILES) {
  const schema = readSchema(file);
  if (typeof schema["title"] === "string" && typeof schema["$id"] === "string") {
    idByTitle.set(schema["title"], schema["$id"]);
  }
}

const files = readdirSync(GOLDEN_DIR).sort();

function split(file: string): { title: string; kind: "jsonl" | "json" } | undefined {
  const match = /^([A-Za-z0-9]+)\.(jsonl|json)$/.exec(file);
  return match ? { title: match[1] as string, kind: match[2] as "jsonl" | "json" } : undefined;
}

/** Problems with one golden file, as messages naming the file and line; empty when it is valid. */
function check(file: string, text: string): string[] {
  const name = split(file);
  if (name === undefined) return [`${file}: not <Title>.jsonl or <Title>.json`];
  const id = idByTitle.get(name.title);
  if (id === undefined) return [`${file}: no schema has the root title ${name.title}`];
  const validate = ajv.getSchema(id);
  if (validate === undefined) return [`${file}: Ajv has no schema ${id}`];

  if (text.length === 0) return [`${file}: empty`];
  if (!text.endsWith("\n")) return [`${file}: does not end with a newline`];
  const lines = text.slice(0, -1).split("\n");
  if (name.kind === "json" && lines.length !== 1) {
    return [`${file}: a document must be one line, as LineEncoder writes it`];
  }

  const problems: string[] = [];
  lines.forEach((line, i) => {
    const at = `${file} line ${i + 1}`;
    if (line.length === 0) {
      problems.push(`${at}: blank`);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      problems.push(`${at}: not JSON`);
      return;
    }
    if (!validate(value)) {
      const errors = (validate.errors ?? []).map(describeSchemaError).join("; ");
      problems.push(`${at}: ${errors}`);
    }
  });
  return problems;
}

describe("the Swift golden files", () => {
  test("every file the recorder writes has a golden", () => {
    const titles = new Set(files.map((file) => split(file)?.title));
    const missing = REQUIRED.filter((title) => !titles.has(title));
    expect(missing, "types without a golden file").toEqual([]);
  });

  test.each(files)("%s matches its schema", (file) => {
    expect(check(file, readFileSync(new URL(file, GOLDEN_DIR), "utf8"))).toEqual([]);
  });
});

describe("the repo keeps the goldens byte-exact", () => {
  const GOLDEN_PATH = "apps/mapper/modules/capture-native/Tests/CaptureCoreTests/Golden";
  const root = new URL("../../../", import.meta.url);
  const read = (path: string) => readFileSync(new URL(path, root), "utf8");

  test("Biome never formats them", () => {
    // `pnpm format` would pretty-print the .json documents across lines, which LineEncoder
    // never writes, and `pnpm lint` fails on them until it does.
    const biome = JSON.parse(read("biome.json")) as { files: { includes: string[] } };
    expect(biome.files.includes).toContain(`!${GOLDEN_PATH}`);
  });

  test("git never converts their line endings", () => {
    expect(read(".gitattributes").split("\n")).toContain(
      `${GOLDEN_PATH}/* -text linguist-generated=true`,
    );
  });

  test("SwiftPM leaves them out of the test target", () => {
    // The Swift tests read them through #filePath; undeclared, SwiftPM warns about each file.
    expect(read("apps/mapper/modules/capture-native/Package.swift")).toMatch(
      /\.testTarget\([^)]*path: "Tests\/CaptureCoreTests",[^)]*exclude: \["Golden"\]/,
    );
  });
});

describe("the golden check", () => {
  const line = '{"pressure_kpa":101.38,"relative_m":-4.82,"t":23.5}';

  test("accepts a valid file", () => {
    expect(check("AltitudeLine.jsonl", `${line}\n${line}\n`)).toEqual([]);
  });

  test("refuses a file no schema is titled after", () => {
    expect(check("AltitudeSample.jsonl", `${line}\n`)).toEqual([
      "AltitudeSample.jsonl: no schema has the root title AltitudeSample",
    ]);
    expect(check("AltitudeLine.txt", `${line}\n`)).toEqual([
      "AltitudeLine.txt: not <Title>.jsonl or <Title>.json",
    ]);
  });

  test("refuses an empty file, a blank line and a missing newline", () => {
    expect(check("AltitudeLine.jsonl", "")).toEqual(["AltitudeLine.jsonl: empty"]);
    expect(check("AltitudeLine.jsonl", `${line}\n\n${line}\n`)).toEqual([
      "AltitudeLine.jsonl line 2: blank",
    ]);
    expect(check("AltitudeLine.jsonl", line)).toEqual([
      "AltitudeLine.jsonl: does not end with a newline",
    ]);
    expect(check("ExportParts.json", "{}\n{}\n")).toEqual([
      "ExportParts.json: a document must be one line, as LineEncoder writes it",
    ]);
  });

  test("names the file and line of an invalid line, not its values", () => {
    const bad = '{"pressure_kpa":-7.25,"relative_m":-4.82,"t":23.5}';
    const problems = check("AltitudeLine.jsonl", `${line}\n${bad}\n{"t":\n`);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^AltitudeLine\.jsonl line 2: /);
    expect(problems[1]).toBe("AltitudeLine.jsonl line 3: not JSON");
    expect(problems.join()).not.toContain("7.25");
  });
});
