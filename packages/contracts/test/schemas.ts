// Test helpers: the schema files and the validator's Ajv setup (Node only).

export { createAjv, validatorFor } from "../src/bundle-validator/schemas.ts";
export {
  ALL_CAPTURE_BUNDLE_SCHEMA_FILES,
  ALL_SCHEMA_FILES,
  readCaptureBundleSchema,
  readSchema,
  SCHEMAS_DIR,
  type SchemaObject,
} from "../src/schema-files.ts";

import type { SchemaObject } from "../src/schema-files.ts";

/** Calls `visit` on every subschema of `schema`, with a JSON-pointer-like location. */
export function walkSchema(
  schema: SchemaObject,
  at: string,
  visit: (s: SchemaObject, at: string) => void,
): void {
  visit(schema, at);
  for (const key of ["properties", "$defs"]) {
    const children = schema[key] as Record<string, SchemaObject> | undefined;
    for (const [name, child] of Object.entries(children ?? {})) {
      walkSchema(child, `${at}/${key}/${name}`, visit);
    }
  }
  if (typeof schema["items"] === "object") {
    walkSchema(schema["items"] as SchemaObject, `${at}/items`, visit);
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const children = schema[key] as SchemaObject[] | undefined;
    children?.forEach((child, i) => {
      walkSchema(child, `${at}/${key}/${i}`, visit);
    });
  }
}
