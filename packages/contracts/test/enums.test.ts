import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  ANCHOR_KINDS,
  ANCHOR_ROLES,
  BOX_KINDS,
  FRAME_NAME_DIGITS,
  NODE_TAG_KINDS,
  POI_TAG_KINDS,
  REGISTRATIONS,
  SCHEMA_VERSION,
  TAG_TYPES,
  TRACKING_LIMITED_PREFIX,
} from "../src/index.ts";
import { readSchema, type SchemaObject } from "./schemas.ts";

// The generated snapshot of the migrated schema (pg_dump --schema-only; `pnpm db dump`).
const schemaSql = readFileSync(new URL("../../../db/schema.sql", import.meta.url), "utf8");

/**
 * The values of `CREATE TYPE public.<name> AS ENUM (...)` in db/schema.sql, in order. pg_dump
 * qualifies the name with its schema and puts one value per line.
 */
function sqlEnum(name: string): string[] {
  const match = new RegExp(`^CREATE TYPE public\\.${name} AS ENUM \\(([^)]*)\\);$`, "m").exec(
    schemaSql,
  );
  if (match?.[1] === undefined) throw new Error(`db/schema.sql has no enum ${name}`);
  return [...match[1].matchAll(/'([^']*)'/g)].map((value) => String(value[1]));
}

/** `$defs.<name>` of a schema file. */
function def(file: string, name: string): SchemaObject {
  const defs = readSchema(file)["$defs"] as Record<string, SchemaObject>;
  const found = defs[name];
  if (found === undefined) throw new Error(`${file} has no $defs.${name}`);
  return found;
}

describe("enums match db/schema.sql", () => {
  test("tags: node kinds are node_kind", () => {
    expect(def("tags.schema.json", "nodeKind")["enum"]).toEqual(sqlEnum("node_kind"));
  });

  test("tags: POI kinds are poi_category", () => {
    expect(def("tags.schema.json", "poiCategory")["enum"]).toEqual(sqlEnum("poi_category"));
  });

  test("anchors: kinds are anchor_kind", () => {
    expect(def("anchors.schema.json", "kind")["enum"]).toEqual(sqlEnum("anchor_kind"));
  });
});

describe("constants match the schemas", () => {
  test("SCHEMA_VERSION", () => {
    const properties = readSchema("manifest.schema.json")["properties"] as Record<
      string,
      SchemaObject
    >;
    expect(properties["schema_version"]?.["const"]).toBe(SCHEMA_VERSION);
  });

  test.each([
    ["ANCHOR_ROLES", ANCHOR_ROLES, "anchors.schema.json", "role"],
    ["ANCHOR_KINDS", ANCHOR_KINDS, "anchors.schema.json", "kind"],
    ["REGISTRATIONS", REGISTRATIONS, "anchors.schema.json", "registration"],
    ["NODE_TAG_KINDS", NODE_TAG_KINDS, "tags.schema.json", "nodeKind"],
    ["POI_TAG_KINDS", POI_TAG_KINDS, "tags.schema.json", "poiCategory"],
    ["BOX_KINDS", BOX_KINDS, "blur-line.schema.json", "boxKind"],
  ] as const)("%s", (_name, values, file, defName) => {
    expect(values).toEqual(def(file, defName)["enum"]);
  });

  test("FRAME_NAME_DIGITS", () => {
    expect(def("defs.schema.json", "frameIndex")["maximum"]).toBe(10 ** FRAME_NAME_DIGITS - 1);
    expect(def("defs.schema.json", "keyframePath")["pattern"]).toContain(
      `[0-9]{${FRAME_NAME_DIGITS}}`,
    );
  });

  test("TRACKING_LIMITED_PREFIX", () => {
    const properties = readSchema("pose-line.schema.json")["properties"] as Record<
      string,
      SchemaObject
    >;
    expect(properties["tracking"]?.["pattern"]).toContain(`|${TRACKING_LIMITED_PREFIX}[`);
  });

  test("TAG_TYPES", () => {
    expect(TAG_TYPES).toEqual([
      def("tags.schema.json", "nodeTagType")["const"],
      def("tags.schema.json", "poiTagType")["const"],
    ]);
  });
});
