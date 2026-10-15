// The examples in docs/snapshot-format.md, docs/diff-format.md and docs/head-export-format.md: every
// JSON block tagged with a file name (```json latest.json) is valid, so the docs and the schemas
// can't drift apart.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { checkLatestPointer, checkStatusOverlay } from "../src/index.ts";
import {
  snapshotValidator,
  validateChangeSetDiff,
  validateHeadExport,
  validateSnapshotFile,
} from "../src/validators.ts";
import * as examples from "./map-examples.ts";

function taggedBlocks(doc: string): [string, unknown][] {
  const text = readFileSync(new URL(`../../../docs/${doc}`, import.meta.url), "utf8");
  return [...text.matchAll(/^```json ([^\n]+)\n([\s\S]*?)^```$/gm)].map((match) => [
    String(match[1]).trim(),
    JSON.parse(String(match[2])),
  ]);
}

const snapshotDoc = taggedBlocks("snapshot-format.md");
const diffDoc = taggedBlocks("diff-format.md");
const exportDoc = taggedBlocks("head-export-format.md");

describe("docs/snapshot-format.md", () => {
  test("has an example of each file", () => {
    expect(snapshotDoc.map(([file]) => file)).toEqual([
      "latest.json",
      "indoor.json",
      "street.json",
      "status.json",
    ]);
  });

  test.each(snapshotDoc)("its %s example is valid", (file, document) => {
    if (file === "indoor.json" || file === "street.json") {
      // Excerpts: features are cut, so references may point outside them. The schema still holds.
      const validate = snapshotValidator(file);
      expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
    } else if (file === "latest.json" || file === "status.json") {
      expect(validateSnapshotFile(file, document)).toEqual({ valid: true, problems: [] });
    } else {
      throw new Error(`unexpected example ${file}`);
    }
  });

  test("its latest.json and status.json examples are the test examples", () => {
    const blocks = Object.fromEntries(snapshotDoc);
    expect(blocks["latest.json"]).toEqual(examples.latest);
    expect(blocks["status.json"]).toEqual(examples.status);
    expect(checkLatestPointer(examples.latest)).toEqual([]);
    expect(checkStatusOverlay(examples.status)).toEqual([]);
  });

  test("its indoor.json excerpt is features of the test example", () => {
    const excerpt = Object.fromEntries(snapshotDoc)["indoor.json"] as typeof examples.indoor;
    for (const feature of excerpt.features) {
      expect(examples.indoor.features).toContainEqual(feature);
    }
  });
});

describe("docs/diff-format.md", () => {
  test("its example is the test example, and valid", () => {
    expect(diffDoc.map(([name]) => name)).toEqual(["change_sets.diff"]);
    const [, document] = diffDoc[0] ?? [];
    expect(document).toEqual(examples.diff);
    expect(validateChangeSetDiff(document, "structural")).toEqual({ valid: true, problems: [] });
  });
});

describe("docs/head-export-format.md", () => {
  test("its example is valid", () => {
    expect(exportDoc.map(([name]) => name)).toEqual(["head-export.json"]);
    const [, document] = exportDoc[0] ?? [];
    expect(validateHeadExport(document)).toEqual({ valid: true, problems: [] });
  });
});
