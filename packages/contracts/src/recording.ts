// Constants for the session recording format (docs/session-recording.md, ADR 0010).
// Environment-neutral: the mapper app (Hermes), the PC's recording tools and the code generator
// import this file.

import type {
  AnchorHistoryKind,
  CandidateStatus,
  MotionReferenceFrame,
  RecordingEnded,
  RecordingEventKind,
  RecordingProfile,
} from "./generated/contracts.ts";

/** The session recording format version this package describes (`recording_version`). */
export const RECORDING_VERSION = 1;

/** The schema file with the definitions the other recording schemas share. */
export const RECORDING_DEFS_SCHEMA_FILE = "defs.schema.json";

/**
 * The schema for each JSON file in a recording, keyed by its path in `rec-<recording_id>/`, as a
 * path under `schemas/`. For a `.jsonl` file the schema describes one line. `imu.jsonl`,
 * `location.jsonl` and `privacy/blur.jsonl` reuse the capture bundle's line schemas.
 */
export const RECORDING_SCHEMA_FILES = {
  "recording.json": "recording/recording.schema.json",
  "frames.jsonl": "recording/frame-line.schema.json",
  "imu.jsonl": "capture-bundle/imu-line.schema.json",
  "motion.jsonl": "recording/motion-line.schema.json",
  "altitude.jsonl": "recording/altitude-line.schema.json",
  "anchors.jsonl": "recording/anchor-line.schema.json",
  "events.jsonl": "recording/event-line.schema.json",
  "actions.jsonl": "recording/action-line.schema.json",
  "telemetry.jsonl": "recording/telemetry-line.schema.json",
  "location.jsonl": "capture-bundle/gnss-line.schema.json",
  "boundary.jsonl": "recording/boundary-line.schema.json",
  "mesh/history.jsonl": "recording/mesh-history-line.schema.json",
  "privacy/blur.jsonl": "capture-bundle/blur-line.schema.json",
} as const;

/** A JSON or JSONL file of a recording that has a schema. */
export type RecordingJsonPath = keyof typeof RECORDING_SCHEMA_FILES;

/**
 * The files around a recording: `parts.json` beside an export's parts on the phone, and
 * `import.json` beside an imported set on the PC. Paths under `schemas/`.
 */
export const RECORDING_SET_SCHEMA_FILES = {
  "parts.json": "recording/parts.schema.json",
  "import.json": "recording/import.schema.json",
} as const;

/**
 * The recording files the Swift recorder writes with its own types (`pnpm gen` writes them to the
 * generated Swift). `imu.jsonl`, `location.jsonl` and `privacy/blur.jsonl` use the capture
 * bundle's types; TypeScript writes `boundary.jsonl`; `import.json` never leaves the PC.
 */
export const RECORDING_SWIFT_FILES = [
  "recording.json",
  "frames.jsonl",
  "motion.jsonl",
  "altitude.jsonl",
  "anchors.jsonl",
  "events.jsonl",
  "actions.jsonl",
  "telemetry.jsonl",
  "mesh/history.jsonl",
  "parts.json",
] as const;

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

export interface RecordingLimits {
  /** The recording directory. */
  readonly maxRecordingBytes: number;
  /**
   * Parts of a replay set's export tar (the recording, the session's bundles and the tar's
   * headers), `UPLOAD_PART_BYTES` each: 4096 parts is 64 GiB, and four-digit part names still
   * fit. `exportRecording` works out the tar's size first and refuses when it would need more.
   */
  readonly maxExportParts: number;
  /** Files and directories in the recording. */
  readonly maxEntries: number;
  /** `window.end_t − window.start_t`, in `lean` and `standard`. */
  readonly maxSessionSeconds: number;
  /** `window.end_t − window.start_t`, in `dense`. */
  readonly maxDenseSessionSeconds: number;
  /** `recording.json`. */
  readonly maxJsonBytes: number;
  /** Each JSONL file. */
  readonly maxJsonlBytes: number;
  /** One JSONL line, without its newline. */
  readonly maxJsonlLineBytes: number;
  /** `mesh/history.bin`. */
  readonly maxMeshHistoryBytes: number;
  /** One mesh-history block, inflated. */
  readonly maxMeshBlockBytes: number;
  /** Each candidate JPEG; as the bundle's keyframes. */
  readonly maxJpegBytes: number;
  /** Each depth or confidence PNG; as the bundle's. */
  readonly maxPngBytes: number;
  /** Pixels in a candidate; as the bundle's keyframes. */
  readonly maxImagePixels: number;
}

/**
 * The recorder's and validate-recording's limits. Provisional: the spike sets them from measured
 * heat, drops and sizes (docs/session-recording.md, "Limits").
 */
export const DEFAULT_RECORDING_LIMITS: RecordingLimits = Object.freeze({
  maxRecordingBytes: 8 * GiB,
  maxExportParts: 4096,
  maxEntries: 60_000,
  maxSessionSeconds: 1_800,
  maxDenseSessionSeconds: 600,
  maxJsonBytes: 16 * MiB,
  maxJsonlBytes: 256 * MiB,
  maxJsonlLineBytes: 64 * KiB,
  maxMeshHistoryBytes: 2 * GiB,
  maxMeshBlockBytes: 64 * MiB,
  maxJpegBytes: 16 * MiB,
  maxPngBytes: 4 * MiB,
  maxImagePixels: 4096 * 4096,
});

export const RECORDING_PROFILES = [
  "lean",
  "standard",
  "dense",
] as const satisfies readonly RecordingProfile[];

/** `window.ended` in recording.json, and the detail of a `recording_closed` event. */
export const RECORDING_ENDED = [
  "end_anchor",
  "stop",
  "idle",
  "background",
  "heat",
  "disk",
  "limit",
  "interrupted",
] as const satisfies readonly RecordingEnded[];

/** `candidate` in frames.jsonl, when the frame is a candidate. */
export const CANDIDATE_STATUSES = [
  "keyframe",
  "kept",
  "dropped:profile",
  "dropped:heat",
  "dropped:backpressure",
  "dropped:disk",
  "dropped:blur",
] as const satisfies readonly CandidateStatus[];

export const ANCHOR_HISTORY_KINDS = [
  "keyframe",
  "image",
  "mesh",
  "marked",
] as const satisfies readonly AnchorHistoryKind[];

export const RECORDING_EVENT_KINDS = [
  "recording_opened",
  "recording_closed",
  "configuration",
  "session_failed",
  "interruption_began",
  "interruption_ended",
  "relocalization_began",
  "relocalization_ended",
  "image_anchor_detected",
  "thermal",
  "memory_warning",
  "background",
  "foreground",
  "screenshot",
  "screen_capture_began",
  "screen_capture_ended",
  "altimeter_unavailable",
  "altimeter_denied",
  "motion_unavailable",
  "degradation",
] as const satisfies readonly RecordingEventKind[];

/** The `detail` of a `degradation` event: the recorder's steps, in order. */
export const DEGRADATION_STEPS = ["fewer_candidates", "no_mesh_history", "no_recording"] as const;

/** `motion.reference_frame` in recording.json: the CMAttitudeReferenceFrame device motion used. */
export const MOTION_REFERENCE_FRAMES = [
  "xArbitraryZVertical",
  "xArbitraryCorrectedZVertical",
  "xMagneticNorthZVertical",
  "xTrueNorthZVertical",
] as const satisfies readonly MotionReferenceFrame[];

/** The reference frames without a north, in which motion.jsonl's `heading` is always null. */
export const ARBITRARY_MOTION_REFERENCE_FRAMES = [
  "xArbitraryZVertical",
  "xArbitraryCorrectedZVertical",
] as const satisfies readonly MotionReferenceFrame[];

/** motion.jsonl's attitude quaternion has a norm within this of 1 (it isn't renormalised). */
export const ATTITUDE_NORM_TOLERANCE = 1e-3;

/**
 * The recorder's plumbing: module calls that never get an actions.jsonl or boundary.jsonl line
 * (appendBoundary's lines are already in boundary.jsonl; the others run outside a session).
 */
export const RECORDING_PLUMBING_CALLS = [
  "appendBoundary",
  "listRecordings",
  "exportRecording",
  "deleteRecording",
] as const;

/** The closes that take a final sample, all of whose lines are at `window.end_t`. */
export const FINAL_SAMPLE_ENDS = [
  "end_anchor",
  "idle",
] as const satisfies readonly RecordingEnded[];

/**
 * What each event kind's `detail` holds (docs/session-recording.md, events.jsonl). The schema
 * allows any short code, so validate-recording checks this, and the Swift recorder writes events
 * from a typed enum that can only produce these. `null`: always null. `ended`: a `window.ended`
 * value. `thermal`: a thermal state. `degradation`: one of `DEGRADATION_STEPS`. `uuid`: a
 * lowercase UUID. `integer`: decimal digits, with an optional minus. `code`: a short lowercase
 * code.
 */
export type EventDetailRule =
  | "null"
  | "ended"
  | "thermal"
  | "degradation"
  | "uuid"
  | "integer"
  | "code";

export const RECORDING_EVENT_DETAILS: Readonly<
  Record<(typeof RECORDING_EVENT_KINDS)[number], EventDetailRule>
> = Object.freeze({
  recording_opened: "null",
  recording_closed: "ended",
  configuration: "code",
  session_failed: "integer",
  interruption_began: "null",
  interruption_ended: "null",
  relocalization_began: "null",
  relocalization_ended: "null",
  image_anchor_detected: "uuid",
  thermal: "thermal",
  memory_warning: "null",
  background: "null",
  foreground: "null",
  screenshot: "null",
  screen_capture_began: "null",
  screen_capture_ended: "null",
  altimeter_unavailable: "null",
  altimeter_denied: "null",
  motion_unavailable: "null",
  degradation: "degradation",
});

/** The thermal states a `thermal` event's detail and telemetry use (ProcessInfo.thermalState). */
export const THERMAL_STATES = ["nominal", "fair", "serious", "critical"] as const;

/**
 * Whether `detail` is what `RECORDING_EVENT_DETAILS` allows for `kind`. For validate-recording;
 * the result says only yes or no, never echoing the value.
 */
export function eventDetailAllowed(
  kind: (typeof RECORDING_EVENT_KINDS)[number],
  detail: string | null,
): boolean {
  const rule = RECORDING_EVENT_DETAILS[kind];
  if (rule === "null") return detail === null;
  if (detail === null) return false;
  switch (rule) {
    case "ended":
      return (RECORDING_ENDED as readonly string[]).includes(detail);
    case "thermal":
      return (THERMAL_STATES as readonly string[]).includes(detail);
    case "degradation":
      return (DEGRADATION_STEPS as readonly string[]).includes(detail);
    case "uuid":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(detail);
    case "integer":
      return /^-?[0-9]{1,10}$/.test(detail);
    case "code":
      return /^[a-z][a-z0-9_]{0,63}$/.test(detail);
  }
}
