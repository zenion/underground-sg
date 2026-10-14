import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  CAPTURE_BUNDLE_SCHEMA_BASE_URL,
  type CaptureBundleJsonPath,
  DIFF_SCHEMA_BASE_URL,
  MAP_SCHEMA_BASE_URL,
  SCHEMA_BASE_URL,
  SNAPSHOT_SCHEMA_BASE_URL,
} from "../src/index.ts";
import * as examples from "./examples.ts";
import {
  ALL_SCHEMA_FILES,
  createAjv,
  readSchema,
  SCHEMAS_DIR,
  validatorFor,
  walkSchema,
} from "./schemas.ts";

/**
 * The keywords the schemas may use: the subset that Ajv 2020, json-schema-to-typescript and
 * quicktype all handle the same way (see README.md).
 */
const ALLOWED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "title",
  "description",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "anyOf",
  "oneOf",
  "allOf",
]);

describe("schema files", () => {
  test("every file under schemas/ is listed in the package constants", () => {
    const dir = fileURLToPath(SCHEMAS_DIR);
    const onDisk = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
      .sort();
    expect(onDisk).toEqual([...ALL_SCHEMA_FILES].sort());
  });

  test("each family's $id base is the shared base plus its directory", () => {
    expect(CAPTURE_BUNDLE_SCHEMA_BASE_URL).toBe(`${SCHEMA_BASE_URL}capture-bundle/`);
    expect(MAP_SCHEMA_BASE_URL).toBe(`${SCHEMA_BASE_URL}map/`);
    expect(SNAPSHOT_SCHEMA_BASE_URL).toBe(`${SCHEMA_BASE_URL}snapshot/`);
    expect(DIFF_SCHEMA_BASE_URL).toBe(`${SCHEMA_BASE_URL}diff/`);
  });

  test.each(ALL_SCHEMA_FILES)("%s declares 2020-12, its $id, a title and a description", (file) => {
    const schema = readSchema(file);
    expect(schema["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema["$id"]).toBe(`${SCHEMA_BASE_URL}${file}`);
    expect(schema["title"]).toEqual(expect.any(String));
    expect(schema["description"]).toEqual(expect.any(String));
  });

  test.each(ALL_SCHEMA_FILES)("%s stays in the portable subset", (file) => {
    const problems: string[] = [];
    walkSchema(readSchema(file), file, (schema, at) => {
      for (const key of Object.keys(schema)) {
        if (!ALLOWED_KEYWORDS.has(key)) problems.push(`${at}: keyword ${key}`);
      }
      // json-schema-to-typescript turns a $ref with siblings into a new numbered type.
      if ("$ref" in schema && Object.keys(schema).length > 1) {
        problems.push(`${at}: $ref with sibling keywords (wrap it in allOf)`);
      }
      if (schema["type"] === "object" && schema["additionalProperties"] !== false) {
        problems.push(`${at}: object without additionalProperties: false`);
      }
      if (Array.isArray(schema["type"])) {
        problems.push(`${at}: type array (use anyOf with {"type": "null"})`);
      }
    });
    expect(problems).toEqual([]);
  });

  test.each(ALL_SCHEMA_FILES)("%s compiles under Ajv 2020 strict mode", (file) => {
    // createAjv adds every schema; getSchema compiles one and throws on any strict-mode issue.
    const ajv = createAjv();
    expect(ajv.getSchema(`${SCHEMA_BASE_URL}${file}`)).toBeTypeOf("function");
  });
});

type Example = readonly [CaptureBundleJsonPath, unknown];

const validExamples: Record<string, Example> = {
  "doc manifest": ["manifest.json", examples.manifest],
  "doc anchors": ["anchors.json", examples.anchors],
  "doc tags": ["tags.json", examples.tags],
  "empty tags": ["tags.json", []],
  "doc pose line": ["poses.jsonl", examples.poseLine],
  "doc refined keyframe line": ["refined_keyframes.jsonl", examples.refinedKeyframeLine],
  "doc imu line": ["imu.jsonl", examples.imuLine],
  "doc gnss line": ["gnss.jsonl", examples.gnssLine],
  "doc blur line without boxes": ["privacy/blur.jsonl", examples.blurLines[0]],
  "doc blur line with boxes": ["privacy/blur.jsonl", examples.blurLines[1]],
  "manifest with drift_m null": ["manifest.json", { ...examples.manifest, drift_m: null }],
  "manifest with UTC date-times and fractional seconds": [
    "manifest.json",
    { ...examples.manifest, started_at: "2026-10-20T02:32:03.250Z" },
  ],
  "manifest listing every kind of bundle file": [
    "manifest.json",
    {
      ...examples.manifest,
      files: [
        "anchors.json",
        "tags.json",
        "poses.jsonl",
        "refined_keyframes.jsonl",
        "imu.jsonl",
        "gnss.jsonl",
        "keyframes/000058.jpg",
        "depth/000058.png",
        "confidence/000058.png",
        "privacy/blur.jsonl",
        "mesh/scene.ply",
        "preview/floorplan.geojson",
      ].map((path) => ({ ...examples.manifest.files[0], path })),
    },
  ],
  "new anchor (anchor_id null)": [
    "anchors.json",
    [{ ...examples.anchors[0], anchor_id: null }, examples.anchors[1]],
  ],
  "tag with a name": ["tags.json", [{ ...examples.tags[0], name: "Escalator to B1" }]],
  "pose line with limited tracking": [
    "poses.jsonl",
    { ...examples.poseLine, tracking: "limited:excessiveMotion", keyframe: false },
  ],
  "pose line at frame 0 and t 0": ["poses.jsonl", { ...examples.poseLine, frame: 0, t: 0 }],
  "anchor ordinals at the bounds of a smallint": [
    "anchors.json",
    [
      { ...examples.anchors[0], ordinal: -32_768 },
      { ...examples.anchors[1], ordinal: 32_767 },
    ],
  ],
  "a tag note of 2000 characters": ["tags.json", [{ ...examples.tags[0], note: "x".repeat(2000) }]],
};

describe("valid documents", () => {
  test.each(Object.entries(validExamples))("%s", (_name, [bundlePath, document]) => {
    const validate = validatorFor(bundlePath);
    expect(validate(document), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });
});

/** Returns a deep copy of `value` changed by `change`. */
function variant<T>(value: T, change: (copy: T) => void): T {
  const copy = structuredClone(value);
  change(copy);
  return copy;
}

const { manifest, anchors, tags, poseLine, refinedKeyframeLine, imuLine, gnssLine, blurLines } =
  examples;
const blurLine = blurLines[1];

const invalidExamples: Record<string, Example> = {
  // Missing required fields
  "manifest without capture_id": [
    "manifest.json",
    variant(manifest, (m) => {
      delete (m as Partial<typeof m>).capture_id;
    }),
  ],
  "manifest without drift_m (required, may be null)": [
    "manifest.json",
    variant(manifest, (m) => {
      delete (m as Partial<typeof m>).drift_m;
    }),
  ],
  "anchor without photo": [
    "anchors.json",
    variant(anchors, (a) => {
      delete (a[0] as Partial<(typeof a)[0]>).photo;
    }),
  ],
  "tag without note (required, may be null)": [
    "tags.json",
    variant(tags, (t) => {
      delete (t[1] as Partial<(typeof t)[1]>).note;
    }),
  ],
  "pose line without tracking": [
    "poses.jsonl",
    variant(poseLine, (p) => {
      delete (p as Partial<typeof p>).tracking;
    }),
  ],
  "blur line without boxes": ["privacy/blur.jsonl", { frame: 58 }],

  // Unknown fields
  "manifest with contributor_id": [
    "manifest.json",
    { ...manifest, contributor_id: "6f1c5a43-3c1e-4d55-8f0a-2b8b7e9d1a20" },
  ],
  "unknown privacy field": [
    "manifest.json",
    { ...manifest, privacy: { ...manifest.privacy, plates_blurred: 0 } },
  ],
  "unknown anchor field": ["anchors.json", [{ ...anchors[0], level_id: null }, anchors[1]]],
  "unknown tag field": ["tags.json", [{ ...tags[0], level: "B2" }]],
  "unknown imu field": ["imu.jsonl", { ...imuLine, mag: [1, 2, 3] }],
  "unknown box field": [
    "privacy/blur.jsonl",
    { frame: 812, boxes: [{ x: 1, y: 2, w: 3, h: 4, kind: "face", score: 0.9 }] },
  ],

  // Enums and consts
  "schema_version 2": ["manifest.json", { ...manifest, schema_version: 2 }],
  "anchor role middle": ["anchors.json", [{ ...anchors[0], role: "middle" }, anchors[1]]],
  "anchor kind tap_pose": ["anchors.json", [{ ...anchors[0], kind: "tap_pose" }, anchors[1]]],
  "registration relative_pose": [
    "anchors.json",
    [{ ...anchors[0], registration: "relative_pose" }, anchors[1]],
  ],
  "tag type landmark": ["tags.json", [{ ...tags[0], type: "landmark" }]],
  "box kind licence_plate": [
    "privacy/blur.jsonl",
    { frame: 812, boxes: [{ x: 1, y: 2, w: 3, h: 4, kind: "licence_plate" }] },
  ],
  "tracking limited without a reason": ["poses.jsonl", { ...poseLine, tracking: "limited" }],
  "tracking in the wrong case": ["poses.jsonl", { ...poseLine, tracking: "Normal" }],

  // tags: kind must match type
  "node tag with a POI kind (toilet)": ["tags.json", [{ ...tags[0], kind: "toilet" }]],
  "POI tag with a node kind (escalator)": ["tags.json", [{ ...tags[1], kind: "escalator" }]],

  // Array lengths
  "anchors.json with one anchor": ["anchors.json", [anchors[0]]],
  "anchors.json with three anchors": ["anchors.json", [anchors[0], anchors[1], anchors[1]]],
  "transform of 15 numbers": [
    "refined_keyframes.jsonl",
    { ...refinedKeyframeLine, transform: refinedKeyframeLine.transform.slice(1) },
  ],
  "transform of 17 numbers": [
    "poses.jsonl",
    { ...poseLine, transform: [...poseLine.transform, 1] },
  ],
  "point of 2 numbers": ["anchors.json", [{ ...anchors[0], point: [0.21, -1.43] }, anchors[1]]],
  "image_size of 3 numbers": ["manifest.json", { ...manifest, image_size: [1920, 1440, 3] }],
  "intrinsics of 3 numbers": ["poses.jsonl", { ...poseLine, intrinsics: [1445.2, 958.4, 721.9] }],
  "accel of 4 numbers": ["imu.jsonl", { ...imuLine, accel: [0.12, -9.71, -1.05, 0] }],

  // Formats and patterns
  "uppercase sha256": [
    "manifest.json",
    variant(manifest, (m) => {
      const file = m.files[0];
      if (file) file.sha256 = file.sha256.toUpperCase();
    }),
  ],
  "short sha256": [
    "manifest.json",
    variant(manifest, (m) => {
      const file = m.files[0];
      if (file) file.sha256 = file.sha256.slice(1);
    }),
  ],
  "date-time without offset": ["manifest.json", { ...manifest, started_at: "2026-10-20T10:32:03" }],
  "date-time in another time zone (-05:00)": [
    "manifest.json",
    { ...manifest, session_started_at: "2026-10-19T21:32:01-05:00" },
  ],
  "date-time with offset +00:00 (write Z)": [
    "manifest.json",
    { ...manifest, ended_at: "2026-10-20T02:34:41+00:00" },
  ],
  "date-time with offset +0800 (no colon)": [
    "manifest.json",
    { ...manifest, started_at: "2026-10-20T10:32:03+0800" },
  ],
  "date-only started_at": ["manifest.json", { ...manifest, started_at: "2026-10-20" }],
  "date-time with an impossible month": [
    "manifest.json",
    { ...manifest, ended_at: "2026-13-20T10:34:41+08:00" },
  ],
  "uppercase capture_id": [
    "manifest.json",
    { ...manifest, capture_id: "8F9585DA-8554-4B8A-BA4E-0F390CCD3802" },
  ],
  "capture_id with a urn prefix": [
    "manifest.json",
    { ...manifest, capture_id: "urn:uuid:8f9585da-8554-4b8a-ba4e-0f390ccd3802" },
  ],
  "file path outside the layout": [
    "manifest.json",
    { ...manifest, files: [{ ...manifest.files[0], path: "../anchors.json" }] },
  ],
  "manifest.json listing itself": [
    "manifest.json",
    { ...manifest, files: [{ ...manifest.files[0], path: "manifest.json" }] },
  ],
  "keyframe name not zero-padded": [
    "manifest.json",
    { ...manifest, files: [{ ...manifest.files[0], path: "keyframes/58.jpg" }] },
  ],
  "Windows path separator": [
    "manifest.json",
    { ...manifest, files: [{ ...manifest.files[0], path: "keyframes\\000058.jpg" }] },
  ],
  "anchor photo that is a depth PNG": [
    "anchors.json",
    [{ ...anchors[0], photo: "depth/000058.png" }, anchors[1]],
  ],

  // Ranges and nullability
  "frame index of seven digits": ["poses.jsonl", { ...poseLine, frame: 1_000_000 }],
  "negative frame index": ["refined_keyframes.jsonl", { ...refinedKeyframeLine, frame: -1 }],
  "fractional frame index": ["poses.jsonl", { ...poseLine, frame: 1.5 }],
  "negative t": ["imu.jsonl", { ...imuLine, t: -0.01 }],
  "zero focal length": ["poses.jsonl", { ...poseLine, intrinsics: [0, 1445.2, 958.4, 721.9] }],
  "negative drift_m": ["manifest.json", { ...manifest, drift_m: -0.1 }],
  "zero frame_count": ["manifest.json", { ...manifest, frame_count: 0 }],
  "anchor name null": ["anchors.json", [{ ...anchors[0], name: null }, anchors[1]]],
  "empty tag note (use null)": ["tags.json", [{ ...tags[0], note: "" }]],
  "latitude out of range": ["gnss.jsonl", { ...gnssLine, lat: 91 }],
  "negative horizontal accuracy": ["gnss.jsonl", { ...gnssLine, h_accuracy_m: -1 }],
  "zero-width box": [
    "privacy/blur.jsonl",
    { ...blurLine, boxes: [{ x: 1204, y: 388, w: 0, h: 112, kind: "face" }] },
  ],
  "box with fractional pixels": [
    "privacy/blur.jsonl",
    { ...blurLine, boxes: [{ x: 1204.5, y: 388, w: 96, h: 112, kind: "face" }] },
  ],
  "keyframe as a string": ["poses.jsonl", { ...poseLine, keyframe: "true" }],
  "ordinal beyond a smallint": ["anchors.json", [{ ...anchors[0], ordinal: 40_000 }, anchors[1]]],
  "ordinal below a smallint": ["anchors.json", [{ ...anchors[0], ordinal: -32_769 }, anchors[1]]],

  // Upper bounds on lists and text, so a hostile document can't make validation slow
  "more than 10000 tags": ["tags.json", new Array(10_001).fill(tags[0])],
  "more than 20000 files": [
    "manifest.json",
    { ...manifest, files: new Array(20_001).fill(manifest.files[0]) },
  ],
  "more than 1000 boxes in a keyframe": [
    "privacy/blur.jsonl",
    { frame: 812, boxes: new Array(1001).fill({ x: 1, y: 2, w: 3, h: 4, kind: "face" }) },
  ],
  "a tag note of 2001 characters": ["tags.json", [{ ...tags[0], note: "x".repeat(2001) }]],
  "an anchor name of 201 characters": [
    "anchors.json",
    [{ ...anchors[0], name: "x".repeat(201) }, anchors[1]],
  ],
  "an app_version of 101 characters": [
    "manifest.json",
    { ...manifest, app_version: "1".repeat(101) },
  ],
  "a detector version of 201 characters": [
    "manifest.json",
    variant(manifest, (m) => {
      m.privacy.detector_versions.screen = "x".repeat(201);
    }),
  ],
};

describe("invalid documents", () => {
  test.each(Object.entries(invalidExamples))("%s", (_name, [bundlePath, document]) => {
    expect(validatorFor(bundlePath)(document)).toBe(false);
  });
});

describe("validation time", () => {
  // With Ajv's allErrors, each failing $ref copied the whole error list, so time grew with the
  // square of the invalid items (16000 empty tags took about 5 s). The validator stops at the
  // first error instead.
  test.each<[string, CaptureBundleJsonPath, unknown]>([
    ["10000 empty tags", "tags.json", new Array(10_000).fill({})],
    ["1000 empty boxes", "privacy/blur.jsonl", { frame: 0, boxes: new Array(1000).fill({}) }],
    ["20000 empty files", "manifest.json", { ...manifest, files: new Array(20_000).fill({}) }],
  ])("%s fail at once, with few errors", (_name, bundlePath, document) => {
    const validate = validatorFor(bundlePath);
    const started = performance.now();
    expect(validate(document)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
    expect(validate.errors?.length).toBeLessThanOrEqual(5);
  });
});
