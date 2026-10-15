# @usg/contracts

JSON Schema 2020-12 files for the project's file formats, with TypeScript and Swift types generated from them, the capture bundle validator, and validators for the public map files, change-set diffs and the private full export of HEAD. The schemas are the machine-readable form of the docs, which come first:

| Format | Doc | Schemas |
| --- | --- | --- |
| Capture bundle | [docs/capture-bundle.md](../../docs/capture-bundle.md) | `schemas/capture-bundle/` |
| Public map files: `latest.json`, `indoor.json`, `street.json`, `status.json` | [docs/snapshot-format.md](../../docs/snapshot-format.md) | `schemas/snapshot/` |
| Change-set diff (`change_sets.diff`) | [docs/diff-format.md](../../docs/diff-format.md) | `schemas/diff/` |
| API response bodies (`GET /health`, `GET /map/latest`, errors) | [services/api/README.md](../../services/api/README.md) | `schemas/api/` |
| Private full export of HEAD (`map_versions.private_export_uri`) | [docs/head-export-format.md](../../docs/head-export-format.md) | `schemas/export/` |

The map files and the diff share `schemas/map/defs.schema.json`: the HEAD tables' enums and GeoJSON geometry. Change the doc, then the schemas, then the code that writes and reads the format. The capture bundle and the snapshot files bump their `schema_version` on a breaking change (a new field, enum value or file included).

## What's here

| Path | What it is |
| --- | --- |
| `schemas/capture-bundle/` | Capture bundle v1: one schema per JSON file (`manifest`, `anchors`, `tags`), one per JSONL line (`pose-line`, `refined-keyframe-line`, `imu-line`, `gnss-line`, `blur-line`), and `defs.schema.json` with the shared definitions |
| `schemas/map/defs.schema.json` | The map data model's shared definitions: positions and geometries, ordinal, the enums of `db/schema.sql` |
| `schemas/snapshot/` | The public map files, snapshot format v1: `latest`, `indoor`, `street`, `status` |
| `schemas/diff/change-set-diff.schema.json` | `change_sets.diff`: one branch per feature type and op a change set may use |
| `schemas/api/` | The response bodies of services/api: `health`, `map-latest` and `error` (Fastify's error shape). TypeScript types only |
| `schemas/export/head-export.schema.json` | The private full export of HEAD that each map version keeps for rollback: every HEAD row with its `id` and `rev`, its columns reusing the diff's row definitions (`HeadVenue` to `HeadAnchor`). TypeScript types only |
| `src/index.ts` | The `.` entry: the generated types; constants (`SCHEMA_VERSION`, the schema file for each document, the enum values, `DEPTH_SIZE`, `UPLOAD_PART_BYTES`, the snapshot paths and cache headers); and the checks the map schemas can't express (`checkIndoorSnapshot`, `checkChangeSetDiff`, `checkHeadExport` and the rest, in `src/map.ts`, `src/snapshot.ts`, `src/diff.ts` and `src/export.ts`), and `headExportKey` |
| `src/schema-files.ts` | Node only: the list of schema files and their reader, shared by the generator and the Ajv setup |
| `src/generated/contracts.ts` | Generated TypeScript types for every schema. Do not edit |
| `src/validators.ts` | The `./validators` entry (Node only, Ajv): `validateSnapshotFile`, `validateVersion`, `validateChangeSetDiff`, `validateHeadExport`, `validateApiDocument`, `snapshotSha256`, `verifyLatestPointer`, `streetConnectorId`, `inlineSchema`, `createAjv` |
| `generated/swift/CaptureBundle.swift` | Generated Swift Codable types. Do not edit |
| `src/bundle-validator/` | The bundle validator and its CLI, `cli.ts` (Node only; see [Bundle validator](#bundle-validator)) |
| `scripts/gen.ts` | The generator (`pnpm gen`); `scripts/codegen.ts` does the work |
| `test/` | Ajv strict-mode compile, the docs' examples and invalid variants, enums and columns against `db/schema.sql`, a check that the generated files are current, the bundle validator's tests (`bundle-*.test.ts`) on synthetic bundles generated in code by `bundle-fixture.ts` and `tar-writer.ts`, the map files' and diff's tests (`snapshot.test.ts`, `diff.test.ts`, `docs.test.ts`) on the synthetic City Hall examples in `map-examples.ts`, and the private export's (`export.test.ts`) |

Package exports:

- `@usg/contracts`: types and constants. Environment-neutral (no Node APIs, no Ajv), so the mapper app (Hermes) and the webapp can import it. `pnpm typecheck` checks this: besides the package's own `tsc`, it runs `tsc -p tsconfig.neutral.json`, which compiles `src/index.ts` and what it imports with only the ES2024 library (no Node or DOM types) and `noUncheckedSideEffectImports`, so a Node global or a `node:` import (static, side-effect or dynamic) fails. A test follows the entry's imports and checks they stay inside the package.
- `@usg/contracts/schemas/*`: the schema files, for example `@usg/contracts/schemas/capture-bundle/manifest.schema.json` (import it `with { type: "json" }`, or read the file).
- `@usg/contracts/bundle-validator`: the Node-only bundle validator, with Ajv. Ajv stays out of the `.` entry; a test checks that the `.` entry never reaches it.
- `@usg/contracts/validators`: the Node-only validators for the public map files, change-set diffs, the private full export and API responses, with Ajv and `node:crypto`: the schema, then the `check*` functions (`validateVersion` checks a version's two files against each other too), plus the content hashes of [snapshot-format.md](../../docs/snapshot-format.md#content-addressing) and street connectors' ids (UUIDv5, which needs SHA-1). `inlineSchema(path)` turns a schema file into one self-contained schema, every `$ref` replaced by its target and no `$id`, `$schema` or `$defs`, for tools that can't resolve this package's `$id`s: services/api gives its Fastify routes these as response schemas, and @fastify/swagger builds the OpenAPI document from them. `createAjv` is the package's Ajv setup (2020-12, strict, formats, every schema added).

## Schema ids

Each schema's `$id` is `https://underground-sg.local/schemas/<family>/<file>` (`SCHEMA_BASE_URL` plus its path under `schemas/`), which mirrors the directory layout, so a relative `$ref` such as `defs.schema.json#/$defs/uuid` or `../map/defs.schema.json#/$defs/point` resolves the same way against the `$id` (Ajv, quicktype, json-schema-to-typescript) and against the file on disk. The map definitions reuse the capture bundle's `uuid`, `sha256`, `dateTime` and anchor kind through such references, so each is one type across the formats. The `$id`s are identifiers only: nothing fetches them, and the generator refuses to resolve anything outside this package.

## Generating code

```bash
pnpm gen
```

Run it after changing a schema and commit the output. It writes `src/generated/contracts.ts` with json-schema-to-typescript and `generated/swift/CaptureBundle.swift` with quicktype, and deletes anything else in those two directories. The documents it covers are `DOCUMENT_GROUPS` in `scripts/codegen.ts`, built from the constants in `src/capture-bundle.ts`, `src/snapshot.ts`, `src/diff.ts`, `src/api.ts` and `src/export.ts`. Every document gets TypeScript types, and each opts in or out of Swift (`swift`): the capture bundle's documents opt in, because the Swift module writes them; the map files, the diff, the export and the API's documents opt out, because no Swift code reads them. The output is deterministic and the same on Windows and Linux: inputs come from that fixed list, schemas are read only from this package, line endings are LF, and no paths, times or tool versions are written. CI runs `pnpm gen` on Ubuntu and Windows and fails on any diff; the package tests also generate into a temporary directory and compare, so `pnpm test` catches stale output locally.

Biome skips directories named `generated` (`biome.json`): the generators own the formatting of their output (json-schema-to-typescript runs Prettier with the repo's settings, and Biome can't format Swift), and lint fixes to generated code would be overwritten. `tsc` still typechecks the generated TypeScript.

The TypeScript types are compiled from one in-memory root, `ContractDocuments`, with a type map per group: `CaptureBundleDocuments` (bundle path to document type, for example `CaptureBundleDocuments["poses.jsonl"]` is `PoseLine`), `SnapshotDocuments` (`SnapshotDocuments["indoor.json"]` is `IndoorSnapshot`), `DiffDocuments` (`ChangeSetDiff`), `ApiDocuments` (route to response body, for example `ApiDocuments["GET /health"]` is `HealthResponse`) and `ExportDocuments` (`HeadExport`). One compile declares every shared type once, so titles must be unique across all the schemas.

## Swift

`generated/swift/CaptureBundle.swift` is for the Swift capture module, `apps/mapper/modules/capture-native` (not created yet), which writes the per-frame files: `poses.jsonl`, `refined_keyframes.jsonl`, `imu.jsonl` and `privacy/blur.jsonl`. The module skeleton task decides how the module includes the file. It holds `Codable`, `Equatable`, `Sendable` structs with `CodingKeys`, and `String` enums with the JSON values as raw values. Points to know:

- Date-times are `String`, not `Date`: JSONEncoder would write them in UTC and JSONDecoder's `.iso8601` rejects fractional seconds. The generator drops `format: date-time` from quicktype's view of the schemas; validation is unchanged.
- Fields that are required but may be `null` (`anchor_id`, `drift_m`, a tag's `name` and `note`) are Swift optionals. Synthesized `Encodable` leaves a `nil` key out, which the schemas reject, so Swift code that writes these needs a custom `encode(to:)`. The TypeScript app writes the files that have them.
- quicktype can't express the node/POI union in `tags.json`: Swift gets one `CaptureTag` struct with a `TagKind` enum holding both sets of kinds, and a `TagType` enum for `type`. The titles `NodeTagKind` and `PoiTagKind`, and `NodeTagType` and `PoiTagType`, are chosen so quicktype's merged names are `TagKind` and `TagType`.
- `Registration` has a case `none` (the JSON value), which shadows `Optional.none`: comparing a `Registration?` with `.none` makes Swift warn and pick the optional's `none`. Write `Registration.none` in full.
- Each type's `///` documentation sits directly above its declaration (the generator drops quicktype's `// MARK:` lines, which would detach it), so Xcode Quick Help shows it.
- UUIDs are lowercase in the bundle; `UUID().uuidString` is uppercase, so lowercase it.
- Nothing compiles the Swift file yet (no Mac). The macOS CI job for the module will.

## Bundle validator

`@usg/contracts/bundle-validator` checks a capture bundle against [docs/capture-bundle.md](../../docs/capture-bundle.md#ingest-and-validation): the schemas, the checks across files, the path rules and the size limits. It runs on Windows against recorded bundles, and ingest runs it in a processing worker.

```bash
node packages/contracts/src/bundle-validator/cli.ts <path> [--json] [--quarantined 812,1004]
```

`<path>` is a bundle directory, `capture-<capture_id>/`, or an uncompressed tar of one. `--quarantined` takes the keyframes the privacy re-check removed (`captures.quarantined_frames`): their files must be missing but still listed. The exit code is 0 for a valid bundle, 1 for an invalid one and 2 when the bundle can't be read (bad usage, a missing path, an IO error). The text output has one line per problem: severity, code, file (and line), message. `--json` prints the whole report.

The same CLI is the package script and bin `validate-bundle`: `pnpm --filter @usg/contracts validate-bundle <path>` (pnpm runs scripts in the package directory, so give an absolute path), or `validate-bundle` in a workspace package that depends on `@usg/contracts`. From code:

```ts
import { BundleIoError, validateBundleTar } from "@usg/contracts/bundle-validator";

const report = await validateBundleTar(s3ObjectBody, { quarantinedFrames });
// report.valid; report.failure_reason for captures.failure_reason; report.info for the
// share of frames with limited tracking. BundleIoError: the stream failed, so retry.
```

`validateBundle(path)` takes a directory or a tar file, `validateBundleDirectory(path)` a directory; `limits` overrides `DEFAULT_BUNDLE_LIMITS`.

How it works:

- **One pass.** The tar is read as a stream, once, and every member is hashed as it goes past. Only small things are kept: the JSON documents (up to `maxJsonBytes`), one JSONL line at a time, a JPEG's frame header and its APP0 to APP2 segments (each at most 64 KiB), the first 33 bytes of each PNG, and counts from the PLY. The checks across files run at the end, so the order of tar members doesn't matter.
- **Readers.** `tar.ts` is a dependency-free ustar reader (POSIX and GNU-style headers, regular files and directories only); `directory.ts` walks a directory with `lstat`, never following a link or a junction; both produce the same events. `images.ts` walks each JPEG from SOI to EOI (fill bytes, standalone markers, length-skipped segments, and entropy-coded data with its `FF 00` and restart markers) and each PNG from IHDR to IEND, without decoding pixels, and reports thumbnails (JFIF, JFXX, Exif IFD1), MPF segments and bytes after the end; `ply.ts` checks the header against the documented one and the counts against the limits before it reads the body.
- **Linear time.** Ajv runs with `allErrors` off: with it on, Ajv copies its error list for each failing `$ref`, so a 1 MiB `tags.json` of `{}` items took minutes. The schemas also bound their lists and text (`maxItems`, `maxLength`). A JSONL file stops being split and parsed at its 100th invalid line (`MAX_INVALID_JSONL_LINES`); the rest is only hashed, and `info.checks_skipped` says so. `test/bundle-validator.test.ts` ("hostile input") times these cases.
- **Problems** have a stable code (`PROBLEM_CODES` in `report.ts`), a severity, the file relative to the bundle directory and, for JSONL, the line. They are sorted by code (container problems first), file and line, so a report doesn't depend on member order; `failure_reason` is the first error. At most 20 problems with one code are kept per file and 100 per code; the rest are counted in `omitted`. Messages quote file names, line numbers, frame indices and sizes, never poses, times, IMU samples or GNSS fixes, which are personal data. Data from the bundle is never echoed whole: a wrong `schema_version` is described by its type unless it is an integer, and names (tar members, unknown JSON keys) are escaped and cut to 200 characters. As a backstop, every message has its control and non-ASCII characters escaped and is cut to 1,000 characters.
- **Warnings** are checks the doc doesn't make. They don't make a bundle invalid.
- **schema_version.** A bundle that isn't version 1 gets one `manifest.schema_version` error and no content checks.

| Code | Severity | Meaning |
| --- | --- | --- |
| `tar.bad_header` | error | A tar header is not a ustar header, or the input is not an uncompressed tar |
| `tar.bad_checksum` | error | A tar header's checksum does not match |
| `tar.truncated` | error | The tar ends inside a header or member, or without its end-of-archive marker |
| `tar.trailing_data` | error | Non-zero bytes after the end-of-archive marker |
| `tar.unsupported_entry` | error | A pax, GNU or other extension header |
| `entry.link` | error | A symbolic or hard link |
| `entry.special_file` | error | A device, FIFO, socket or other file that is not regular |
| `entry.duplicate` | error | Two tar members with the same name |
| `path.invalid` | error | An empty name, a control or non-ASCII character, or a file name ending in / |
| `path.absolute` | error | An absolute path |
| `path.dot_dot` | error | A .. path segment |
| `path.backslash` | error | A backslash in a path |
| `path.not_normalised` | error | An empty or . path segment |
| `path.outside_bundle_directory` | error | A path that is not under the one `capture-<uuid>/` directory |
| `path.outside_layout` | error | A file or directory that is not in the bundle layout |
| `limits.bundle_size` | error | The bundle is larger than maxBundleBytes |
| `limits.entry_count` | error | More entries than maxEntries |
| `limits.file_size` | error | A file is larger than the limit for its type |
| `limits.line_length` | error | A JSONL line is longer than maxJsonlLineBytes |
| `limits.ply_vertices` | error | The PLY declares more vertices than maxPlyVertices |
| `limits.ply_faces` | error | The PLY declares more faces than maxPlyFaces |
| `limits.image_pixels` | error | image_size has more pixels than maxImagePixels |
| `file.missing` | error | A required file is missing |
| `manifest.schema_version` | error | schema_version is not 1 |
| `bundle.capture_id_mismatch` | error | The bundle directory is not named `capture-<manifest.capture_id>` |
| `json.invalid` | error | A JSON file or JSONL line is not valid UTF-8 JSON, or a JSONL line is blank |
| `schema.invalid` | error | A JSON file or JSONL line does not match its schema |
| `files.duplicate_listing` | error | manifest.files lists a path twice |
| `files.listed_but_missing` | error | A file listed in manifest.files is not in the bundle |
| `files.not_listed` | error | A file in the bundle is not listed in manifest.files |
| `files.bytes_mismatch` | error | A file's size differs from manifest.files |
| `files.sha256_mismatch` | error | A file's SHA-256 differs from manifest.files |
| `quarantine.not_keyframe` | error | A quarantined frame is not a keyframe in poses.jsonl |
| `quarantine.file_present` | error | A quarantined keyframe's file is still in the bundle |
| `quarantine.file_not_listed` | error | A quarantined keyframe's file is not listed in manifest.files |
| `manifest.frame_count` | error | frame_count differs from the lines in poses.jsonl |
| `manifest.keyframe_count` | error | keyframe_count differs from the keyframe lines in poses.jsonl |
| `keyframe.jpeg_missing` | error | A keyframe has no JPEG |
| `keyframe.depth_missing` | error | A keyframe has no depth PNG |
| `keyframe.confidence_missing` | error | A keyframe has no confidence PNG, while others have one |
| `keyframe.blur_line_missing` | error | A keyframe has no privacy/blur.jsonl line |
| `keyframe.unexpected_file` | error | A JPEG or PNG for a frame that is not a keyframe |
| `order.frame` | error | frame does not strictly increase within a JSONL file |
| `order.t` | error | t does not strictly increase within a JSONL file |
| `refined.not_keyframe` | error | A refined_keyframes.jsonl line for a frame that is not a keyframe |
| `tags.frame_not_in_poses` | error | A tag's frame is not in poses.jsonl |
| `manifest.depth_size` | error | depth_size is not [256, 192] |
| `manifest.orientation` | error | image_size or depth_size is portrait (width less than height) |
| `manifest.aspect_ratio` | error | image_size and depth_size have different aspect ratios |
| `jpeg.invalid` | error | Not a complete JPEG: SOI, a frame header (SOFn), one or more scans (SOS), then EOI |
| `jpeg.format` | error | A keyframe JPEG is not 3-component colour |
| `jpeg.extra_image` | error | A keyframe JPEG carries a thumbnail (JFIF, JFXX or Exif), an MPF segment or bytes after EOI |
| `jpeg.size_mismatch` | error | A keyframe JPEG's size differs from image_size |
| `png.invalid` | error | Not a complete PNG: a malformed IHDR or chunk, no IDAT or no IEND |
| `png.trailing_data` | error | Bytes after a PNG's IEND chunk |
| `png.format` | error | A depth PNG is not 16-bit greyscale, or a confidence PNG not 8-bit greyscale |
| `png.size_mismatch` | error | A depth or confidence PNG's size differs from depth_size |
| `anchors.roles` | error | Not exactly one start and one end anchor |
| `anchors.photo_not_keyframe` | error | An anchor's photo is not a keyframe in poses.jsonl |
| `anchors.photo_missing` | error | An anchor's photo is not in the bundle |
| `anchors.photo_quarantined` | error | An anchor's photo is a quarantined keyframe |
| `anchors.facing` | error | An anchor's facing is not a horizontal unit vector |
| `blur.not_keyframe` | error | A privacy/blur.jsonl line for a frame that is not a keyframe |
| `blur.box_outside_image` | error | A blur box extends beyond image_size |
| `manifest.faces_blurred` | error | faces_blurred differs from the face boxes in privacy/blur.jsonl |
| `manifest.screens_blurred` | error | screens_blurred differs from the screen boxes in privacy/blur.jsonl |
| `ply.header` | error | The PLY header is not exactly the documented one |
| `ply.truncated` | error | The PLY body ends before the declared vertices and faces |
| `ply.vertex_index` | error | A face refers to a vertex index beyond the vertex count |
| `ply.classification` | error | A face classification is not 0 to 7 |
| `ply.non_triangle_face` | error | A face whose vertex_indices list does not have 3 entries |
| `ply.non_finite_vertex` | warning | A vertex coordinate is NaN or infinite |
| `ply.trailing_bytes` | warning | Bytes after the last declared face |
| `png.ihdr_crc` | warning | A PNG's IHDR chunk CRC does not match |
| `transform.not_affine` | warning | A transform's last row is not [0, 0, 0, 1]: written row-major? |
| `manifest.time_order` | warning | session_started_at, started_at and ended_at are out of order |
| `preview.invalid_json` | warning | preview/floorplan.geojson is not a JSON object |

The fuzz tests take `FUZZ_SEED` and `FUZZ_RUNS` from the environment (defaults: a fixed seed and 150 runs per property): `FUZZ_RUNS=5000 pnpm --filter @usg/contracts exec vitest run test/bundle-fuzz.test.ts`.

## Schema rules

The schemas stay within what Ajv 8 (`ajv/dist/2020` with ajv-formats), json-schema-to-typescript and quicktype (Swift) all handle the same way. `test/schemas.test.ts` enforces the first five rules.

1. **Keywords:** `$schema`, `$id`, `$ref`, `$defs`, `title`, `description`, `type`, `enum`, `const`, `properties`, `required`, `additionalProperties`, `items`, `minItems`, `maxItems`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minLength`, `maxLength`, `pattern`, `format`, `anyOf`, `oneOf`, `allOf`. Nothing else: json-schema-to-typescript and quicktype ignore keywords such as `if`/`then`, `unevaluatedProperties` or `patternProperties`, so the types would be wider than what validation accepts. (Both also ignore the bounds `minLength`, `maxLength`, `minimum`, `maximum` and the exclusive bounds, which only narrow the values, not the types.) `multipleOf` is left out as well: Ajv tests it by division, so `multipleOf: 1e-7` rejects valid 7-decimal coordinates through rounding error. Coordinate decimals are checked in code (`hasAtMostDecimals`).
2. **Every object has `"additionalProperties": false`.** Unknown fields are rejected; adding a field is a `schema_version` bump.
3. **A `$ref` has no sibling keywords.** json-schema-to-typescript merges a `$ref` and its siblings into a new numbered type (`DateTime1`). To describe a property that uses a shared definition, wrap it: `{ "description": "...", "allOf": [{ "$ref": "defs.schema.json#/$defs/vec3" }] }`.
4. **`type` is one string.** Ajv's strict mode rejects `"type": ["string", "null"]`; write a nullable value as `"anyOf": [{ ... }, { "type": "null" }]`.
5. **Fixed-length arrays** use `items` with `minItems` equal to `maxItems`, never `prefixItems`: json-schema-to-typescript turns them into tuples (`[number, number, number]`), quicktype into arrays. Give other bounded lists a `maxItems` above 20, or json-schema-to-typescript writes a union of a tuple for every length up to it. Definitions live under `$defs` (2020-12), not `definitions`; all three tools resolve `$ref`s into `$defs` as JSON pointers.
6. **Discriminated unions** are a `oneOf` of complete object schemas, each with a `const` discriminator: TypeScript gets `NodeTag | PoiTag`, quicktype merges the branches into one struct. Give the discriminators and the branches' enums titled definitions whose names share a word (`NodeTagType` and `PoiTagType`, `NodeTagKind` and `PoiTagKind`): quicktype names a merged enum from the common prefix or suffix of the names, and an untitled one gets a meaningless name such as `TypeEnum`.
7. **Formats:** only `date-time`, and with a `pattern` as well, so a validator that treats `format` as an annotation still requires the offset.
8. **Give every reusable definition a `title`:** it becomes the type name in both languages.

Constraints that JSON Schema can't express are left to the validators (the bundle validator, and the `check*` functions for the map files and the diff) and listed in each schema's `description`: for example exactly one start and one end anchor, `facing` being a horizontal unit vector, counts matching other files, and `frame` and `t` only increasing.
