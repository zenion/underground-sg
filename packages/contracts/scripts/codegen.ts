// Code generation from the JSON Schemas: TypeScript types (json-schema-to-typescript) for every
// document, and Swift Codable types (quicktype) for the documents that opt in, which are the
// capture bundle's and the session recording's. `scripts/gen.ts` writes the output into the package; the tests generate into
// a temporary directory and compare, so stale generated code fails locally too.
//
// The output must be identical on Windows and Linux: inputs come from a fixed list (never from
// directory listing order), schemas are read from disk only (`$id`s are never fetched), line
// endings are LF, and nothing machine-specific (paths, times, versions) goes into the output.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, type JSONSchema } from "json-schema-to-typescript";
import { InputData, JSONSchemaInput, JSONSchemaStore, quicktype } from "quicktype-core";
import { API_SCHEMA_FILES } from "../src/api.ts";
import { CAPTURE_BUNDLE_SCHEMA_FILES } from "../src/capture-bundle.ts";
import { CHANGE_SET_DIFF_SCHEMA_FILE } from "../src/diff.ts";
import { HEAD_EXPORT_SCHEMA_FILE } from "../src/export.ts";
import {
  RECORDING_SCHEMA_FILES,
  RECORDING_SET_SCHEMA_FILES,
  RECORDING_SWIFT_FILES,
} from "../src/recording.ts";
import {
  ALL_SCHEMA_FILES,
  readSchema,
  readSchemaText,
  type SchemaObject,
} from "../src/schema-files.ts";
import { SCHEMA_BASE_URL } from "../src/schema-ids.ts";
import { SNAPSHOT_SCHEMA_FILES } from "../src/snapshot.ts";

/** The package directory (packages/contracts). */
export const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

/** The repo root: the generated files' paths are relative to it. */
export const REPO_DIR = fileURLToPath(new URL("../../..", import.meta.url));

/** Output files, relative to the repo root, with / separators. */
export const GENERATED_TS_FILE = "packages/contracts/src/generated/contracts.ts";
/**
 * In the capture module's CaptureCore target, which compiles it: SwiftPM and CocoaPods compile
 * only sources under the module's own directory. Its types are internal to CaptureCore.
 */
export const GENERATED_SWIFT_FILE =
  "apps/mapper/modules/capture-native/Sources/CaptureCore/generated/Contracts.swift";

/** Directories that hold only generated files; anything else in them is deleted. */
export const GENERATED_DIRS = [
  "packages/contracts/src/generated",
  "apps/mapper/modules/capture-native/Sources/CaptureCore/generated",
] as const;

export interface GeneratedFile {
  /** Path relative to the repo root, with / separators. */
  path: string;
  content: string;
}

/** A document the generator writes types for. */
export interface SchemaDocument {
  /** The document's name in its group, for example manifest.json or indoor.json. */
  readonly name: string;
  /** Its schema's path under schemas/. */
  readonly schema: string;
  /**
   * Whether quicktype writes Swift types for it into Contracts.swift. Only documents that Swift
   * code writes or reads opt in; the others get TypeScript types only. A schema two groups share
   * opts in once.
   */
  readonly swift: boolean;
}

/** A family of documents: one type map in the TypeScript output, keyed by document name. */
export interface DocumentGroup {
  /** The group's key in `ContractDocuments`. */
  readonly key: string;
  /** The title of its type map, which becomes the TypeScript interface's name. */
  readonly title: string;
  readonly description: string;
  readonly documents: readonly SchemaDocument[];
}

/** Every document, by group. The order is fixed so the output is too. */
export const DOCUMENT_GROUPS: readonly DocumentGroup[] = [
  {
    key: "capture-bundle",
    title: "CaptureBundleDocuments",
    description:
      "The type of each JSON file in a capture bundle, keyed by its path in the bundle directory; for a .jsonl file, the type of one line. A type map only: no file has this shape.",
    documents: Object.entries(CAPTURE_BUNDLE_SCHEMA_FILES).map(([name, file]) => ({
      name,
      schema: `capture-bundle/${file}`,
      swift: true,
    })),
  },
  {
    key: "snapshot",
    title: "SnapshotDocuments",
    description:
      "The type of each public map file (docs/snapshot-format.md), keyed by its file name. A type map only: no file has this shape.",
    documents: Object.entries(SNAPSHOT_SCHEMA_FILES).map(([name, file]) => ({
      name,
      schema: `snapshot/${file}`,
      swift: false,
    })),
  },
  {
    key: "diff",
    title: "DiffDocuments",
    description:
      "The type of a change set's diff, change_sets.diff (docs/diff-format.md). A type map only: no file has this shape.",
    documents: [
      { name: "change_sets.diff", schema: `diff/${CHANGE_SET_DIFF_SCHEMA_FILE}`, swift: false },
    ],
  },
  {
    key: "api",
    title: "ApiDocuments",
    description:
      "The type of each services/api response body (services/api/README.md), keyed by the route it answers; error is the body of every 4xx and 5xx response. A type map only: no file has this shape.",
    documents: Object.entries(API_SCHEMA_FILES).map(([name, file]) => ({
      name,
      schema: `api/${file}`,
      swift: false,
    })),
  },
  {
    key: "export",
    title: "ExportDocuments",
    description:
      "The type of the private full export of HEAD (docs/head-export-format.md), keyed by its name. A type map only: no file has this shape.",
    documents: [
      { name: "head-export.json", schema: `export/${HEAD_EXPORT_SCHEMA_FILE}`, swift: false },
    ],
  },
  {
    key: "recording",
    title: "RecordingDocuments",
    description:
      "The type of each JSON file in a session recording (docs/session-recording.md), keyed by its path in rec-<recording_id>/ (for a .jsonl file, the type of one line), and of an export's parts.json and an imported set's import.json. A type map only: no file has this shape.",
    documents: [
      ...Object.entries(RECORDING_SCHEMA_FILES),
      ...Object.entries(RECORDING_SET_SCHEMA_FILES),
    ].map(([name, schema]) => ({
      name,
      schema,
      // The lines reused from the capture bundle already get Swift types there.
      swift:
        schema.startsWith("recording/") &&
        (RECORDING_SWIFT_FILES as readonly string[]).includes(name),
    })),
  },
];

/** Maps a schema `$id` (or a URL relative to one) to a schema file in this package. */
function schemaFileForUrl(url: string): string | undefined {
  const withoutFragment = url.split("#")[0] ?? "";
  if (!withoutFragment.startsWith(SCHEMA_BASE_URL)) return undefined;
  const file = withoutFragment.slice(SCHEMA_BASE_URL.length);
  return ALL_SCHEMA_FILES.includes(file) ? file : undefined;
}

function requireSchemaFileForUrl(url: string): string {
  const file = schemaFileForUrl(url);
  if (file === undefined) throw new Error(`No schema in this package has the $id ${url}`);
  return file;
}

function normalise(text: string): string {
  return `${text.replace(/\r\n?/g, "\n").trimEnd()}\n`;
}

const TS_HEADER_LINES = [
  "Generated by packages/contracts/scripts/gen.ts from packages/contracts/schemas/.",
  "Do not edit: change the schemas (after their docs in docs/) and run `pnpm gen`.",
];

// The Swift output covers the capture bundle's documents and the recording's that Swift writes.
const SWIFT_HEADER_LINES = [
  "Generated by packages/contracts/scripts/gen.ts from packages/contracts/schemas/capture-bundle/",
  "and schemas/recording/. Do not edit: change the schemas (after docs/capture-bundle.md or",
  "docs/session-recording.md) and run `pnpm gen`.",
];

/**
 * TypeScript: one file for every document's types, so each shared type (such as `Uuid`) is
 * declared once. It is compiled from an in-memory root schema whose properties are the groups'
 * type maps.
 */
async function generateTypeScript(): Promise<string> {
  const root = {
    $id: `${SCHEMA_BASE_URL}contract-documents`,
    title: "ContractDocuments",
    description:
      "Every document type in @usg/contracts, by group and document name. A type map only: no file has this shape.",
    type: "object",
    properties: Object.fromEntries(
      DOCUMENT_GROUPS.map((group) => [
        group.key,
        {
          title: group.title,
          description: group.description,
          type: "object",
          properties: Object.fromEntries(
            group.documents.map((document) => [document.name, { $ref: document.schema }]),
          ),
          required: group.documents.map((document) => document.name),
          additionalProperties: false,
        },
      ]),
    ),
    required: DOCUMENT_GROUPS.map((group) => group.key),
    additionalProperties: false,
  };

  const ts = await compile(root as JSONSchema, "ContractDocuments", {
    bannerComment: TS_HEADER_LINES.map((line) => `// ${line}`).join("\n"),
    // Relative $refs resolve against the $id base, and the resolver below reads the files.
    cwd: SCHEMA_BASE_URL,
    $refOptions: {
      resolve: {
        file: false,
        http: false,
        contracts: {
          order: 1,
          canRead: (file: { url: string }) => schemaFileForUrl(file.url) !== undefined,
          read: (file: { url: string }) => readSchemaText(requireSchemaFileForUrl(file.url)),
        },
      },
    },
    additionalProperties: false,
    strictIndexSignatures: true,
    unknownAny: true,
    style: {
      printWidth: 100,
      tabWidth: 2,
      useTabs: false,
      semi: true,
      singleQuote: false,
      trailingComma: "all",
      bracketSpacing: true,
      endOfLine: "lf",
    },
  });
  return normalise(ts);
}

/**
 * The Swift view of a schema: date-times stay `String`. quicktype would make them `Date`, which
 * JSONEncoder writes in UTC and JSONDecoder's `.iso8601` can't read with fractional seconds, so
 * the exact text would not round-trip. Validation is unaffected: Ajv reads the files as they are.
 */
function swiftView(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(swiftView);
  if (value === null || typeof value !== "object") return value;
  const result: SchemaObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "format" && child === "date-time") continue;
    result[key] = swiftView(child);
  }
  return result;
}

/** Serves this package's schema files to quicktype by `$id`; nothing is fetched. */
class PackageSchemaStore extends JSONSchemaStore {
  async fetch(address: string): Promise<SchemaObject | undefined> {
    return swiftView(readSchema(requireSchemaFileForUrl(address))) as SchemaObject;
  }
}

/** The documents that get Swift types, in group order. */
export const SWIFT_DOCUMENTS: readonly SchemaDocument[] = DOCUMENT_GROUPS.flatMap((group) =>
  group.documents.filter((document) => document.swift),
);

/** Swift: one file of Codable types for the Swift capture module. */
async function generateSwift(): Promise<string> {
  const schemaInput = new JSONSchemaInput(new PackageSchemaStore());
  for (const document of SWIFT_DOCUMENTS) {
    await schemaInput.addSource({
      name: String(readSchema(document.schema)["title"]),
      uris: [`${SCHEMA_BASE_URL}${document.schema}`],
    });
  }
  const inputData = new InputData();
  inputData.addInput(schemaInput);

  const result = await quicktype({
    inputData,
    lang: "swift",
    // An empty list stops the Swift renderer repeating a header before every type; the file
    // header is added below instead.
    leadingComments: [],
    rendererOptions: {
      // Codable structs with CodingKeys and raw-valued enums, without the convenience
      // initializers, mutators and JSON helpers.
      "just-types": "false",
      initializers: "false",
      sendable: "true",
      protocol: "equatable",
    },
  });

  // Replace quicktype's own header (a usage example) with ours, and drop its `// MARK: - Name`
  // lines: quicktype puts them between a type's `///` doc comment and its declaration, and Swift
  // discards a doc comment that an ordinary comment separates from the declaration.
  const lines = result.lines
    .map((line) => line.trimEnd())
    .filter((line) => !line.startsWith("// MARK: - "));
  const firstCode = lines.findIndex((line) => line !== "" && !line.startsWith("//"));
  if (lines[firstCode] !== "import Foundation") {
    throw new Error("Unexpected quicktype output: expected its header, then import Foundation");
  }
  const header = SWIFT_HEADER_LINES.map((line) => `// ${line}`);
  const code = lines.slice(firstCode);
  return normalise([...header, "", ...code, ...nullEncoders(code)].join("\n"));
}

/**
 * Every titled object schema in the package, and every titled union of them (`oneOf`), by title:
 * quicktype names its struct after it.
 */
function titledObjectSchemas(): Map<string, SchemaObject> {
  const found = new Map<string, SchemaObject>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value !== null && typeof value === "object") {
      const schema = value as SchemaObject;
      if (typeof schema["title"] === "string" && (schema["type"] === "object" || schema["oneOf"])) {
        found.set(schema["title"], schema);
      }
      for (const child of Object.values(schema)) visit(child);
    }
  };
  for (const file of ALL_SCHEMA_FILES) visit(readSchema(file));
  return found;
}

/**
 * `encode(to:)` for each struct with a field that is required but may be null. Synthesized
 * `Encodable` leaves a nil optional out (`encodeIfPresent`), which the schemas reject for a
 * required field, so these write it with `encode`, which writes null. A field that isn't required
 * stays left out when nil. Parses quicktype's output: `let` lines and the `CodingKeys` cases.
 */
function nullEncoders(code: readonly string[]): string[] {
  const schemas = titledObjectSchemas();
  const out: string[] = [];
  let struct: { name: string; fields: { name: string; optional: boolean }[] } | undefined;
  let keys = new Map<string, string>();
  for (const line of code) {
    const start = /^struct (\w+): Codable/.exec(line);
    if (start?.[1]) {
      struct = { name: start[1], fields: [] };
      keys = new Map();
      continue;
    }
    if (!struct) continue;
    const field = /^ {4}let (\w+): (.+)$/.exec(line);
    if (field?.[1] && field[2]) {
      struct.fields.push({ name: field[1], optional: field[2].endsWith("?") });
    }
    const key = /^ {8}case (\w+) = "([^"]+)"$/.exec(line);
    if (key?.[1] && key[2]) keys.set(key[1], key[2]);
    if (line !== "}") continue;

    const { name, fields } = struct;
    const schema = schemas.get(name);
    if (!schema) throw new Error(`No titled object schema for the Swift struct ${name}`);
    // A union's branches are merged into one struct (CaptureTag, which TypeScript writes): the
    // synthesized encoder stays, since a field required in one branch may be absent in the other.
    if (schema["oneOf"]) {
      struct = undefined;
      continue;
    }
    const required = new Set((schema["required"] as string[] | undefined) ?? []);
    const isRequired = (field: string): boolean => {
      const json = keys.get(field);
      if (json === undefined) throw new Error(`${name}.${field} has no CodingKeys case`);
      return required.has(json);
    };
    if (fields.some((f) => f.optional && isRequired(f.name))) {
      out.push(
        "",
        `extension ${name} {`,
        "    /// Writes null for a required field that is nil, as the schema requires; leaves out a",
        "    /// field the schema doesn't require when it is nil.",
        "    func encode(to encoder: Encoder) throws {",
        "        var container = encoder.container(keyedBy: CodingKeys.self)",
        ...fields.map((f) =>
          f.optional && !isRequired(f.name)
            ? `        try container.encodeIfPresent(${f.name}, forKey: .${f.name})`
            : `        try container.encode(${f.name}, forKey: .${f.name})`,
        ),
        "    }",
        "}",
      );
    }
    struct = undefined;
  }
  return out;
}

/** Generates every output file, in memory. */
export async function generate(): Promise<GeneratedFile[]> {
  return [
    { path: GENERATED_TS_FILE, content: await generateTypeScript() },
    { path: GENERATED_SWIFT_FILE, content: await generateSwift() },
  ];
}

/**
 * Writes the generated files under `outDir` (the repo root, or a temporary directory in the
 * tests) and deletes anything else in the generated directories. Returns the files written.
 */
export async function writeGenerated(outDir: string): Promise<GeneratedFile[]> {
  const files = await generate();
  const wanted = new Set(files.map((file) => file.path));
  for (const dir of GENERATED_DIRS) {
    if (!existsSync(join(outDir, dir))) continue;
    for (const entry of readdirSync(join(outDir, dir))) {
      if (!wanted.has(`${dir}/${entry}`)) rmSync(join(outDir, dir, entry), { recursive: true });
    }
  }
  for (const file of files) {
    const target = join(outDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }
  return files;
}
