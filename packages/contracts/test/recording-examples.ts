// Synthetic examples of every session recording file (docs/session-recording.md), as typed values:
// a lean walk along the Exit G passage. No venue recording; the GNSS fix is at Esplanade MRT,
// public geometry.

import type {
  ActionLine,
  AltitudeLine,
  AnchorHistoryLine,
  BoundaryLine,
  ExportParts,
  MeshHistoryLine,
  MotionLine,
  RecordingEventLine,
  RecordingFrameLine,
  RecordingImport,
  RecordingManifest,
  TelemetryLine,
  Transform,
} from "../src/index.ts";

const ID = "5d0c6f1e-3b7a-4f7e-9c51-2a8e4b6d1f03";
const CAPTURE = "8f9585da-8554-4b8a-ba4e-0f390ccd3802";
const SHA = "3f2a9c4e8b1d7f6a0c5e2b9d4a7f1c8e6b3d0a9f5c2e7b4d1a8f6c3e0b9d2a7f";

/** The camera 6 m down the passage, yawed slightly. */
const pose: Transform = [0.998, 0, 0.0628, 0, 0, 1, 0, 0, -0.0628, 0, 0.998, 0, 0.4, 0.02, -6.1, 1];

export const recording: RecordingManifest = {
  recording_version: 1,
  recording_id: ID,
  origin: "synthetic",
  profile: "lean",
  rates: {
    frames_hz: 59.6,
    candidates_hz: 4.1,
    imu_hz: 99.8,
    motion_hz: 99.8,
    mesh_interval_s: 5.02,
  },
  build: {
    app_version: "0.1.0",
    git_commit: "e191db7c0a4b5d6e7f8091a2b3c4d5e6f7081920",
    eas_build_id: null,
    profile: "synthetic",
  },
  device_model: "iPhone18,2",
  os_version: "iOS 26.7",
  session_started_at: "2026-10-20T08:15:02+08:00",
  clocks: {
    system_uptime_s: 81234.5,
    media_time_s: 81234.5,
    wall_clock: "2026-10-20T08:15:02.104+08:00",
  },
  window: { start_t: 3.2, end_t: 412.8, ended: "end_anchor", trimmed: false },
  arkit: {
    scene_reconstruction: "meshWithClassification",
    frame_semantics: ["smoothedSceneDepth"],
    video_format: { width: 1920, height: 1440, fps: 60 },
    world_alignment: "gravity",
  },
  detector_versions: null,
  venues: ["36632586-e1fa-4e10-800a-81acf0eab09a", "dabbc03c-39d9-4947-8dbc-b2aa0c42e5d2"],
  segments: [],
  closed: true,
  files: [
    "frames.jsonl",
    "imu.jsonl",
    "motion.jsonl",
    "altitude.jsonl",
    "anchors.jsonl",
    "events.jsonl",
    "actions.jsonl",
    "telemetry.jsonl",
    "location.jsonl",
    "boundary.jsonl",
    "boundary/000412.f32",
    "mesh/history.bin",
    "mesh/history.jsonl",
  ].map((path) => ({ path, bytes: 1024, sha256: SHA })),
};

/** recording.json as first written, when the recording opens. */
export const openRecording: RecordingManifest = {
  ...recording,
  rates: null,
  window: { start_t: 3.2, end_t: null, ended: null, trimmed: false },
  closed: false,
  files: [],
};

export const frameLine: RecordingFrameLine = {
  frame: 1203,
  t: 23.415,
  transform: pose,
  intrinsics: [1445.2, 1445.2, 958.4, 721.9],
  tracking: "normal",
  mapping: "extending",
  exposure: { duration_s: 0.0166, offset_ev: 0 },
  light: { intensity_lm: 840.5, temperature_k: 4210 },
  gap: 0,
  candidate: "dropped:profile",
  sharpness: null,
  ms: { gate: 0.02 },
};

export const motionLine: MotionLine = {
  t: 23.418,
  attitude: [0.0123, -0.7012, 0.0087, 0.7128],
  gravity: [0.05, -9.79, -0.52],
  user_accel: [0.12, 0.31, -0.08],
  rotation: [0.01, -0.03, 0.002],
  magnetic: { field: [12.4, -31.2, -18.9], accuracy: "medium" },
  heading: 41.5,
};

export const altitudeLine: AltitudeLine = { t: 23.5, relative_m: -4.82, pressure_kpa: 101.38 };

export const anchorLine: AnchorHistoryLine = {
  t: 25,
  anchor: "0b4e2d8f-61a7-4c3e-9d25-7f1a8c6e3b90",
  kind: "mesh",
  op: "update",
  transform: pose,
  frame: null,
};

export const eventLines: RecordingEventLine[] = [
  { t: 3.2, kind: "recording_opened", detail: null },
  { t: 140.1, kind: "thermal", detail: "fair" },
  { t: 210.4, kind: "session_failed", detail: "102" },
  { t: 412.8, kind: "recording_closed", detail: "end_anchor" },
];

export const actionLine: ActionLine = {
  t: 3.2,
  call: "markAnchor",
  args: '[{"role":"start","kind":"floor_point"}]',
  result: '{"frame":192,"hit":[0.31,-1.42,-0.9],"normal":[0,1,0]}',
  error: null,
};

export const telemetryLine: TelemetryLine = {
  t: 24,
  thermal: "nominal",
  memory_mb: 612.4,
  cpu: 143.2,
  free_disk_mb: 182_340,
  queue: 0,
  candidates_blurred: 0,
  candidates_dropped: 0,
  stage_ms: { gate: { p50: 0.02, p95: 0.05 } },
};

export const boundaryLines: BoundaryLine[] = [
  {
    t: 23.6,
    seq: 411,
    kind: "onStatus",
    value: '{"tracking":"normal","meshAnchors":12}',
    binary: null,
  },
  { t: 412.9, seq: 412, kind: "floorTriangles", value: null, binary: "boundary/000412.f32" },
];

export const meshHistoryLines: MeshHistoryLine[] = [
  {
    t: 25,
    anchor: "0b4e2d8f-61a7-4c3e-9d25-7f1a8c6e3b90",
    op: "add",
    transform: pose,
    offset: 0,
    bytes: 48_211,
    vertices: 3120,
    faces: 5840,
    final: false,
  },
  {
    t: 30,
    anchor: "0b4e2d8f-61a7-4c3e-9d25-7f1a8c6e3b90",
    op: "remove",
    transform: null,
    offset: null,
    bytes: null,
    vertices: null,
    faces: null,
    final: false,
  },
];

export const parts: ExportParts = {
  recording_version: 1,
  recording_id: ID,
  tar_bytes: 16_777_216 + 1_048_576,
  tar_sha256: SHA,
  parts: [
    { name: "0000.part", bytes: 16_777_216, sha256: SHA },
    { name: "0001.part", bytes: 1_048_576, sha256: SHA },
  ],
};

export const importFile: RecordingImport = {
  recording_version: 1,
  recording_id: ID,
  imported_at: "2026-10-20T19:02:11+08:00",
  reviewed_at: null,
  recheck: { detector: "YuNet 2023mar", images_checked: 1520, images_deleted: 1 },
  deleted: [
    {
      path: `capture-${CAPTURE}/keyframes/000812.jpg`,
      frame: 812,
      reason: "recheck",
    },
  ],
};
