// Ajv for the capture bundle schemas (Node only). The validators are compiled once per process,
// on first use.

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import {
  CAPTURE_BUNDLE_SCHEMA_BASE_URL,
  CAPTURE_BUNDLE_SCHEMA_FILES,
  type CaptureBundleJsonPath,
} from "../capture-bundle.ts";
import { ALL_CAPTURE_BUNDLE_SCHEMA_FILES, readCaptureBundleSchema } from "../schema-files.ts";
import { displayPath } from "./report.ts";

const addFormats = addFormatsModule.default;

export interface AjvOptions {
  /**
   * Collect every error instead of stopping at the first. Off for validation: with it on, Ajv
   * copies its error list for each failing `$ref`, so time and memory grow with the square of
   * the invalid array items, and a hostile file of about 1 MiB stalls the validator. The report
   * keeps only a few schema errors per document anyway.
   */
  readonly allErrors?: boolean;
}

/**
 * Ajv for JSON Schema 2020-12 in strict mode, with `format` asserted (ajv-formats) and every
 * capture bundle schema added. Nothing is fetched: the `$id`s are identifiers only.
 */
export function createAjv(options: AjvOptions = {}): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: options.allErrors ?? false });
  addFormats(ajv);
  for (const file of ALL_CAPTURE_BUNDLE_SCHEMA_FILES) ajv.addSchema(readCaptureBundleSchema(file));
  return ajv;
}

let validators: Map<CaptureBundleJsonPath, ValidateFunction> | undefined;

/** The compiled validator for a bundle file (for a .jsonl file, for one line). */
export function validatorFor(bundlePath: CaptureBundleJsonPath): ValidateFunction {
  if (validators === undefined) {
    const ajv = createAjv();
    validators = new Map();
    for (const [path, file] of Object.entries(CAPTURE_BUNDLE_SCHEMA_FILES)) {
      const validate = ajv.getSchema(`${CAPTURE_BUNDLE_SCHEMA_BASE_URL}${file}`);
      if (validate === undefined) throw new Error(`No schema with $id ending ${file}`);
      validators.set(path as CaptureBundleJsonPath, validate);
    }
  }
  const validate = validators.get(bundlePath);
  if (validate === undefined) throw new Error(`No schema for ${bundlePath}`);
  return validate;
}

/**
 * One Ajv error as a message: where in the document, and what is wrong. Uses only the schema
 * side of the error (paths, keywords, property names), never the data, which may be personal.
 * An unknown field's name does come from the data, so it is escaped and cut short.
 */
export function describeSchemaError(error: ErrorObject): string {
  const at = error.instancePath === "" ? "the document" : displayPath(error.instancePath);
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "additionalProperties":
      return `${at} has an unknown field "${displayPath(String(params["additionalProperty"]))}"`;
    case "required":
      return `${at} is missing the field ${JSON.stringify(params["missingProperty"])}`;
    case "enum":
      return `${at} must be one of ${JSON.stringify(params["allowedValues"])}`;
    case "const":
      return `${at} must be ${JSON.stringify(params["allowedValue"])}`;
    default:
      return `${at} ${error.message ?? `fails ${error.keyword}`}`;
  }
}
