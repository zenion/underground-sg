// The recording layout (docs/session-recording.md, "Layout") and the replay set's top-level
// directories. Files outside the layout are rejected.

import { FRAME_NAME_DIGITS } from "../capture-bundle.ts";
import type { RecordingJsonPath } from "../recording.ts";

/** A recording directory name; the recording_id is the first group. */
export const RECORDING_DIRECTORY_PATTERN =
  /^rec-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Files every recording has (mesh/history.* and the profile's files are checked apart). */
export const RECORDING_REQUIRED_FILES = [
  "recording.json",
  "frames.jsonl",
  "imu.jsonl",
  "motion.jsonl",
  "anchors.jsonl",
  "events.jsonl",
  "actions.jsonl",
  "telemetry.jsonl",
  "boundary.jsonl",
] as const;

/** Directories inside the recording directory. Nothing is nested deeper. */
export const RECORDING_LAYOUT_DIRECTORIES = [
  "boundary",
  "mesh",
  "candidates",
  "depth",
  "confidence",
  "privacy",
] as const;

export type RecordingJsonlPath = Exclude<RecordingJsonPath, "recording.json">;

const JSONL_PATHS: readonly RecordingJsonlPath[] = [
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
  "mesh/history.jsonl",
  "privacy/blur.jsonl",
];

/** The sample streams, whose `t` strictly increases; in the other files it never decreases. */
export const SAMPLE_STREAMS: readonly RecordingJsonlPath[] = [
  "frames.jsonl",
  "imu.jsonl",
  "motion.jsonl",
  "altitude.jsonl",
  "telemetry.jsonl",
  "location.jsonl",
];

/** Directories that hold one file per kept candidate, and each one's file extension. */
export const CANDIDATE_DIRECTORIES = {
  candidates: "jpg",
  depth: "png",
  confidence: "png",
} as const;

export type CandidateDirectory = keyof typeof CANDIDATE_DIRECTORIES;

/** What a path in the recording layout holds. */
export type RecordingEntry =
  | { readonly kind: "manifest" }
  | { readonly kind: "jsonl"; readonly path: RecordingJsonlPath }
  | { readonly kind: "binary"; readonly seq: number }
  | { readonly kind: "mesh_bin" }
  | { readonly kind: "candidate"; readonly directory: CandidateDirectory; readonly frame: number };

const DIGITS = `[0-9]{${FRAME_NAME_DIGITS}}`;
const BINARY_PATTERN = new RegExp(`^boundary/(${DIGITS})\\.f32$`);
const CANDIDATE_PATTERN = new RegExp(`^(candidates|depth|confidence)/(${DIGITS})\\.(jpg|png)$`);

/** A frame index or seq as a file name: 58 is 000058. */
export function sixDigits(value: number): string {
  return String(value).padStart(FRAME_NAME_DIGITS, "0");
}

/** The path of a boundary line's binary result: boundary/000412.f32 for seq 412. */
export function binaryPath(seq: number): string {
  return `boundary/${sixDigits(seq)}.f32`;
}

/** The path of a candidate's file: candidatePath("depth", 58) is depth/000058.png. */
export function candidatePath(directory: CandidateDirectory, frame: number): string {
  return `${directory}/${sixDigits(frame)}.${CANDIDATE_DIRECTORIES[directory]}`;
}

/** What a path relative to the recording directory holds, or null if it is outside the layout. */
export function classifyRecordingPath(path: string): RecordingEntry | null {
  if (path === "recording.json") return { kind: "manifest" };
  const jsonl = JSONL_PATHS.find((candidate) => candidate === path);
  if (jsonl !== undefined) return { kind: "jsonl", path: jsonl };
  if (path === "mesh/history.bin") return { kind: "mesh_bin" };
  const binary = BINARY_PATTERN.exec(path);
  if (binary !== null) return { kind: "binary", seq: Number(binary[1]) };
  const candidate = CANDIDATE_PATTERN.exec(path);
  if (candidate !== null) {
    const directory = candidate[1] as CandidateDirectory;
    if (candidate[3] !== CANDIDATE_DIRECTORIES[directory]) return null;
    return { kind: "candidate", directory, frame: Number(candidate[2]) };
  }
  return null;
}
