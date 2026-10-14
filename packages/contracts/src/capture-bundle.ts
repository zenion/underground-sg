// Constants for the capture bundle format (docs/capture-bundle.md). Environment-neutral: the
// mapper app (Hermes), the webapp, the validator and the code generator import this file.

import type {
  AnchorKind,
  AnchorRole,
  BoxKind,
  CaptureTag,
  NodeTagKind,
  PoiTagKind,
  Registration,
} from "./generated/capture-bundle.ts";

/** The capture bundle format version this package describes (`manifest.schema_version`). */
export const SCHEMA_VERSION = 1;

/**
 * Base of the capture bundle schemas' `$id`s. The `$id`s are identifiers, never fetched: tools
 * load the schema files from this package (`@usg/contracts/schemas/capture-bundle/<file>`).
 */
export const CAPTURE_BUNDLE_SCHEMA_BASE_URL =
  "https://underground-sg.local/schemas/capture-bundle/";

/** The schema file with the definitions the other capture bundle schemas share. */
export const CAPTURE_BUNDLE_DEFS_SCHEMA_FILE = "defs.schema.json";

/**
 * The schema file for each JSON file in a bundle, keyed by its path in the bundle directory.
 * For a `.jsonl` file the schema describes one line. A schema's `$id` is
 * `CAPTURE_BUNDLE_SCHEMA_BASE_URL` plus its file name.
 */
export const CAPTURE_BUNDLE_SCHEMA_FILES = {
  "manifest.json": "manifest.schema.json",
  "anchors.json": "anchors.schema.json",
  "tags.json": "tags.schema.json",
  "poses.jsonl": "pose-line.schema.json",
  "refined_keyframes.jsonl": "refined-keyframe-line.schema.json",
  "imu.jsonl": "imu-line.schema.json",
  "gnss.jsonl": "gnss-line.schema.json",
  "privacy/blur.jsonl": "blur-line.schema.json",
} as const;

/** A JSON or JSONL file of a capture bundle that has a schema. */
export type CaptureBundleJsonPath = keyof typeof CAPTURE_BUNDLE_SCHEMA_FILES;

/** Frame names are frame indices zero-padded to this many digits: keyframes/000058.jpg. */
export const FRAME_NAME_DIGITS = 6;

/**
 * `manifest.depth_size`, [w, h]: depth and confidence PNGs are ARKit's scene depth, 256 x 192
 * pixels in the sensor's native landscape orientation.
 */
export const DEPTH_SIZE = [256, 192] as const;

/**
 * The upload part size, 16 MiB: `packBundle(dir, partBytes)` splits the bundle tar into parts of
 * this many bytes (the last part may be smaller), uploaded as one S3 multipart upload.
 */
export const UPLOAD_PART_BYTES = 16 * 1024 * 1024;

export const ANCHOR_ROLES = ["start", "end"] as const satisfies readonly AnchorRole[];

/** Same values as `anchor_kind` in db/schema.sql. */
export const ANCHOR_KINDS = [
  "floor_point",
  "image_anchor",
] as const satisfies readonly AnchorKind[];

export const REGISTRATIONS = [
  "world_map",
  "continuous_session",
  "image_anchor",
  "none",
] as const satisfies readonly Registration[];

export const TAG_TYPES = ["node", "poi"] as const satisfies readonly CaptureTag["type"][];

/** `kind` of a node tag: the `node_kind` values in db/schema.sql. */
export const NODE_TAG_KINDS = [
  "junction",
  "exit",
  "entrance",
  "escalator",
  "lift",
  "stairs",
  "fare_gate",
  "door",
  "travelator",
  "ramp",
] as const satisfies readonly NodeTagKind[];

/** `kind` of a POI tag: the `poi_category` values in db/schema.sql. */
export const POI_TAG_KINDS = [
  "shop",
  "food",
  "toilet",
  "atm",
  "info",
  "nursing_room",
  "other",
] as const satisfies readonly PoiTagKind[];

/** `kind` of a box in privacy/blur.jsonl. */
export const BOX_KINDS = ["face", "person_head", "screen"] as const satisfies readonly BoxKind[];

/** `tracking` in poses.jsonl is `normal`, `notAvailable` or this prefix plus ARKit's reason. */
export const TRACKING_LIMITED_PREFIX = "limited:";
