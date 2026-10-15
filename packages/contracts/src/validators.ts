// @usg/contracts/validators: validates the public map files (docs/snapshot-format.md),
// change-set diffs (docs/diff-format.md), the private full export (docs/head-export-format.md) and
// the API's response bodies: the schema, then the checks the schema can't express. Node only: it uses Ajv, node:crypto and node:fs, so it is kept out of
// the environment-neutral `.` entry. The snapshot builder validates what it writes, processing and
// the API validate every diff, and the API checks its responses.

import { createHash } from "node:crypto";
import type { ValidateFunction } from "ajv/dist/2020.js";
import { API_SCHEMA_BASE_URL, API_SCHEMA_FILES, type ApiDocumentName } from "./api.ts";
import { createAjv, describeSchemaError } from "./bundle-validator/schemas.ts";
import { CHANGE_SET_DIFF_SCHEMA_FILE, checkChangeSetDiff, DIFF_SCHEMA_BASE_URL } from "./diff.ts";
import { checkHeadExport, EXPORT_SCHEMA_BASE_URL, HEAD_EXPORT_SCHEMA_FILE } from "./export.ts";
import type {
  ChangeSetDiff,
  HeadExport,
  IndoorSnapshot,
  LatestPointer,
  StatusOverlay,
  StreetSnapshot,
} from "./generated/contracts.ts";
import { readSchema } from "./schema-files.ts";
import { SCHEMA_BASE_URL } from "./schema-ids.ts";
import {
  checkIndoorSnapshot,
  checkLatestPointer,
  checkStatusOverlay,
  checkStreetConnectors,
  checkStreetSnapshot,
  isIndoorFeature,
  SNAPSHOT_SCHEMA_BASE_URL,
  SNAPSHOT_SCHEMA_FILES,
  type SnapshotFileName,
  STREET_CONNECTOR_ID_NAMESPACE,
  snapshotDigestInput,
  VERSION_FILES,
  type VersionFileName,
} from "./snapshot.ts";

/** The outcome of a validation: `problems` is empty exactly when `valid` is true. */
export interface ValidationResult {
  readonly valid: boolean;
  readonly problems: readonly string[];
}

let ajv: ReturnType<typeof createAjv> | undefined;
const validators = new Map<string, ValidateFunction>();

function validatorForId(id: string): ValidateFunction {
  let validate = validators.get(id);
  if (validate === undefined) {
    ajv ??= createAjv();
    validate = ajv.getSchema(id);
    if (validate === undefined) throw new Error(`No schema with $id ${id}`);
    validators.set(id, validate);
  }
  return validate;
}

/** The compiled schema validator for a public map file. */
export function snapshotValidator(file: SnapshotFileName): ValidateFunction {
  return validatorForId(`${SNAPSHOT_SCHEMA_BASE_URL}${SNAPSHOT_SCHEMA_FILES[file]}`);
}

/** The compiled schema validator for `change_sets.diff`. */
export function changeSetDiffValidator(): ValidateFunction {
  return validatorForId(`${DIFF_SCHEMA_BASE_URL}${CHANGE_SET_DIFF_SCHEMA_FILE}`);
}

/** The compiled schema validator for the private full export of HEAD. */
export function headExportValidator(): ValidateFunction {
  return validatorForId(`${EXPORT_SCHEMA_BASE_URL}${HEAD_EXPORT_SCHEMA_FILE}`);
}

/** The compiled schema validator for an API response body. */
export function apiValidator(name: ApiDocumentName): ValidateFunction {
  return validatorForId(`${API_SCHEMA_BASE_URL}${API_SCHEMA_FILES[name]}`);
}

/** Validates an API response body against its schema. */
export function validateApiDocument(name: ApiDocumentName, document: unknown): ValidationResult {
  const validate = apiValidator(name);
  return result(validate(document) ? [] : schemaProblems(validate));
}

export { createAjv, describeSchemaError };

/** JSON Schema keywords whose values are data, not schemas: inlining leaves them as they are. */
const DATA_KEYWORDS = new Set(["const", "enum", "required"]);

/**
 * A schema file with every `$ref` replaced by what it points at, and `$schema`, `$id` and `$defs`
 * dropped: one self-contained schema, for tools that can't resolve this package's `$id`s, such as
 * Fastify route schemas and the OpenAPI document @fastify/swagger builds from them. `path` is the
 * file's path under `schemas/` (for example `api/health.schema.json`). Validation keeps using the
 * files themselves (`apiValidator` and the rest); the inlined schema accepts the same documents.
 */
export function inlineSchema(path: string): Record<string, unknown> {
  return inlineValue(readSchema(path), `${SCHEMA_BASE_URL}${path}`, []) as Record<string, unknown>;
}

function inlineValue(value: unknown, base: string, refs: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => inlineValue(item, base, refs));
  if (value === null || typeof value !== "object") return value;
  const schema = value as Record<string, unknown>;
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    const target = new URL(ref, base);
    if (refs.includes(target.href)) throw new Error(`Recursive $ref ${target.href}`);
    const file = `${target.origin}${target.pathname}`;
    if (!file.startsWith(SCHEMA_BASE_URL)) throw new Error(`$ref outside this package: ${ref}`);
    const resolved = resolvePointer(readSchema(file.slice(SCHEMA_BASE_URL.length)), target.hash);
    return inlineValue(resolved, file, [...refs, target.href]);
  }
  const inlined: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(schema)) {
    if (key === "$schema" || key === "$id" || key === "$defs") continue;
    if (DATA_KEYWORDS.has(key)) {
      inlined[key] = child;
    } else if (key === "properties") {
      inlined[key] = Object.fromEntries(
        Object.entries(child as Record<string, unknown>).map(([name, property]) => [
          name,
          inlineValue(property, base, refs),
        ]),
      );
    } else {
      inlined[key] = inlineValue(child, base, refs);
    }
  }
  return inlined;
}

/** The part of a schema a URL fragment (`#/$defs/uuid`, or empty for the whole) points at. */
function resolvePointer(schema: Record<string, unknown>, fragment: string): unknown {
  const pointer = decodeURIComponent(fragment.replace(/^#/, ""));
  if (pointer === "") return schema;
  if (!pointer.startsWith("/")) throw new Error(`Unsupported $ref fragment #${pointer}`);
  let current: unknown = schema;
  for (const token of pointer.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) {
      throw new Error(`$ref fragment #${pointer} points at nothing`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function result(problems: readonly string[]): ValidationResult {
  return { valid: problems.length === 0, problems };
}

function schemaProblems(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map(describeSchemaError);
}

/**
 * Validates a public map file, parsed: its schema, then the checks in `checkIndoorSnapshot` (plus
 * street connectors' ids, which need SHA-1), `checkStreetSnapshot`, `checkLatestPointer` or
 * `checkStatusOverlay`. A version's two files also need `validateVersion`, which checks them
 * against each other.
 */
export function validateSnapshotFile(file: SnapshotFileName, document: unknown): ValidationResult {
  const validate = snapshotValidator(file);
  if (!validate(document)) return result(schemaProblems(validate));
  switch (file) {
    case "indoor.json":
      return result([
        ...checkIndoorSnapshot(document as IndoorSnapshot),
        ...checkStreetConnectorIds(document as IndoorSnapshot),
      ]);
    case "street.json":
      return result(checkStreetSnapshot(document as StreetSnapshot));
    case "latest.json":
      return result(checkLatestPointer(document as LatestPointer));
    case "status.json":
      return result(checkStatusOverlay(document as StatusOverlay));
  }
}

/**
 * Validates a version's two files, parsed, as the snapshot builder must before it uploads them:
 * each file with `validateSnapshotFile`, then, when both are valid, `checkStreetConnectors` (every
 * street connector ends at a street node in street.json). Each problem starts with its file's
 * name.
 */
export function validateVersion(indoor: unknown, street: unknown): ValidationResult {
  const indoorResult = validateSnapshotFile("indoor.json", indoor);
  const streetResult = validateSnapshotFile("street.json", street);
  const problems = [
    ...indoorResult.problems.map((problem) => `indoor.json: ${problem}`),
    ...streetResult.problems.map((problem) => `street.json: ${problem}`),
  ];
  if (indoorResult.valid && streetResult.valid) {
    problems.push(
      ...checkStreetConnectors(indoor as IndoorSnapshot, street as StreetSnapshot).map(
        (problem) => `indoor.json: ${problem}`,
      ),
    );
  }
  return result(problems);
}

/** Validates a change set's diff, parsed: its schema, then `checkChangeSetDiff`. */
export function validateChangeSetDiff(
  document: unknown,
  track: "structural" | "status",
): ValidationResult {
  const validate = changeSetDiffValidator();
  if (!validate(document)) return result(schemaProblems(validate));
  return result(checkChangeSetDiff(document as ChangeSetDiff, track));
}

/** Validates a private full export of HEAD, parsed: its schema, then `checkHeadExport`. */
export function validateHeadExport(document: unknown): ValidationResult {
  const validate = headExportValidator();
  if (!validate(document)) return result(schemaProblems(validate));
  return result(checkHeadExport(document as HeadExport));
}

/**
 * A name-based UUID, version 5 (RFC 9562, section 5.5): the SHA-1 of the namespace's 16 bytes and
 * the name as UTF-8, with the version and variant bits set. Lowercase.
 */
export function uuidV5(namespace: string, name: string): string {
  const namespaceHex = namespace.replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/.test(namespaceHex)) throw new Error(`Not a UUID: ${namespace}`);
  const hash = createHash("sha1")
    .update(Buffer.from(namespaceHex, "hex"))
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The id of a street connector in indoor.json: the UUIDv5 of its node's id, as lowercase text, in
 * `STREET_CONNECTOR_ID_NAMESPACE` (docs/snapshot-format.md). The snapshot builder writes it, since
 * `street_connectors` is keyed by `node_id` and has no id of its own.
 */
export function streetConnectorId(nodeId: string): string {
  return uuidV5(STREET_CONNECTOR_ID_NAMESPACE, nodeId.toLowerCase());
}

/** Checks that each street connector's id is `streetConnectorId` of its node. */
function checkStreetConnectorIds(snapshot: IndoorSnapshot): string[] {
  const problems: string[] = [];
  snapshot.features.forEach((feature, i) => {
    if (!isIndoorFeature(feature, "street_connector")) return;
    const expected = streetConnectorId(feature.properties.node_id);
    if (feature.id !== expected) {
      problems.push(
        `features[${i}]: a street connector's id is ${expected}, derived from its node_id`,
      );
    }
  });
  return problems;
}

/** SHA-256 as 64 lowercase hex digits. A string is hashed as UTF-8. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * `snapshot_sha256` of a version from its files' bytes as decoded: the SHA-256 of
 * `snapshotDigestInput`, so `sha256sum --text indoor.json street.json | sha256sum` agrees.
 */
export function snapshotSha256(
  files: Readonly<Record<VersionFileName, string | Uint8Array>>,
): string {
  return sha256Hex(
    snapshotDigestInput({
      "indoor.json": sha256Hex(files["indoor.json"]),
      "street.json": sha256Hex(files["street.json"]),
    }),
  );
}

/**
 * Checks latest.json against the version files it points at, given their bytes as decoded:
 * each file's `bytes` and `sha256`, and `snapshot_sha256`. Returns the problems; none means they
 * match.
 */
export function verifyLatestPointer(
  latest: LatestPointer,
  files: Readonly<Record<VersionFileName, Uint8Array>>,
): string[] {
  const problems: string[] = [];
  const keys = { "indoor.json": "indoor", "street.json": "street" } as const;
  for (const file of VERSION_FILES) {
    const listed = latest.files[keys[file]];
    const bytes = files[file];
    if (listed.bytes !== bytes.byteLength) {
      problems.push(
        `files.${keys[file]}.bytes is ${listed.bytes}; ${file} has ${bytes.byteLength}`,
      );
    }
    if (listed.sha256 !== sha256Hex(bytes)) {
      problems.push(`files.${keys[file]}.sha256 does not match ${file}`);
    }
  }
  if (latest.snapshot_sha256 !== snapshotSha256(files)) {
    problems.push("snapshot_sha256 does not match the files");
  }
  return problems;
}
