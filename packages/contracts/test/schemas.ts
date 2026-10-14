// Test helpers: the schema files and the validator's Ajv setup (Node only).

export { createAjv, validatorFor } from "../src/bundle-validator/schemas.ts";
export {
  ALL_CAPTURE_BUNDLE_SCHEMA_FILES as ALL_SCHEMA_FILES,
  CAPTURE_BUNDLE_SCHEMA_DIR as SCHEMA_DIR,
  readCaptureBundleSchema as readSchema,
  type SchemaObject,
} from "../src/schema-files.ts";
