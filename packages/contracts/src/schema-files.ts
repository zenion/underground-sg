// The schema files on disk (Node only, no Ajv): the one list of files and the one reader that the
// code generator (scripts/codegen.ts) and the Ajv setup (src/bundle-validator/schemas.ts) share.
// Not part of the environment-neutral `.` entry.

import { readFileSync } from "node:fs";
import { API_SCHEMA_FILES } from "./api.ts";
import { CAPTURE_BUNDLE_DEFS_SCHEMA_FILE, CAPTURE_BUNDLE_SCHEMA_FILES } from "./capture-bundle.ts";
import { CHANGE_SET_DIFF_SCHEMA_FILE } from "./diff.ts";
import { HEAD_EXPORT_SCHEMA_FILE } from "./export.ts";
import { MAP_DEFS_SCHEMA_FILE } from "./map.ts";
import { SNAPSHOT_SCHEMA_FILES } from "./snapshot.ts";

/** The `schemas/` directory. */
export const SCHEMAS_DIR = new URL("../schemas/", import.meta.url);

/** The directory holding the capture bundle schema files. */
export const CAPTURE_BUNDLE_SCHEMA_DIR = new URL("capture-bundle/", SCHEMAS_DIR);

/** Every capture bundle schema file: the shared definitions, then one per bundle file. */
export const ALL_CAPTURE_BUNDLE_SCHEMA_FILES: readonly string[] = [
  CAPTURE_BUNDLE_DEFS_SCHEMA_FILE,
  ...Object.values(CAPTURE_BUNDLE_SCHEMA_FILES),
];

/**
 * Every schema file, as its path under `schemas/` (which is also its `$id` after
 * `SCHEMA_BASE_URL`): the capture bundle's, the shared map definitions, the snapshot files', the
 * change-set diff's, the API's and the private full export's.
 */
export const ALL_SCHEMA_FILES: readonly string[] = [
  ...ALL_CAPTURE_BUNDLE_SCHEMA_FILES.map((file) => `capture-bundle/${file}`),
  `map/${MAP_DEFS_SCHEMA_FILE}`,
  ...Object.values(SNAPSHOT_SCHEMA_FILES).map((file) => `snapshot/${file}`),
  `diff/${CHANGE_SET_DIFF_SCHEMA_FILE}`,
  ...Object.values(API_SCHEMA_FILES).map((file) => `api/${file}`),
  `export/${HEAD_EXPORT_SCHEMA_FILE}`,
];

export type SchemaObject = Record<string, unknown>;

/** The text of a schema file, by its path under `schemas/`; only listed files can be read. */
export function readSchemaText(path: string): string {
  if (!ALL_SCHEMA_FILES.includes(path)) throw new Error(`${path} is not a schema file`);
  return readFileSync(new URL(path, SCHEMAS_DIR), "utf8");
}

/** A schema file, parsed, by its path under `schemas/`. */
export function readSchema(path: string): SchemaObject {
  return JSON.parse(readSchemaText(path)) as SchemaObject;
}

/** The text of a capture bundle schema file, by its name in `schemas/capture-bundle/`. */
export function readCaptureBundleSchemaText(file: string): string {
  if (!ALL_CAPTURE_BUNDLE_SCHEMA_FILES.includes(file)) {
    throw new Error(`${file} is not a capture bundle schema file`);
  }
  return readSchemaText(`capture-bundle/${file}`);
}

/** A capture bundle schema file, parsed. */
export function readCaptureBundleSchema(file: string): SchemaObject {
  return JSON.parse(readCaptureBundleSchemaText(file)) as SchemaObject;
}
