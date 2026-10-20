// A synthetic session recording and replay set, generated in code (no recording in git), for the
// validate-recording tests: a one-second lean walk through Esplanade MRT's B1 passage, with
// mesh-history blocks deflated here, a binary boundary result, recording.json's files with real
// sizes and digests, and, for a replay set, the bundle fixture as the session's one segment. The
// only geographic value is a GNSS fix at Esplanade MRT, public geometry.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type {
  ActionLine,
  AltitudeLine,
  AnchorHistoryLine,
  BlurLine,
  BoundaryLine,
  ExportParts,
  GnssLine,
  ImuLine,
  MeshHistoryLine,
  MotionLine,
  RecordingEventLine,
  RecordingFrameLine,
  RecordingManifest,
  TelemetryLine,
  Transform,
} from "../src/index.ts";
import {
  BUNDLE_DIR,
  type BundleFiles,
  bundle,
  concat,
  jpeg,
  jsonl,
  png,
  sha256,
  text,
} from "./bundle-fixture.ts";
import { writeTar } from "./tar-writer.ts";

export const RECORDING_ID = "7c3e9a51-0d24-4b6f-8e17-a95c2d4f0b68";
export const REC_DIR = `rec-${RECORDING_ID}`;
/** The window: the start mark at 2 s, End the session here closing it at 3 s. */
export const START_T = 2;
export const END_T = 3;
/** The kept candidate in a standard recording. */
export const KEPT_FRAME = 125;

const MARK_START = "1f6d2a90-3c45-4e8b-9a71-6b0e5d3c2f14";
const MARK_END = "9b2e7d41-5a68-4c03-8f9d-2e4a1c7b6d05";
const MESH_A = "3a8c1e57-9d02-4f6b-b4e3-7c5d0a2f9e81";
const MESH_B = "c4f07b2d-61e8-4a39-9e5c-0d8b3a6f1e27";

/** Recording files by path inside rec-<recording_id>/, recording.json included. */
export type RecordingFiles = Map<string, Uint8Array>;

export type RecordingManifestWithoutFiles = Omit<RecordingManifest, "files">;

/** One mesh-history line, with its block's geometry for an add or update. */
export interface MeshSnapshot {
  readonly t: number;
  readonly anchor: string;
  readonly op: "add" | "update" | "remove";
  readonly final: boolean;
  /** Vertices (anchor frame) and faces (three indices and a classification). */
  readonly geometry: {
    readonly vertices: readonly (readonly [number, number, number])[];
    readonly faces: readonly (readonly [number, number, number, number])[];
  } | null;
}

export interface RecordingSpec {
  manifest: RecordingManifestWithoutFiles;
  frames: RecordingFrameLine[];
  imu: ImuLine[];
  motion: MotionLine[];
  altitude: AltitudeLine[] | null;
  anchors: AnchorHistoryLine[];
  events: RecordingEventLine[];
  actions: ActionLine[];
  telemetry: TelemetryLine[];
  location: GnssLine[] | null;
  boundary: BoundaryLine[];
  /** boundary/<seq>.f32 contents, by seq. */
  binaries: Map<number, readonly number[]>;
  mesh: MeshSnapshot[] | null;
  /** Kept candidates' frames: each gets a JPEG, a depth PNG and a blur line. */
  candidates: number[];
  blur: BlurLine[] | null;
}

/** Steps along the passage, 0.1 s apart, column-major. */
function cameraPose(step: number): Transform {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.01 * step, 1.4, -0.12 * step, 1];
}

const floorSquare = {
  vertices: [
    [0, 0, 0],
    [1, 0, 0],
    [1, 0, -1],
    [0, 0, -1],
  ],
  faces: [
    [0, 1, 2, 2],
    [0, 2, 3, 2],
  ],
} as const;

const wallPiece = {
  vertices: [
    [0, 0, 0],
    [0, 1, 0],
    [0, 1, -1],
  ],
  faces: [[0, 1, 2, 1]],
} as const;

/** Times from START_T to END_T, `step` apart. */
function times(step: number): number[] {
  const count = Math.round((END_T - START_T) / step);
  return Array.from(
    { length: count + 1 },
    (_, i) => Math.round((START_T + i * step) * 1000) / 1000,
  );
}

/** A lean recording, closed with End the session here; no segments (lean has no bundles). */
export function leanSpec(): RecordingSpec {
  const frameTimes = times(0.1);
  return {
    manifest: {
      recording_version: 1,
      recording_id: RECORDING_ID,
      origin: "synthetic",
      profile: "lean",
      rates: { frames_hz: 11, candidates_hz: 0, imu_hz: 21, motion_hz: 21, mesh_interval_s: 0.5 },
      build: {
        app_version: "0.1.0",
        git_commit: null,
        eas_build_id: null,
        profile: "synthetic",
      },
      device_model: "iPhone18,2",
      os_version: "iOS 26.7",
      session_started_at: "2026-10-21T09:00:00+08:00",
      clocks: {
        system_uptime_s: 5000,
        media_time_s: 5000,
        wall_clock: "2026-10-21T09:00:00.010+08:00",
      },
      window: { start_t: START_T, end_t: END_T, ended: "end_anchor", trimmed: false },
      arkit: {
        scene_reconstruction: "meshWithClassification",
        frame_semantics: ["smoothedSceneDepth"],
        video_format: { width: 16, height: 12, fps: 60 },
        world_alignment: "gravity",
      },
      motion: { reference_frame: "xArbitraryCorrectedZVertical" },
      detector_versions: null,
      venues: ["36632586-e1fa-4e10-800a-81acf0eab09a"],
      segments: [],
      closed: true,
    },
    frames: frameTimes.map((t, i) => ({
      frame: 120 + i,
      t,
      transform: cameraPose(i),
      intrinsics: [12.04, 12.04, 7.99, 6.02],
      tracking: i === 4 ? "limited:excessiveMotion" : "normal",
      mapping: "extending",
      exposure: { duration_s: 0.0166, offset_ev: 0 },
      light: i === 0 ? null : { intensity_lm: 820, temperature_k: 4300 },
      gap: 0,
      candidate: i % 3 === 0 ? "dropped:profile" : null,
      sharpness: null,
      ms: { gate: 0.02 },
    })),
    imu: times(0.05).map((t) => ({ t, accel: [0.12, -9.71, -1.05], gyro: [0.01, -0.03, 0.005] })),
    motion: times(0.05).map((t) => ({
      t,
      attitude: [0.0123, -0.7012, 0.0087, 0.7128],
      gravity: [0.05, -9.79, -0.52],
      user_accel: [0.12, 0.31, -0.08],
      rotation: [0.01, -0.03, 0.002],
      magnetic: { field: [12.4, -31.2, -18.9], accuracy: "medium" },
      heading: null,
    })),
    altitude: [
      { t: 2.1, relative_m: 0, pressure_kpa: 101.38 },
      { t: 2.9, relative_m: -0.02, pressure_kpa: 101.38 },
    ],
    anchors: [
      anchorLine(2, MARK_START, "marked", "add", cameraPose(0), false),
      anchorLine(2, MESH_A, "mesh", "add", cameraPose(0), false),
      anchorLine(2.5, MESH_A, "mesh", "update", cameraPose(1), false),
      anchorLine(2.5, MESH_B, "mesh", "add", cameraPose(2), false),
      anchorLine(2.9, MESH_B, "mesh", "remove", null, false),
      anchorLine(3, MARK_START, "marked", "update", cameraPose(0), true),
      anchorLine(3, MARK_END, "marked", "add", cameraPose(10), true),
    ],
    events: [
      { t: 2, kind: "recording_opened", detail: null },
      { t: 2, kind: "configuration", detail: "lean" },
      { t: 2, kind: "configuration", detail: "video_16x12_60" },
      { t: 2.6, kind: "thermal", detail: "fair" },
      { t: 3, kind: "recording_closed", detail: "end_anchor" },
    ],
    actions: [
      {
        t: 2,
        call: "markAnchor",
        args: '[{"role":"start","kind":"floor_point","streetFacing":true}]',
        result: '{"frame":120,"window":"opened"}',
        error: null,
      },
      {
        t: 2.8,
        call: "markAnchor",
        args: '[{"role":"end","kind":"floor_point","endSessionHere":true}]',
        result: '{"frame":128,"window":"closing"}',
        error: null,
      },
    ],
    telemetry: [
      {
        t: 2.2,
        thermal: "nominal",
        memory_mb: 612.4,
        cpu: 143.2,
        free_disk_mb: 182_340,
        queue: 0,
        candidates_blurred: 0,
        candidates_dropped: 0,
        stage_ms: { gate: { p50: 0.02, p95: 0.05 } },
      },
    ],
    // A street-facing start at Esplanade MRT's Exit G.
    location: [{ t: 2.1, lat: 1.2935, lon: 103.8553, h_accuracy_m: 6.5 }],
    boundary: [
      { t: 2, seq: 0, kind: "recording", value: '{"state":"open"}', binary: null },
      { t: 2.4, seq: 1, kind: "floorTriangles", value: null, binary: "boundary/000001.f32" },
      { t: 2.8, seq: 2, kind: "markAnchor", value: '{"window":"closing"}', binary: null },
    ],
    binaries: new Map([[1, [0, 0, 0, 1, 0, 0, 1, 0, -1]]]),
    mesh: [
      { t: 2, anchor: MESH_A, op: "add", final: false, geometry: floorSquare },
      { t: 2.5, anchor: MESH_A, op: "update", final: false, geometry: floorSquare },
      { t: 2.5, anchor: MESH_B, op: "add", final: false, geometry: wallPiece },
      { t: 2.9, anchor: MESH_B, op: "remove", final: false, geometry: null },
      { t: 3, anchor: MESH_A, op: "update", final: true, geometry: floorSquare },
    ],
    candidates: [],
    blur: null,
  };
}

/** A standard recording: lean plus one kept candidate with its files and blur line. */
export function standardSpec(): RecordingSpec {
  const spec = leanSpec();
  spec.manifest.profile = "standard";
  spec.manifest.detector_versions = {
    face: "VNDetectFaceRectanglesRequest revision 3",
    person_head: "VNDetectHumanRectanglesRequest revision 2",
    screen: "synthetic test detector 0",
  };
  const kept = spec.frames.find((frame) => frame.frame === KEPT_FRAME);
  if (kept !== undefined) {
    kept.candidate = "kept";
    kept.sharpness = 41.5;
  }
  spec.candidates = [KEPT_FRAME];
  spec.blur = [{ frame: KEPT_FRAME, boxes: [{ x: 2, y: 3, w: 4, h: 4, kind: "face" }] }];
  return spec;
}

export function anchorLine(
  t: number,
  anchor: string,
  kind: AnchorHistoryLine["kind"],
  op: AnchorHistoryLine["op"],
  transform: Transform | null,
  final: boolean,
): AnchorHistoryLine {
  return { t, anchor, kind, op, transform, frame: null, final, capture_id: null };
}

/** A mesh block: float32 xyz, then uint32 indices, then uint8 classes, little-endian. */
export function meshBlock(geometry: NonNullable<MeshSnapshot["geometry"]>): Uint8Array {
  const { vertices, faces } = geometry;
  const raw = new Uint8Array(12 * vertices.length + 13 * faces.length);
  const view = new DataView(raw.buffer);
  let at = 0;
  for (const vertex of vertices) {
    for (const coordinate of vertex) {
      view.setFloat32(at, coordinate, true);
      at += 4;
    }
  }
  for (const face of faces) {
    for (let corner = 0; corner < 3; corner++) {
      view.setUint32(at, face[corner] ?? 0, true);
      at += 4;
    }
  }
  for (const face of faces) raw[at++] = face[3];
  return raw;
}

/** mesh/history.bin and mesh/history.jsonl for the snapshots. */
export function meshHistory(snapshots: readonly MeshSnapshot[]): {
  bin: Uint8Array;
  lines: MeshHistoryLine[];
} {
  const blocks: Uint8Array[] = [];
  let offset = 0;
  const lines = snapshots.map((snapshot, i): MeshHistoryLine => {
    const base = { t: snapshot.t, anchor: snapshot.anchor, op: snapshot.op, final: snapshot.final };
    if (snapshot.geometry === null) {
      return {
        ...base,
        transform: null,
        offset: null,
        bytes: null,
        vertices: null,
        faces: null,
        capture_id: null,
      };
    }
    const block = deflateRawSync(meshBlock(snapshot.geometry));
    blocks.push(block);
    const line: MeshHistoryLine = {
      ...base,
      transform: cameraPose(i),
      offset,
      bytes: block.length,
      vertices: snapshot.geometry.vertices.length,
      faces: snapshot.geometry.faces.length,
      capture_id: null,
    };
    offset += block.length;
    return line;
  });
  return { bin: concat(blocks), lines };
}

function float32s(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(4 * values.length);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => {
    view.setFloat32(4 * i, value, true);
  });
  return out;
}

/** The recording's files except recording.json. */
export function contentFiles(spec: RecordingSpec): RecordingFiles {
  const files: RecordingFiles = new Map();
  files.set("frames.jsonl", jsonl(spec.frames));
  files.set("imu.jsonl", jsonl(spec.imu));
  files.set("motion.jsonl", jsonl(spec.motion));
  if (spec.altitude !== null) files.set("altitude.jsonl", jsonl(spec.altitude));
  files.set("anchors.jsonl", jsonl(spec.anchors));
  files.set("events.jsonl", jsonl(spec.events));
  files.set("actions.jsonl", jsonl(spec.actions));
  files.set("telemetry.jsonl", jsonl(spec.telemetry));
  if (spec.location !== null) files.set("location.jsonl", jsonl(spec.location));
  files.set("boundary.jsonl", jsonl(spec.boundary));
  for (const [seq, values] of spec.binaries) {
    files.set(`boundary/${String(seq).padStart(6, "0")}.f32`, float32s(values));
  }
  if (spec.mesh !== null) {
    const { bin, lines } = meshHistory(spec.mesh);
    files.set("mesh/history.bin", bin);
    files.set("mesh/history.jsonl", jsonl(lines));
  }
  const { width, height } = spec.manifest.arkit.video_format;
  for (const frame of spec.candidates) {
    const name = String(frame).padStart(6, "0");
    files.set(`candidates/${name}.jpg`, jpeg(width, height));
    files.set(`depth/${name}.png`, png(256, 192, 16, 1500));
  }
  if (spec.blur !== null) files.set("privacy/blur.jsonl", jsonl(spec.blur));
  return files;
}

/** recording.json's files for `files` (everything but recording.json), sorted by path. */
export function listFiles(files: RecordingFiles): RecordingManifest["files"] {
  return [...files.entries()]
    .filter(([path]) => path !== "recording.json")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) }));
}

/** `files` plus a recording.json that lists them. */
export function withRecordingManifest(
  files: RecordingFiles,
  manifest: RecordingManifestWithoutFiles | Record<string, unknown>,
): RecordingFiles {
  const result: RecordingFiles = new Map(files);
  result.delete("recording.json");
  const document = { ...manifest, files: listFiles(result) };
  result.set("recording.json", text(`${JSON.stringify(document, null, 2)}\n`));
  return result;
}

/** A complete, valid recording from a spec, optionally changed first. */
export function recording(
  spec: RecordingSpec = leanSpec(),
  change?: (spec: RecordingSpec) => void,
): RecordingFiles {
  change?.(spec);
  return withRecordingManifest(contentFiles(spec), spec.manifest);
}

/** `files` with some files replaced (a Uint8Array) or removed (null); the listing is unchanged. */
export function replaced(
  files: RecordingFiles,
  changes: Record<string, Uint8Array | null>,
): RecordingFiles {
  const result: RecordingFiles = new Map(files);
  for (const [path, bytes] of Object.entries(changes)) {
    if (bytes === null) result.delete(path);
    else result.set(path, bytes);
  }
  return result;
}

/** A replay set: a recording whose one segment is the bundle fixture, and that bundle. */
export interface ReplaySet {
  readonly recording: RecordingFiles;
  readonly bundles: Map<string, BundleFiles>;
}

/** The bundle fixture's directory as the session's one kept segment. */
export function replaySet(change?: (spec: RecordingSpec) => void): ReplaySet {
  const bundleFiles = bundle();
  const manifest = bundleFiles.get("manifest.json") ?? new Uint8Array(0);
  const spec = leanSpec();
  spec.manifest.segments = [
    {
      capture_id: BUNDLE_DIR.slice("capture-".length),
      manifest_sha256: sha256(manifest),
      start_t: START_T,
      end_t: END_T,
      frame_offset: 120,
      kept: true,
    },
  ];
  return { recording: recording(spec, change), bundles: new Map([[BUNDLE_DIR, bundleFiles]]) };
}

/** Every file of a set by its name in the set's tar, sorted bytewise as exportRecording writes. */
export function setMembers(set: ReplaySet, top = REC_DIR): [string, Uint8Array][] {
  const members: [string, Uint8Array][] = [];
  for (const [path, bytes] of set.recording) members.push([`${top}/${path}`, bytes]);
  for (const [dir, files] of set.bundles) {
    for (const [path, bytes] of files) members.push([`${dir}/${path}`, bytes]);
  }
  return members.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The set as exportRecording's tar: plain ustar, files only, in bytewise order. */
export function setTar(set: ReplaySet, top = REC_DIR): Uint8Array {
  return writeTar(setMembers(set, top).map(([name, data]) => ({ name, data })));
}

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const parent = mkdtempSync(join(tmpdir(), "usg-recording-"));
  temporaryDirectories.push(parent);
  return parent;
}

function writeFiles(root: string, files: ReadonlyMap<string, Uint8Array>): void {
  mkdirSync(root, { recursive: true });
  for (const [path, bytes] of files) {
    const target = join(root, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}

/** Writes the recording as rec-<recording_id>/ under a new temporary directory; returns its path. */
export function writeRecordingDirectory(files: RecordingFiles, name = REC_DIR): string {
  const root = join(temporaryDirectory(), name);
  writeFiles(root, files);
  return root;
}

/** Writes the set as a replay set directory; returns its path. */
export function writeSetDirectory(set: ReplaySet): string {
  const root = join(temporaryDirectory(), "set");
  writeFiles(join(root, REC_DIR), set.recording);
  for (const [dir, files] of set.bundles) writeFiles(join(root, dir), files);
  return root;
}

/** Writes `bytes` as a file in a new temporary directory; returns its path. */
export function writeTemporaryFile(name: string, bytes: Uint8Array): string {
  const path = join(temporaryDirectory(), name);
  writeFileSync(path, bytes);
  return path;
}

/** parts.json and the parts for a tar, split every `partBytes`, as exportRecording writes them. */
export function exportParts(
  tar: Uint8Array,
  partBytes: number,
  recordingId = RECORDING_ID,
): { parts: ExportParts; files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const parts: ExportParts["parts"] = [];
  for (let at = 0, index = 0; at < tar.length; at += partBytes, index++) {
    const bytes = tar.subarray(at, at + partBytes);
    const name = `${String(index).padStart(4, "0")}.part`;
    files.set(name, bytes);
    parts.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return {
    parts: {
      recording_version: 1,
      recording_id: recordingId,
      tar_bytes: tar.length,
      tar_sha256: sha256(tar),
      parts,
    },
    files,
  };
}

/** Writes an export folder: the parts and parts.json (`document` replaces it when given). */
export function writePartsDirectory(exported: {
  parts: ExportParts | Record<string, unknown>;
  files: Map<string, Uint8Array>;
}): string {
  const root = join(temporaryDirectory(), `replay-${RECORDING_ID}`);
  writeFiles(root, exported.files);
  writeFileSync(join(root, "parts.json"), text(`${JSON.stringify(exported.parts, null, 2)}\n`));
  return root;
}

/** Removes every directory this fixture made in this test file. */
export function removeRecordingDirectories(): void {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
}
