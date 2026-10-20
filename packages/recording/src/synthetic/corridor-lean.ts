// The corridor-lean synthetic replay set: one lean recording of a walk along a synthetic stand-in
// for the Exit F link, with no bundles (a lean recording made before the blur passes has none).
// Everything is generated: the mesh is @usg/floorplan's synthetic corridor, the sensor streams
// follow the walk in walk.ts, and noise comes from seeded PRNGs, so the files are the same bytes
// on every run and platform. The only real-world values are the GNSS fixes in location.jsonl,
// near the public street door of Esplanade MRT's Exit F; the session frame has no georeference.

import type {
  ActionLine,
  AltitudeLine,
  AnchorHistoryLine,
  BoundaryLine,
  GnssLine,
  ImuLine,
  MeshHistoryLine,
  MotionLine,
  RecordingEventLine,
  RecordingFrameLine,
  RecordingManifest,
  TelemetryLine,
  Transform,
} from "@usg/contracts";
import { prng } from "@usg/floorplan/synthetic";
import { deflateRaw } from "../deflate.ts";
import { concat, float32Bytes, jsonDocument, jsonLines, round } from "../encode.ts";
import {
  blockBytes,
  chunkGeometry,
  corridorChunks,
  floorTriangles,
  type MeshChunk,
  phantomChunk,
  scannedCount,
} from "./mesh.ts";
import { CORRIDOR_LEAN } from "./sets.ts";
import {
  cameraHeight,
  cameraTransform,
  cameraX,
  END_MARK_T,
  END_T,
  FPS,
  Frame,
  floorY,
  headingWobbleDeg,
  PATH_FROM_X,
  PATH_TO_X,
  PATH_Z,
  START_T,
  walkAcceleration,
  walking,
  walkRotation,
} from "./walk.ts";

/** Esplanade MRT's id in the seed (db/seed/core-venues.ts), fixed for good. */
export const ESPLANADE_MRT_VENUE = "36632586-e1fa-4e10-800a-81acf0eab09a";

/**
 * Exit F's street door, approximately: public geometry, from the station's published position and
 * the South Beach link. Replace with LTA's MRT Station Exit data once it is imported.
 */
export const EXIT_F_DOOR = { lat: 1.2945, lon: 103.8559 } as const;
/** The walk's bearing from the door into the link, degrees clockwise from north. */
const WALK_BEARING_DEG = 215;

/** The synthetic floor plan's rotation (the walk's frame must match the mesh's). */
const ANGLE_RAD = 0.6;
/** The seed of every noise stream; each file adds its own offset. */
const SEED = 20261021;
/** A dropped ARFrame, for one `gap` line. */
const SKIPPED_SLOT = 1500;
/** The ramp's quick turn: tracking is limited for these slots. */
const LIMITED_SLOTS = [480, 498] as const;
/** Mesh snapshots: at open, then every 5 s; the final one is at END_T. */
const SNAPSHOT_TIMES = [4, 9, 14, 19, 24, 29, 34, 39] as const;
/** ARKit refines one anchor's position at this snapshot (an anchors.jsonl update, no block). */
const MOVE = { t: 19, chunk: "mesh/1-0", dx: 0.003 } as const;
/** The phantom anchor's add and remove snapshots. */
const PHANTOM = { added: 14, removed: 24 } as const;
/** The floor-plan preview right after the end mark. */
const FLOOR_TRIANGLES_T = 36.5;
const THERMAL_FAIR_T = 20;
/** Fixes while the door is still in view of the sky: their accuracy worsens down the ramp. */
const GNSS_ACCURACY_M = [4.7, 4.9, 5.6, 8.1, 13.5, 21.8, 34.2] as const;

/** Makes the set's UUIDs (UUIDv5 from a name) and SHA-256 digests; the node entry provides both. */
export interface SetDigests {
  readonly uuid: (name: string) => string;
  readonly sha256: (bytes: Uint8Array) => string;
}

/** A generated set: files by path under the set's directory. */
export interface SyntheticSet {
  readonly name: string;
  readonly recordingId: string;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

const r3 = (v: number): number => round(v, 3);
const r6 = (v: number): number => round(v, 6);

function slotTime(slot: number): number {
  return r6(slot / FPS);
}

function translation(origin: readonly [number, number, number]): Transform {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, origin[0], origin[1], origin[2], 1];
}

/** Uniform noise in [-amplitude, amplitude). */
function noise(random: () => number, amplitude: number): number {
  return (random() * 2 - 1) * amplitude;
}

function trackingAt(slot: number): string {
  return slot >= LIMITED_SLOTS[0] && slot < LIMITED_SLOTS[1] ? "limited:excessiveMotion" : "normal";
}

/** Whether the frame in `slot` is a candidate: the gate's 5 Hz while walking, and forced marks. */
function isCandidate(slot: number): boolean {
  const t = slot / FPS;
  if (trackingAt(slot) !== "normal") return false;
  if (slot === START_T * FPS || slot === END_MARK_T * FPS) return true;
  return walking(t) && slot % 12 === 0;
}

/** The session frame index of the ARFrame in `slot`: one fewer after the dropped one. */
function frameOf(slot: number): number {
  return slot > SKIPPED_SLOT ? slot - 1 : slot;
}

/** Every slot in the window, the dropped one left out, with its session frame index. */
function frameSlots(): { slot: number; frame: number }[] {
  const slots: { slot: number; frame: number }[] = [];
  for (let slot = START_T * FPS; slot <= END_T * FPS; slot++) {
    if (slot !== SKIPPED_SLOT) slots.push({ slot, frame: frameOf(slot) });
  }
  return slots;
}

function framesFile(frame: Frame): RecordingFrameLine[] {
  const random = prng(SEED + 1);
  let previous = -1;
  return frameSlots().map(({ slot, frame: index }) => {
    const t = slotTime(slot);
    const street = t < 8;
    const gap = previous < 0 ? 0 : slot - previous - 1;
    previous = slot;
    return {
      frame: index,
      t,
      transform: cameraTransform(frame, t),
      intrinsics: [1336.2, 1336.2, 958.4, 721.3],
      tracking: trackingAt(slot),
      mapping: t >= END_MARK_T ? "mapped" : "extending",
      exposure: { duration_s: street ? 0.004 : 0.0167, offset_ev: 0 },
      light: {
        intensity_lm: round((street ? 1600 : 720) + noise(random, 20), 1),
        temperature_k: round((street ? 5600 : 4100) + noise(random, 40), 1),
      },
      gap,
      candidate: isCandidate(slot) ? "dropped:profile" : null,
      sharpness: null,
      ms: { gate: r3(0.012 + 0.01 * random()) },
    };
  });
}

/** Device motion's attitude, gravity and heading: upright in portrait, tilted 10° down. */
function attitude(headingDeg: number): {
  quaternion: [number, number, number, number];
  gravity: [number, number, number];
} {
  const pitch = (80 * Math.PI) / 180;
  const yaw = (-headingDeg * Math.PI) / 180;
  // q = yaw about the vertical z, then pitch about the device's x.
  const [cy, sy] = [Math.cos(yaw / 2), Math.sin(yaw / 2)];
  const [cp, sp] = [Math.cos(pitch / 2), Math.sin(pitch / 2)];
  const g = 9.80665;
  return {
    quaternion: [round(cy * sp, 5), round(sy * sp, 5), round(sy * cp, 5), round(cy * cp, 5)],
    gravity: [0, -g * Math.sin(pitch), -g * Math.cos(pitch)],
  };
}

function motionFiles(): { imu: ImuLine[]; motion: MotionLine[] } {
  const imuRandom = prng(SEED + 2);
  const motionRandom = prng(SEED + 3);
  const imu: ImuLine[] = [];
  const motion: MotionLine[] = [];
  for (let k = START_T * 100; k <= END_T * 100; k++) {
    const t = k / 100;
    const heading = (WALK_BEARING_DEG + headingWobbleDeg(t) + 360) % 360;
    const { quaternion, gravity } = attitude(heading);
    const user = walkAcceleration(t);
    const rotation = walkRotation(t);
    imu.push({
      t: r6(t),
      accel: [0, 1, 2].map((axis) =>
        r3((gravity[axis] as number) + (user[axis] as number) + noise(imuRandom, 0.02)),
      ) as [number, number, number],
      gyro: [0, 1, 2].map((axis) =>
        r3((rotation[axis] as number) + 0.002 + noise(imuRandom, 0.003)),
      ) as [number, number, number],
    });
    // Device motion runs on its own timer, 4 ms behind the IMU, and stays inside the window.
    const mt = (k + 0.4) / 100;
    if (mt > END_T) continue;
    const underground = mt >= 8;
    motion.push({
      t: r6(mt),
      attitude: quaternion,
      gravity: gravity.map((v) => r3(v)) as [number, number, number],
      user_accel: user.map((v) => r3(v + noise(motionRandom, 0.02))) as [number, number, number],
      rotation: rotation.map((v) => r3(v + noise(motionRandom, 0.003))) as [number, number, number],
      magnetic: {
        field: [21.3, -30.6, -18.2].map((v) =>
          round(v + (underground ? 6.5 : 0) + noise(motionRandom, 0.3), 2),
        ) as [number, number, number],
        accuracy: underground ? "medium" : "high",
      },
      heading: round(heading, 2),
    });
  }
  return { imu, motion };
}

function altitudeFile(): AltitudeLine[] {
  const random = prng(SEED + 4);
  const lines: AltitudeLine[] = [];
  const first = START_T + 0.4;
  for (let t = first; t <= END_T; t += 1) {
    const relative = t === first ? 0 : cameraHeight(t) - cameraHeight(first) + noise(random, 0.03);
    lines.push({
      t: r6(t),
      relative_m: round(relative, 2),
      pressure_kpa: r3(100.912 - 0.01183 * relative + noise(random, 0.002)),
    });
  }
  return lines;
}

function locationFile(): GnssLine[] {
  const random = prng(SEED + 5);
  const bearing = (WALK_BEARING_DEG * Math.PI) / 180;
  const metresPerDegree = 111_320;
  return GNSS_ACCURACY_M.map((accuracy, k) => {
    const t = START_T + 0.3 + k;
    const walked = cameraX(t) - PATH_FROM_X;
    const north = walked * Math.cos(bearing) + noise(random, accuracy / 3);
    const east = walked * Math.sin(bearing) + noise(random, accuracy / 3);
    return {
      t: r6(t),
      lat: round(EXIT_F_DOOR.lat + north / metresPerDegree, 6),
      lon: round(
        EXIT_F_DOOR.lon + east / (metresPerDegree * Math.cos((EXIT_F_DOOR.lat * Math.PI) / 180)),
        6,
      ),
      h_accuracy_m: accuracy,
    };
  });
}

function telemetryFile(): TelemetryLine[] {
  const random = prng(SEED + 6);
  const lines: TelemetryLine[] = [];
  for (let t = START_T + 0.5; t <= END_T; t += 1) {
    lines.push({
      t: r6(t),
      thermal: t >= THERMAL_FAIR_T ? "fair" : "nominal",
      memory_mb: round(540 + 4 * (t - START_T) + noise(random, 3), 1),
      cpu: round(128 + noise(random, 12), 1),
      free_disk_mb: Math.round(182_340 - 6 * (t - START_T)),
      queue: 0,
      candidates_blurred: 0,
      candidates_dropped: 0,
      stage_ms: { gate: { p50: r3(0.016 + noise(random, 0.002)), p95: r3(0.024) } },
    });
  }
  return lines;
}

/** A mesh anchor's state as the snapshots go on. */
interface AnchorState {
  readonly id: string;
  origin: [number, number, number];
  /** Triangles in its last block, or null before its first. */
  written: number | null;
}

interface MeshFiles {
  history: MeshHistoryLine[];
  bin: Uint8Array;
  anchors: AnchorHistoryLine[];
}

/** Mesh history and anchors.jsonl, from the snapshots and the final sample. */
function meshFiles(
  chunks: readonly MeshChunk[],
  phantom: MeshChunk,
  marked: { start: AnchorHistoryLine; end: AnchorHistoryLine },
  uuid: (name: string) => string,
): MeshFiles {
  const all = [...chunks, phantom];
  const states = new Map<MeshChunk, AnchorState>(
    all.map((chunk) => [
      chunk,
      {
        id: uuid(`${CORRIDOR_LEAN}/${chunk.name}`),
        origin: [...chunk.origin],
        written: null,
      },
    ]),
  );
  const history: MeshHistoryLine[] = [];
  const anchors: AnchorHistoryLine[] = [];
  const blocks: Uint8Array[] = [];
  let offset = 0;
  const blockCache = new Map<string, Uint8Array>();

  const writeBlock = (
    chunk: MeshChunk,
    state: AnchorState,
    t: number,
    op: "add" | "update",
    final: boolean,
  ): void => {
    const count = scannedCount(chunk, t);
    // The final snapshot reuses the block of an anchor whose geometry hasn't changed.
    const key = `${chunk.name}:${count}`;
    let block = blockCache.get(key);
    const geometry = chunkGeometry(chunk, t, chunk.origin);
    if (block === undefined) {
      block = deflateRaw(blockBytes(geometry));
      blockCache.set(key, block);
    }
    history.push({
      t,
      anchor: state.id,
      op,
      transform: translation(state.origin),
      offset,
      bytes: block.length,
      vertices: geometry.vertices.length / 3,
      faces: geometry.faces.length / 3,
      final,
      capture_id: null,
    });
    blocks.push(block);
    offset += block.length;
    state.written = count;
  };

  const anchorLine = (
    t: number,
    state: AnchorState,
    op: "add" | "update" | "remove",
  ): AnchorHistoryLine => ({
    t,
    anchor: state.id,
    kind: "mesh",
    op,
    transform: op === "remove" ? null : translation(state.origin),
    frame: null,
    final: false,
    capture_id: null,
  });

  for (const t of SNAPSHOT_TIMES) {
    if (t === START_T) anchors.push(marked.start);
    if (t === marked.end.t) anchors.push(marked.end);
    for (const chunk of all) {
      const state = states.get(chunk) as AnchorState;
      if (chunk === phantom) {
        if (t === PHANTOM.added) {
          anchors.push(anchorLine(t, state, "add"));
          writeBlock(chunk, state, t, "add", false);
        } else if (t === PHANTOM.removed) {
          anchors.push(anchorLine(t, state, "remove"));
          history.push({
            t,
            anchor: state.id,
            op: "remove",
            transform: null,
            offset: null,
            bytes: null,
            vertices: null,
            faces: null,
            final: false,
            capture_id: null,
          });
        }
        continue;
      }
      const count = scannedCount(chunk, t);
      if (count === 0) continue;
      if (state.written === null) {
        anchors.push(anchorLine(t, state, "add"));
        writeBlock(chunk, state, t, "add", false);
      } else {
        if (t === MOVE.t && chunk.name === MOVE.chunk) {
          state.origin = [round(state.origin[0] + MOVE.dx, 4), state.origin[1], state.origin[2]];
          anchors.push(anchorLine(t, state, "update"));
        }
        if (count !== state.written) writeBlock(chunk, state, t, "update", false);
      }
    }
  }

  // The final sample at END_T: the marked anchors in anchors.jsonl, every mesh anchor in the
  // history, each reusing its last block's bytes when its geometry hasn't changed.
  for (const line of [marked.start, marked.end]) {
    anchors.push({ ...line, t: END_T, op: "update", final: true });
  }
  for (const chunk of chunks) {
    const state = states.get(chunk) as AnchorState;
    if (state.written !== null) writeBlock(chunk, state, END_T, "update", true);
  }
  return { history, bin: concat(blocks), anchors };
}

/** The status events JavaScript received at about 5 Hz. */
function statusValue(
  t: number,
  frames: number,
  candidates: number,
  meshAnchors: number,
  slot: number,
): string {
  const tracking = trackingAt(slot);
  return JSON.stringify({
    running: true,
    covered: false,
    tracking: tracking === "normal" ? "normal" : "limited",
    ...(tracking === "normal" ? {} : { trackingReason: "excessiveMotion" }),
    mapping: t >= END_MARK_T ? "mapped" : "extending",
    fps: 60,
    candidateHz: walking(t) ? 5 : 0,
    frames,
    candidates,
    meshAnchors,
    thermal: t >= THERMAL_FAIR_T ? "fair" : "nominal",
  });
}

/** Builds the corridor-lean set: rec-<recording_id>/ and every file in it. */
export function corridorLean(digests: SetDigests): SyntheticSet {
  const { uuid, sha256 } = digests;
  const recordingId = uuid(`${CORRIDOR_LEAN}/recording`);
  const frame = new Frame(ANGLE_RAD);
  const chunks = corridorChunks(frame);
  const phantom = phantomChunk(frame);

  const startAnchor = uuid(`${CORRIDOR_LEAN}/marked/start`);
  const endAnchor = uuid(`${CORRIDOR_LEAN}/marked/end`);
  const markedLine = (anchor: string, x: number, t: number): AnchorHistoryLine => {
    const [wx, wz] = frame.toWorld(x, PATH_Z);
    return {
      t,
      anchor,
      kind: "marked",
      op: "add",
      transform: translation([round(wx, 4), round(floorY(x), 4), round(wz, 4)]),
      frame: null,
      final: false,
      capture_id: null,
    };
  };
  const marked = {
    start: markedLine(startAnchor, PATH_FROM_X, START_T),
    // Marked at END_MARK_T; the next snapshot samples it.
    end: markedLine(endAnchor, PATH_TO_X, SNAPSHOT_TIMES[SNAPSHOT_TIMES.length - 1] as number),
  };

  const frames = framesFile(frame);
  const { imu, motion } = motionFiles();
  const mesh = meshFiles(chunks, phantom, marked, uuid);
  const startFrame = START_T * FPS;
  const endFrame = END_MARK_T * FPS;

  const startResult = JSON.stringify({
    anchor: startAnchor,
    frame: frameOf(startFrame),
    window: "opened",
  });
  const endResult = JSON.stringify({
    anchor: endAnchor,
    frame: frameOf(endFrame),
    window: "closing",
  });
  const actions: ActionLine[] = [
    {
      t: START_T,
      call: "markAnchor",
      args: JSON.stringify([{ role: "start", kind: "floor_point", streetFacing: true }]),
      result: startResult,
      error: null,
    },
    {
      t: END_MARK_T,
      call: "markAnchor",
      args: JSON.stringify([
        { role: "end", kind: "floor_point", streetFacing: false, endSessionHere: true },
      ]),
      result: endResult,
      error: null,
    },
    { t: FLOOR_TRIANGLES_T, call: "floorTriangles", args: "[]", result: null, error: null },
  ];

  // What JavaScript received: the recording's state, mark results, status at 5 Hz and the floor
  // triangles for the preview, numbered from 0 at the window's open (D21).
  // Each with its JSON text, or null for the binary floor triangles.
  const received: { t: number; kind: string; value: string | null }[] = [
    { t: START_T, kind: "recording", value: JSON.stringify({ state: "open", startT: START_T }) },
    { t: START_T, kind: "markAnchor", value: startResult },
    { t: END_MARK_T, kind: "markAnchor", value: endResult },
    { t: FLOOR_TRIANGLES_T, kind: "floorTriangles", value: null },
    {
      t: END_T,
      kind: "recording",
      value: JSON.stringify({ state: "closed", ended: "end_anchor" }),
    },
  ];
  const candidateSlots = frameSlots().filter(({ slot }) => isCandidate(slot));
  for (let k = 1; START_T + k / 5 <= END_T; k++) {
    const t = r6(START_T + k / 5);
    const slot = Math.round(t * FPS);
    // ARFrames delivered so far: every slot up to this one but the dropped one.
    const frames = slot >= SKIPPED_SLOT ? slot : slot + 1;
    const candidates = candidateSlots.filter((c) => c.slot <= slot).length;
    const meshAnchors =
      chunks.filter((chunk) => scannedCount(chunk, t) > 0).length +
      (t >= PHANTOM.added && t < PHANTOM.removed ? 1 : 0);
    received.push({
      t,
      kind: "status",
      value: statusValue(t, frames, candidates, meshAnchors, slot),
    });
  }
  // In time order; the sort is stable, so lines at the same t keep the order above.
  received.sort((a, b) => a.t - b.t);
  const binaries = new Map<string, Uint8Array>();
  const boundary: BoundaryLine[] = received.map(({ t, kind, value }, seq) => {
    if (value !== null) return { t, seq, kind, value, binary: null };
    const path = `boundary/${String(seq).padStart(6, "0")}.f32`;
    binaries.set(path, float32Bytes(floorTriangles(chunks, t)));
    return { t, seq, kind, value: null, binary: path };
  });

  const events: RecordingEventLine[] = [
    { t: START_T, kind: "recording_opened", detail: null },
    { t: START_T, kind: "configuration", detail: "lean" },
    { t: START_T, kind: "configuration", detail: "video_1920x1440_60" },
    { t: THERMAL_FAIR_T, kind: "thermal", detail: "fair" },
    { t: END_T, kind: "recording_closed", detail: "end_anchor" },
  ];

  const content = new Map<string, Uint8Array>([
    ["frames.jsonl", jsonLines(frames)],
    ["imu.jsonl", jsonLines(imu)],
    ["motion.jsonl", jsonLines(motion)],
    ["altitude.jsonl", jsonLines(altitudeFile())],
    ["anchors.jsonl", jsonLines(mesh.anchors)],
    ["events.jsonl", jsonLines(events)],
    ["actions.jsonl", jsonLines(actions)],
    ["telemetry.jsonl", jsonLines(telemetryFile())],
    ["location.jsonl", jsonLines(locationFile())],
    ["boundary.jsonl", jsonLines(boundary)],
    ...binaries,
    ["mesh/history.bin", mesh.bin],
    ["mesh/history.jsonl", jsonLines(mesh.history)],
  ]);

  const duration = END_T - START_T;
  const snapshotTimes = [...new Set(mesh.history.map((line) => line.t))];
  const manifest: RecordingManifest = {
    recording_version: 1,
    recording_id: recordingId,
    origin: "synthetic",
    profile: "lean",
    rates: {
      frames_hz: r3(frames.length / duration),
      candidates_hz: r3(frames.filter((line) => line.candidate !== null).length / duration),
      imu_hz: r3(imu.length / duration),
      motion_hz: r3(motion.length / duration),
      mesh_interval_s: r3(
        ((snapshotTimes[snapshotTimes.length - 1] as number) - (snapshotTimes[0] as number)) /
          (snapshotTimes.length - 1),
      ),
    },
    build: { app_version: "0.1.0", git_commit: null, eas_build_id: null, profile: "synthetic" },
    device_model: "iPhone18,2",
    os_version: "iOS 26.7",
    session_started_at: "2026-10-21T09:00:00+08:00",
    clocks: {
      system_uptime_s: 86_400.5,
      media_time_s: 86_400.5,
      wall_clock: "2026-10-21T09:00:00.000+08:00",
    },
    window: { start_t: START_T, end_t: END_T, ended: "end_anchor", trimmed: false },
    arkit: {
      scene_reconstruction: "meshWithClassification",
      frame_semantics: ["smoothedSceneDepth"],
      video_format: { width: 1920, height: 1440, fps: FPS },
      world_alignment: "gravity",
    },
    motion: { reference_frame: "xMagneticNorthZVertical" },
    detector_versions: null,
    venues: [ESPLANADE_MRT_VENUE],
    segments: [],
    closed: true,
    files: [...content.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })),
  };

  const dir = `rec-${recordingId}`;
  const files = new Map<string, Uint8Array>([[`${dir}/recording.json`, jsonDocument(manifest)]]);
  for (const [path, bytes] of content) files.set(`${dir}/${path}`, bytes);
  return { name: CORRIDOR_LEAN, recordingId, files };
}
