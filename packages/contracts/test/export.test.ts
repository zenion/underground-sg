// The private full export of HEAD (schemas/export/, docs/head-export-format.md): the schema reuses
// the diff's rows, so a row the diff refuses the export refuses too; the checks after the schema
// refuse unsorted or repeated ids and bad coordinates; and its key never comes from a content hash.

import { describe, expect, test } from "vitest";
import { type HeadExport, headExportKey } from "../src/index.ts";
import { validateHeadExport } from "../src/validators.ts";

const SHA = "3f8a2b6c4d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a";
const VENUE = "10000000-0000-0000-0000-000000000001";
const LEVEL = "20000000-0000-0000-0000-000000000001";
const NODE_A = "40000000-0000-0000-0000-000000000001";
const NODE_B = "40000000-0000-0000-0000-000000000002";

const node = (id: string, lon: number) => ({
  id,
  rev: 1,
  row: {
    level_id: LEVEL,
    kind: "junction" as const,
    name: null,
    street_name: null,
    connector_id: null,
    elevation_m: null,
    geom: { type: "Point" as const, coordinates: [lon, 1.2914] as [number, number] },
  },
});

const document: HeadExport = {
  schema_version: 1,
  version: 3,
  published_at: "2026-11-02T14:05:11+08:00",
  snapshot_sha256: SHA,
  venues: [
    {
      id: VENUE,
      rev: 1,
      permission: null,
      row: { name: "Funan", kind: "mall", operator: "Synthetic Landlord", footprint: null },
    },
  ],
  levels: [
    {
      id: LEVEL,
      rev: 2,
      row: { venue_id: VENUE, ordinal: -2, name: "B2", elevation_m: -9.5, sort_key: 0 },
    },
  ],
  spaces: [],
  nodes: [node(NODE_A, 103.8502), node(NODE_B, 103.8504)],
  edges: [],
  pois: [],
  anchors: [
    {
      id: "80000000-0000-0000-0000-000000000001",
      rev: 1,
      row: {
        node_id: NODE_A,
        kind: "floor_point",
        name: "Funan B2 door (synthetic)",
        level_id: LEVEL,
        facing_deg: 90,
        surveyed_geom: null,
        prior_source: null,
        prior_sigma_m: null,
        photo_uri: "anchor-photos/80000000-0000-0000-0000-000000000001.jpg",
      },
    },
  ],
};

describe("validateHeadExport", () => {
  test("accepts an export with private columns and anchors", () => {
    expect(validateHeadExport(document)).toEqual({ valid: true, problems: [] });
  });

  test.each<[string, unknown]>([
    ["a missing table", { ...document, anchors: undefined }],
    ["an unknown field", { ...document, note: "x" }],
    [
      "a row the diff format refuses (empty name)",
      {
        ...document,
        levels: [{ ...document.levels[0], row: { ...document.levels[0]?.row, name: "" } }],
      },
    ],
    [
      "a row with an ordinal on a node",
      {
        ...document,
        nodes: [{ ...node(NODE_A, 103.8502), row: { ...node(NODE_A, 103.8502).row, ordinal: -2 } }],
      },
    ],
    [
      "permission on a level",
      {
        ...document,
        levels: [{ ...document.levels[0], permission: null }],
      },
    ],
    ["rev 0", { ...document, venues: [{ ...document.venues[0], rev: 0 }] }],
    ["schema_version 2", { ...document, schema_version: 2 }],
  ])("refuses %s", (_name, invalid) => {
    expect(validateHeadExport(invalid).valid).toBe(false);
  });

  test("refuses entries out of id order, or an id twice", () => {
    expect(
      validateHeadExport({ ...document, nodes: [node(NODE_B, 103.8504), node(NODE_A, 103.8502)] })
        .problems,
    ).toEqual(["nodes[1]: entries are not sorted by id"]);
    expect(
      validateHeadExport({ ...document, nodes: [node(NODE_A, 103.8502), node(NODE_A, 103.8504)] })
        .problems,
    ).toEqual([`nodes[1]: id ${NODE_A} is listed twice`]);
  });

  test("refuses coordinates with more than 7 decimals", () => {
    const result = validateHeadExport({ ...document, nodes: [node(NODE_A, 103.85021234)] });
    expect(result.valid).toBe(false);
    expect(result.problems[0]).toMatch(/^nodes\[0\]\.row\.geom\.coordinates/);
  });
});

describe("headExportKey", () => {
  test("is head/<version>/<uuid>.json", () => {
    expect(headExportKey(7, "0c6c1a8e-3f4b-4f0e-9a51-0d1c2b3a4f5e")).toBe(
      "head/7/0c6c1a8e-3f4b-4f0e-9a51-0d1c2b3a4f5e.json",
    );
  });

  test("refuses a version that isn't a positive integer, or a uuid that isn't one", () => {
    expect(() => headExportKey(0, "0c6c1a8e-3f4b-4f0e-9a51-0d1c2b3a4f5e")).toThrow();
    expect(() => headExportKey(1, SHA)).toThrow();
    expect(() => headExportKey(1, "../latest")).toThrow();
  });
});
