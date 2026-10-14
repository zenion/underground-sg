// @usg/contracts/validators: validates the public map files (docs/snapshot-format.md) and
// change-set diffs (docs/diff-format.md): the schema, then the checks the schema can't express.
// Node only: it uses Ajv and node:crypto, so it is kept out of the environment-neutral `.` entry.
// The snapshot builder validates what it writes, and processing and the API validate every diff.

import { createHash } from "node:crypto";
import type { ValidateFunction } from "ajv/dist/2020.js";
import { createAjv, describeSchemaError } from "./bundle-validator/schemas.ts";
import { CHANGE_SET_DIFF_SCHEMA_FILE, checkChangeSetDiff, DIFF_SCHEMA_BASE_URL } from "./diff.ts";
import type {
  ChangeSetDiff,
  IndoorSnapshot,
  LatestPointer,
  StatusOverlay,
  StreetSnapshot,
} from "./generated/contracts.ts";
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
