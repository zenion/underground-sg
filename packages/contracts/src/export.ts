// The private full export of HEAD (docs/head-export-format.md): constants and the checks its
// schema can't express. Environment-neutral, like the rest of the `.` entry; the writer
// (services/api) validates with `validateHeadExport` in `@usg/contracts/validators`.

import type { HeadExport } from "./generated/contracts.ts";
import { checkGeometry, type Geometry, ProblemList } from "./map.ts";
import { SCHEMA_BASE_URL } from "./schema-ids.ts";

/** Base of the export schema's `$id`. */
export const EXPORT_SCHEMA_BASE_URL = `${SCHEMA_BASE_URL}export/`;

/** The schema file of the private full export. */
export const HEAD_EXPORT_SCHEMA_FILE = "head-export.schema.json";

/** The export format version this package describes (`schema_version`). */
export const HEAD_EXPORT_SCHEMA_VERSION = 1;

/** The HEAD tables an export holds, in the order the document lists them. */
export const HEAD_EXPORT_TABLES = [
  "venues",
  "levels",
  "spaces",
  "nodes",
  "edges",
  "pois",
  "anchors",
] as const satisfies readonly (keyof HeadExport)[];

/** A HEAD table in an export. */
export type HeadExportTable = (typeof HEAD_EXPORT_TABLES)[number];

/** The geometry columns of each table's row. */
const GEOMETRY_COLUMNS: Record<HeadExportTable, readonly string[]> = {
  venues: ["footprint"],
  levels: [],
  spaces: ["geom"],
  nodes: ["geom"],
  edges: ["geom"],
  pois: ["geom"],
  anchors: ["surveyed_geom"],
};

/**
 * The export's key in the private exports bucket: `head/<version>/<uuid>.json`. Never derived from
 * `snapshot_sha256`, which two versions can share; `uuid` is made for each publish, so keys stay
 * unique when version numbers repeat (a recreated local database).
 */
export function headExportKey(version: number, uuid: string): string {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error(`Not a version: ${version}`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
    throw new Error(`Not a lowercase UUID: ${uuid}`);
  }
  return `head/${version}/${uuid}.json`;
}

/**
 * Checks a schema-valid export for what its schema can't: each table's entries sorted by id with
 * no id twice, and the coordinate rules. Returns the problems; none means valid.
 */
export function checkHeadExport(document: HeadExport): string[] {
  const problems = new ProblemList();
  for (const table of HEAD_EXPORT_TABLES) {
    let previous: string | undefined;
    document[table].forEach((entry, i) => {
      const at = `${table}[${i}]`;
      if (previous !== undefined && !(previous < entry.id)) {
        problems.add(
          previous === entry.id
            ? `${at}: id ${entry.id} is listed twice`
            : `${at}: entries are not sorted by id`,
        );
      }
      previous = entry.id;
      const row = entry.row as unknown as Record<string, unknown>;
      for (const column of GEOMETRY_COLUMNS[table]) {
        checkGeometry((row[column] ?? null) as Geometry | null, `${at}.row.${column}`, problems);
      }
    });
  }
  return problems.messages;
}
