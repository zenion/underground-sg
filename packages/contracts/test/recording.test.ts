// The session recording schemas, recording_version 1 (docs/session-recording.md): the examples
// validate, the invalid variants don't, and the constants agree with the schemas and the doc.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { DEFAULT_BUNDLE_LIMITS } from "../src/bundle-validator/index.ts";
import {
  ANCHOR_HISTORY_KINDS,
  CANDIDATE_STATUSES,
  DEFAULT_RECORDING_LIMITS,
  DEGRADATION_STEPS,
  RECORDING_ENDED,
  RECORDING_EVENT_KINDS,
  RECORDING_PROFILES,
  RECORDING_SCHEMA_FILES,
  RECORDING_SET_SCHEMA_FILES,
  RECORDING_SWIFT_FILES,
  RECORDING_VERSION,
  SCHEMA_BASE_URL,
  UPLOAD_PART_BYTES,
} from "../src/index.ts";
import { blurLines, gnssLine, imuLine } from "./examples.ts";
import * as ex from "./recording-examples.ts";
import { createAjv, readSchema, type SchemaObject } from "./schemas.ts";

const FILES = { ...RECORDING_SCHEMA_FILES, ...RECORDING_SET_SCHEMA_FILES };
type Name = keyof typeof FILES;

const ajv = createAjv();
function validate(name: Name, document: unknown): { valid: boolean; errors: string } {
  const validator = ajv.getSchema(`${SCHEMA_BASE_URL}${FILES[name]}`);
  if (!validator) throw new Error(`No schema for ${name}`);
  const valid = validator(document) as boolean;
  return { valid, errors: JSON.stringify(validator.errors, null, 2) };
}

const DOC = readFileSync(new URL("../../../docs/session-recording.md", import.meta.url), "utf8");

const valid: Record<string, readonly [Name, unknown]> = {
  "recording.json once closed": ["recording.json", ex.recording],
  "recording.json as it opens": ["recording.json", ex.openRecording],
  "a standard recording with detectors and segments": [
    "recording.json",
    {
      ...ex.recording,
      origin: "device",
      profile: "standard",
      build: {
        ...ex.recording.build,
        profile: "walk",
        eas_build_id: "2f6d8c1a-9b4e-4d7f-8a3c-5e1b0d9f7c26",
      },
      rates: { ...ex.recording.rates, mesh_interval_s: null },
      detector_versions: {
        face: "VNDetectFaceRectanglesRequest rev 3",
        person_head: "VNDetectHumanRectanglesRequest rev 2",
        screen: "rf-detr-n 1.0",
      },
      segments: [
        {
          capture_id: "8f9585da-8554-4b8a-ba4e-0f390ccd3802",
          manifest_sha256: ex.recording.files[0]?.sha256,
          start_t: 3.2,
          end_t: 211.4,
          frame_offset: 0,
          kept: true,
        },
      ],
      files: [
        ...ex.recording.files,
        ...["candidates/001203.jpg", "depth/001203.png", "confidence/001203.png"].map((path) => ({
          path,
          bytes: 2048,
          sha256: ex.recording.files[0]?.sha256,
        })),
        { path: "privacy/blur.jsonl", bytes: 90, sha256: ex.recording.files[0]?.sha256 },
      ],
    },
  ],
  "a cut-off recording, trimmed": [
    "recording.json",
    {
      ...ex.recording,
      window: { start_t: 3.2, end_t: 300.5, ended: "interrupted", trimmed: true },
      closed: false,
    },
  ],
  "a frame line": ["frames.jsonl", ex.frameLine],
  "a frame that isn't a candidate, without a light estimate": [
    "frames.jsonl",
    { ...ex.frameLine, light: null, candidate: null, ms: {} },
  ],
  "a kept candidate with its sharpness and every stage": [
    "frames.jsonl",
    {
      ...ex.frameLine,
      candidate: "kept",
      sharpness: 41.2,
      ms: {
        gate: 0.02,
        copy: 1.1,
        sharpness: 0.8,
        detect: 14,
        blur: 2,
        encode: 9,
        depth: 3,
        write: 1,
      },
    },
  ],
  "a frame with limited tracking and a gap": [
    "frames.jsonl",
    { ...ex.frameLine, tracking: "limited:relocalizing", gap: 2, candidate: null },
  ],
  "the bundle's imu line": ["imu.jsonl", imuLine],
  "the bundle's gnss line as a location line": ["location.jsonl", gnssLine],
  "the bundle's blur line": ["privacy/blur.jsonl", blurLines[1]],
  "a motion line": ["motion.jsonl", ex.motionLine],
  "a motion line without a heading": ["motion.jsonl", { ...ex.motionLine, heading: null }],
  "an altitude line": ["altitude.jsonl", ex.altitudeLine],
  "a mesh anchor update": ["anchors.jsonl", ex.anchorLine],
  "a keyframe anchor added": [
    "anchors.jsonl",
    { ...ex.anchorLine, kind: "keyframe", op: "add", frame: 1203 },
  ],
  "an anchor removed": ["anchors.jsonl", { ...ex.anchorLine, op: "remove", transform: null }],
  ...Object.fromEntries(
    ex.eventLines.map((line) => [`a ${line.kind} event`, ["events.jsonl", line] as const]),
  ),
  "an image anchor detected, with its id": [
    "events.jsonl",
    { t: 50, kind: "image_anchor_detected", detail: "0b4e2d8f-61a7-4c3e-9d25-7f1a8c6e3b90" },
  ],
  "an action": ["actions.jsonl", ex.actionLine],
  "an action that failed": [
    "actions.jsonl",
    { ...ex.actionLine, result: null, error: "ERR_NO_FLOOR_HIT" },
  ],
  "a telemetry line": ["telemetry.jsonl", ex.telemetryLine],
  "a telemetry line with no stage yet": ["telemetry.jsonl", { ...ex.telemetryLine, stage_ms: {} }],
  ...Object.fromEntries(
    ex.boundaryLines.map((line) => [
      `a ${line.kind} boundary line`,
      ["boundary.jsonl", line] as const,
    ]),
  ),
  ...Object.fromEntries(
    ex.meshHistoryLines.map((line) => [
      `a mesh-history ${line.op} line`,
      ["mesh/history.jsonl", line] as const,
    ]),
  ),
  "the final mesh snapshot": [
    "mesh/history.jsonl",
    { ...ex.meshHistoryLines[0], op: "update", final: true },
  ],
  "parts.json": ["parts.json", ex.parts],
  "import.json": ["import.json", ex.importFile],
  "import.json of a lean set, reviewed": [
    "import.json",
    { ...ex.importFile, reviewed_at: "2027-01-12T09:30:00+08:00", recheck: null, deleted: [] },
  ],
};

/** A copy of `document` changed by `change`. */
function variant<T>(document: T, change: (copy: T) => void): T {
  const copy = structuredClone(document);
  change(copy);
  return copy;
}

const invalid: Record<string, readonly [Name, unknown]> = {
  "recording_version 2": ["recording.json", { ...ex.recording, recording_version: 2 }],
  "an unknown field in recording.json": ["recording.json", { ...ex.recording, note: "x" }],
  "an unknown origin": ["recording.json", { ...ex.recording, origin: "phone" }],
  "no profile": [
    "recording.json",
    variant(ex.recording, (r) => {
      delete (r as Partial<typeof r>).profile;
    }),
  ],
  "an uppercase venue id": [
    "recording.json",
    { ...ex.recording, venues: ["36632586-E1FA-4E10-800A-81ACF0EAB09A"] },
  ],
  "a file outside the layout": [
    "recording.json",
    {
      ...ex.recording,
      files: [{ path: "notes.txt", bytes: 1, sha256: ex.recording.files[0]?.sha256 }],
    },
  ],
  "recording.json listing itself": [
    "recording.json",
    {
      ...ex.recording,
      files: [{ path: "recording.json", bytes: 1, sha256: ex.recording.files[0]?.sha256 }],
    },
  ],
  "a candidate as PNG": [
    "recording.json",
    {
      ...ex.recording,
      files: [{ path: "candidates/000001.png", bytes: 1, sha256: ex.recording.files[0]?.sha256 }],
    },
  ],
  "a short git commit": [
    "recording.json",
    { ...ex.recording, build: { ...ex.recording.build, git_commit: "e191db7" } },
  ],
  "a development build": [
    "recording.json",
    { ...ex.recording, build: { ...ex.recording.build, profile: "development" } },
  ],
  "an unknown end reason": [
    "recording.json",
    { ...ex.recording, window: { ...ex.recording.window, ended: "crash" } },
  ],
  "a date-time without an offset": [
    "recording.json",
    { ...ex.recording, session_started_at: "2026-10-20T08:15:02" },
  ],
  "an unknown candidate status": ["frames.jsonl", { ...ex.frameLine, candidate: "dropped:other" }],
  "a timing for a stage that doesn't exist": [
    "frames.jsonl",
    { ...ex.frameLine, ms: { decode: 1 } },
  ],
  "a negative timing": ["frames.jsonl", { ...ex.frameLine, ms: { gate: -1 } }],
  "an extra field in a frame line": ["frames.jsonl", { ...ex.frameLine, keyframe: true }],
  "a frame line without a transform": [
    "frames.jsonl",
    variant(ex.frameLine, (f) => {
      delete (f as Partial<typeof f>).transform;
    }),
  ],
  "a heading of 360": ["motion.jsonl", { ...ex.motionLine, heading: 360 }],
  "a quaternion of three": ["motion.jsonl", { ...ex.motionLine, attitude: [0, 0, 1] }],
  "absolute altitude": ["altitude.jsonl", { ...ex.altitudeLine, altitude_m: 12 }],
  "an unknown anchor kind": ["anchors.jsonl", { ...ex.anchorLine, kind: "plane" }],
  "an unknown event": ["events.jsonl", { t: 1, kind: "crash", detail: null }],
  "an event detail with spaces": [
    "events.jsonl",
    { t: 1, kind: "configuration", detail: "x 1.0 2.0" },
  ],
  "a numeric event detail": ["events.jsonl", { t: 1, kind: "session_failed", detail: 102 }],
  "action args as an object": ["actions.jsonl", { ...ex.actionLine, args: { role: "start" } }],
  "empty action args": ["actions.jsonl", { ...ex.actionLine, args: "" }],
  "action args over 16 KiB": [
    "actions.jsonl",
    { ...ex.actionLine, args: `"${"x".repeat(16_384)}"` },
  ],
  "a capitalised call": ["actions.jsonl", { ...ex.actionLine, call: "MarkAnchor" }],
  "an unknown thermal state": ["telemetry.jsonl", { ...ex.telemetryLine, thermal: "hot" }],
  "a percentile without p95": [
    "telemetry.jsonl",
    { ...ex.telemetryLine, stage_ms: { gate: { p50: 1 } } },
  ],
  "a binary result not named by its seq": [
    "boundary.jsonl",
    { ...ex.boundaryLines[1], binary: "boundary/412.f32" },
  ],
  "a negative mesh-history offset": [
    "mesh/history.jsonl",
    { ...ex.meshHistoryLines[0], offset: -1 },
  ],
  "an empty mesh-history block": ["mesh/history.jsonl", { ...ex.meshHistoryLines[0], bytes: 0 }],
  "a five-digit part name": [
    "parts.json",
    { ...ex.parts, parts: [{ ...ex.parts.parts[0], name: "00000.part" }] },
  ],
  "a part over 16 MiB": [
    "parts.json",
    { ...ex.parts, parts: [{ ...ex.parts.parts[0], bytes: UPLOAD_PART_BYTES + 1 }] },
  ],
  "a deleted file that isn't an image": [
    "import.json",
    {
      ...ex.importFile,
      deleted: [
        { ...ex.importFile.deleted[0], path: `rec-${ex.recording.recording_id}/frames.jsonl` },
      ],
    },
  ],
  "an unknown deletion reason": [
    "import.json",
    { ...ex.importFile, deleted: [{ ...ex.importFile.deleted[0], reason: "manual" }] },
  ],
};

describe("valid recording files", () => {
  test.each(Object.entries(valid))("%s", (_name, [name, document]) => {
    const { valid, errors } = validate(name, document);
    expect(valid, errors).toBe(true);
  });
});

describe("invalid recording files", () => {
  test.each(Object.entries(invalid))("%s", (_name, [name, document]) => {
    expect(validate(name, document).valid).toBe(false);
  });
});

/** The enum of a definition: `file` under schemas/, then a path of property and $defs names. */
function enumOf(file: string, ...path: string[]): unknown {
  let schema: SchemaObject = readSchema(file);
  for (const key of path) {
    const next = (schema["$defs"] as Record<string, SchemaObject> | undefined)?.[key];
    schema = next ?? (schema["properties"] as Record<string, SchemaObject>)[key] ?? {};
  }
  return schema["enum"];
}

describe("constants", () => {
  test("RECORDING_VERSION is the version each versioned file must have", () => {
    for (const file of ["recording.json", "parts.json", "import.json"] as const) {
      const properties = readSchema(FILES[file])["properties"] as Record<string, SchemaObject>;
      expect(properties["recording_version"]?.["const"], file).toBe(RECORDING_VERSION);
    }
  });

  test("the enum lists match the schemas", () => {
    expect(enumOf("recording/defs.schema.json", "profile")).toEqual(RECORDING_PROFILES);
    expect(enumOf("recording/recording.schema.json", "ended")).toEqual(RECORDING_ENDED);
    expect(enumOf("recording/frame-line.schema.json", "candidate")).toEqual(CANDIDATE_STATUSES);
    expect(enumOf("recording/anchor-line.schema.json", "kind")).toEqual(ANCHOR_HISTORY_KINDS);
    expect(enumOf("recording/event-line.schema.json", "kind")).toEqual(RECORDING_EVENT_KINDS);
  });

  test("the limits", () => {
    const { maxJpegBytes, maxPngBytes, maxImagePixels } = DEFAULT_BUNDLE_LIMITS;
    expect(DEFAULT_RECORDING_LIMITS).toMatchObject({ maxJpegBytes, maxPngBytes, maxImagePixels });
    expect(DEFAULT_RECORDING_LIMITS.maxRecordingBytes).toBe(512 * UPLOAD_PART_BYTES);
    const recording = readSchema(FILES["recording.json"])["properties"] as Record<
      string,
      SchemaObject
    >;
    expect(recording["files"]?.["maxItems"]).toBe(DEFAULT_RECORDING_LIMITS.maxEntries);
    const parts = readSchema(FILES["parts.json"])["properties"] as Record<string, SchemaObject>;
    expect((parts["parts"]?.["maxItems"] as number) * UPLOAD_PART_BYTES).toBe(
      DEFAULT_RECORDING_LIMITS.maxRecordingBytes,
    );
  });

  test("the files Swift writes have their own recording schemas", () => {
    for (const file of RECORDING_SWIFT_FILES) expect(FILES[file], file).toMatch(/^recording\//);
  });
});

describe("the doc", () => {
  const layout = /## Layout\n\n```\n([\s\S]*?)```/.exec(DOC)?.[1] ?? "";

  test("lists every file with a schema in its layout", () => {
    for (const file of Object.keys(RECORDING_SCHEMA_FILES)) {
      expect(layout, file).toContain(`  ${file} `);
    }
  });

  test("names every event kind, candidate status and degradation step", () => {
    for (const kind of RECORDING_EVENT_KINDS) expect(DOC, kind).toContain(`\`${kind}\``);
    for (const status of CANDIDATE_STATUSES.filter((s) => !s.startsWith("dropped:"))) {
      expect(DOC, status).toContain(`\`${status}\``);
    }
    for (const status of CANDIDATE_STATUSES.filter((s) => s.startsWith("dropped:"))) {
      expect(DOC, status).toContain(`\`${status.slice("dropped:".length)}\``);
    }
    for (const step of DEGRADATION_STEPS) expect(DOC, step).toContain(`\`${step}\``);
    for (const reason of RECORDING_ENDED) expect(DOC, reason).toContain(`\`${reason}\``);
  });

  test("says recording_version 1", () => {
    expect(DOC).toContain(`This is \`recording_version\` ${RECORDING_VERSION}.`);
  });
});
