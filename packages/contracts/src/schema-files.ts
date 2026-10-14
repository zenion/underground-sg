// The capture bundle schema files on disk (Node only, no Ajv): the one list of files and the one
// reader that the code generator (scripts/codegen.ts) and the bundle validator's Ajv setup
// (src/bundle-validator/schemas.ts) share. Not part of the environment-neutral `.` entry.

import { readFileSync } from "node:fs";
import { CAPTURE_BUNDLE_DEFS_SCHEMA_FILE, CAPTURE_BUNDLE_SCHEMA_FILES } from "./capture-bundle.ts";

/** The directory holding the capture bundle schema files. */
export const CAPTURE_BUNDLE_SCHEMA_DIR = new URL("../schemas/capture-bundle/", import.meta.url);

/** Every capture bundle schema file: the shared definitions, then one per bundle file. */
export const ALL_CAPTURE_BUNDLE_SCHEMA_FILES: readonly string[] = [
  CAPTURE_BUNDLE_DEFS_SCHEMA_FILE,
  ...Object.values(CAPTURE_BUNDLE_SCHEMA_FILES),
];

export type SchemaObject = Record<string, unknown>;

/** The text of a capture bundle schema file; only the files in the list above can be read. */
export function readCaptureBundleSchemaText(file: string): string {
  if (!ALL_CAPTURE_BUNDLE_SCHEMA_FILES.includes(file)) {
    throw new Error(`${file} is not a capture bundle schema file`);
  }
  return readFileSync(new URL(file, CAPTURE_BUNDLE_SCHEMA_DIR), "utf8");
}

/** A capture bundle schema file, parsed. */
export function readCaptureBundleSchema(file: string): SchemaObject {
  return JSON.parse(readCaptureBundleSchemaText(file)) as SchemaObject;
}
