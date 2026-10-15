import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  ANCHOR_KINDS,
  ANCHOR_ROLES,
  BOX_KINDS,
  CONNECTOR_EDGE_KINDS,
  DIFF_FEATURE_TYPES,
  DIFF_ROW_REFERENCES,
  EDGE_ACCESS_VALUES,
  EDGE_KINDS,
  FRAME_NAME_DIGITS,
  INDOOR_FEATURE_TYPES,
  NEVER_STEP_FREE_EDGE_KINDS,
  NODE_KINDS,
  NODE_TAG_KINDS,
  POI_CATEGORIES,
  POI_TAG_KINDS,
  REGISTRATIONS,
  SCHEMA_VERSION,
  SPACE_KINDS,
  STREET_PRIOR_SOURCES,
  TAG_TYPES,
  TRACKING_LIMITED_PREFIX,
  VENUE_KINDS,
} from "../src/index.ts";
import {
  readSchema as readAnySchema,
  readCaptureBundleSchema as readSchema,
  type SchemaObject,
} from "./schemas.ts";

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

// ---------------------------------------------------------------- map files and diff

/** `$defs.<name>` of a schema file, by its path under schemas/. */
function mapDef(path: string, name: string): SchemaObject {
  const defs = readAnySchema(path)["$defs"] as Record<string, SchemaObject>;
  const found = defs[name];
  if (found === undefined) throw new Error(`${path} has no $defs.${name}`);
  return found;
}

/** The column names of `CREATE TABLE public.<table> (...)` in db/schema.sql, in order. */
function sqlColumns(table: string): string[] {
  const match = new RegExp(`^CREATE TABLE public\\.${table} \\(\\n([\\s\\S]*?)\\n\\);$`, "m").exec(
    schemaSql,
  );
  if (match?.[1] === undefined) throw new Error(`db/schema.sql has no table ${table}`);
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("CONSTRAINT "))
    .map((line) => line.split(" ")[0] ?? "");
}

/** The property names of an object schema. */
function propertyNames(schema: SchemaObject | undefined): string[] {
  return Object.keys((schema?.["properties"] as object | undefined) ?? {});
}

describe("map enums match db/schema.sql", () => {
  test.each([
    ["venueKind", "venue_kind", VENUE_KINDS],
    ["spaceKind", "space_kind", SPACE_KINDS],
    ["nodeKind", "node_kind", NODE_KINDS],
    ["edgeKind", "edge_kind", EDGE_KINDS],
    ["edgeAccess", "edge_access", EDGE_ACCESS_VALUES],
    ["poiCategory", "poi_category", POI_CATEGORIES],
    ["streetPriorSource", "street_prior_source", STREET_PRIOR_SOURCES],
  ] as const)("map/defs %s is %s, and so is its constant", (defName, sqlName, constant) => {
    expect(mapDef("map/defs.schema.json", defName)["enum"]).toEqual(sqlEnum(sqlName));
    expect(constant).toEqual(sqlEnum(sqlName));
  });

  test("connector and never-step-free edge kinds are edge kinds", () => {
    for (const kind of [...CONNECTOR_EDGE_KINDS, ...NEVER_STEP_FREE_EDGE_KINDS]) {
      expect(EDGE_KINDS).toContain(kind);
    }
  });

  test("status.json's feature types are status_reports.feature_type's", () => {
    const check =
      /status_reports_feature_type_check CHECK \(\(feature_type = ANY \(ARRAY\[([^\]]*)\]/.exec(
        schemaSql,
      );
    const allowed = [...(check?.[1] ?? "").matchAll(/'([^']*)'::text/g)].map((m) => m[1]);
    expect(allowed).toEqual(["node", "edge"]);
    expect(mapDef("snapshot/status.schema.json", "featureType")["enum"]).toEqual(allowed);
  });
});

/** HEAD table of each diff feature type. */
const TABLES = {
  venue: "venues",
  level: "levels",
  space: "spaces",
  node: "nodes",
  edge: "edges",
  poi: "pois",
  anchor: "anchors",
  street_connector: "street_connectors",
} as const;

/**
 * Columns a diff row leaves out (docs/diff-format.md): the key and rev are on the entry, ordinal
 * is set by a trigger, permission only by the seed script, and the times are bookkeeping.
 */
const NOT_DIFFED: Record<string, readonly string[]> = {
  venues: ["id", "rev", "permission", "updated_at"],
  levels: ["id", "rev"],
  spaces: ["id", "rev"],
  nodes: ["id", "rev", "ordinal"],
  edges: ["id", "rev"],
  pois: ["id", "rev"],
  anchors: ["id", "rev", "ordinal", "created_at"],
};

describe("diff rows are the HEAD tables' columns", () => {
  test.each(DIFF_FEATURE_TYPES)("%s", (featureType) => {
    const table = TABLES[featureType];
    const columns = sqlColumns(table).filter((c) => !NOT_DIFFED[table]?.includes(c));
    expect(propertyNames(mapDef("diff/change-set-diff.schema.json", `${featureType}Row`))).toEqual(
      columns,
    );
    expect(sqlColumns(table)).toContain("rev");
  });
});

describe("diff row references are the foreign keys between HEAD tables", () => {
  /** `FOREIGN KEY (<column>) REFERENCES public.<table>(id)` constraints of a table. */
  function foreignKeys(table: string): { column: string; table: string }[] {
    const pattern = new RegExp(
      `^ALTER TABLE ONLY public\\.${table}\\n\\s+ADD CONSTRAINT \\w+ FOREIGN KEY \\((\\w+)\\) REFERENCES public\\.(\\w+)\\(id\\)`,
      "gm",
    );
    return [...schemaSql.matchAll(pattern)].map((m) => ({
      column: String(m[1]),
      table: String(m[2]),
    }));
  }
  const featureTypeOf = Object.fromEntries(
    Object.entries(TABLES).map(([featureType, table]) => [table, featureType]),
  );

  test.each(DIFF_FEATURE_TYPES)("%s", (featureType) => {
    const expected = foreignKeys(TABLES[featureType])
      .filter((fk) => DIFF_FEATURE_TYPES.some((t) => TABLES[t] === fk.table))
      .map((fk) => ({ column: fk.column, feature_type: featureTypeOf[fk.table] }));
    const sort = (list: readonly { column: string }[]) =>
      [...list].sort((a, b) => a.column.localeCompare(b.column));
    expect(sort(DIFF_ROW_REFERENCES[featureType])).toEqual(sort(expected));
  });

  test("the parser finds the edge foreign keys", () => {
    expect(foreignKeys("edges").map((fk) => fk.column)).toEqual([
      "from_node",
      "level_id",
      "to_node",
    ]);
  });
});

/**
 * Properties of the public files that are not columns of their table: derived for clients. A
 * street connector's id is derived from its node_id (street_connectors has no id column).
 */
const DERIVED: Record<string, readonly string[]> = {
  venue: ["feature_type"],
  level: ["feature_type"],
  space: ["feature_type", "ordinal"],
  node: ["feature_type"],
  edge: ["feature_type", "from_ordinal", "to_ordinal"],
  poi: ["feature_type", "ordinal"],
  street_connector: ["feature_type", "id", "ordinal"],
};

describe("indoor.json properties come from the HEAD tables", () => {
  test.each(INDOOR_FEATURE_TYPES)("%s", (featureType) => {
    const name =
      featureType === "street_connector" ? "streetConnectorProperties" : `${featureType}Properties`;
    const properties = propertyNames(mapDef("snapshot/indoor.schema.json", name));
    const columns = sqlColumns(TABLES[featureType]);
    expect(
      properties.filter((p) => !DERIVED[featureType]?.includes(p) && !columns.includes(p)),
    ).toEqual([]);
  });

  test("street edges' properties are street_edges columns or OSM tags", () => {
    const properties = propertyNames(mapDef("snapshot/street.schema.json", "edgeProperties"));
    const columns = sqlColumns("street_edges");
    const fromTags = ["highway", "footway"];
    expect(
      properties.filter(
        (p) => p !== "feature_type" && !fromTags.includes(p) && !columns.includes(p),
      ),
    ).toEqual([]);
  });
});
