// How the walk screen words the flow's state (src/walk/flow.ts) and the session's status: the
// REC badge, errors and refusals, how a recording ended, and the summary. Pure, so Vitest covers
// it in Node. Counts and durations only; never a pose or a session time.

import type {
  CaptureErrorCode,
  RecordingEnded,
  RecordRefusal,
} from "../../modules/capture-native/src/types.ts";
import type { FigureRow } from "../capture/figures.ts";
import { formatDuration } from "../capture/figures.ts";
import type { SessionStatus } from "../capture/native.ts";
import type { ErrorSource, WalkState, WalkSummary } from "./flow.ts";
import { NODE_TAG_ROW } from "./tags.ts";

const REFUSAL_TEXT: Record<RecordRefusal, string> = {
  notCompiled: "the recorder isn't compiled into this build",
  notWalkBuild: "this isn't the walk build",
  debugBuild: "this is a debug build",
  notEmbedded: "the JavaScript isn't embedded (it comes from Metro)",
  devClient: "this is the development client",
  profileUnavailable: "that profile needs the blur, which isn't there yet",
  invalidVenues: "the venues aren't 1 to 50 known ids",
  lowDisk: "less than 16 GB is free",
};

/** "Refused (notWalkBuild): this isn't the walk build". */
export function describeRefusal(refusal: RecordRefusal): string {
  return `Refused (${refusal}): ${REFUSAL_TEXT[refusal]}`;
}

const ERROR_TEXT: Record<CaptureErrorCode, string> = {
  ERR_RECORDER_NOT_COMPILED: "This build has no recorder.",
  ERR_RECORD_REFUSED: "This build won't record.",
  ERR_PROFILE_UNAVAILABLE: "That recording profile isn't available yet.",
  ERR_INVALID_VENUES: "Choose 1 to 50 venues.",
  ERR_NO_SPACE: "Not enough free space on the phone.",
  ERR_RECOVERY_PENDING:
    "Recovery of an earlier recording hasn't finished: unlock the phone and wait.",
  ERR_NO_VIEW: "The camera view isn't ready (no secure canvas, or no session in this build).",
  ERR_NOT_RUNNING: "The session isn't running.",
  ERR_TRACKING: "Tracking isn't normal: move slowly until it is, then mark again.",
  ERR_NO_FLOOR_HIT: "No floor under the centre of the view: aim at the floor and mark again.",
  ERR_EXPORT_REFUSED: "Export refused.",
  ERR_EXPORT_TOO_LARGE: "Too large to export.",
  ERR_RECORDING_CORRUPT: "The recording's files don't match their hashes; the raw files are kept.",
  ERR_RECORDING_BUSY: "The recording is busy (being written or exported).",
  ERR_IO: "A file error on the phone.",
};

const SOURCE_TEXT: Record<ErrorSource, string> = {
  start: "Start",
  markAnchor: "The mark",
  addTag: "The tag",
  stop: "Stop",
  permissions: "The permission request",
  recorder: "The recorder",
};

/** What the screen says about the flow's error: where it came from, its code and what to do. */
export function describeWalkError(
  error: NonNullable<WalkState["error"]>,
  refusal: RecordRefusal | null,
): string {
  const where = SOURCE_TEXT[error.source];
  if (error.code === null) return `${where} failed.`;
  if (error.code === "ERR_RECORD_REFUSED" && refusal) {
    return `${where} failed: ${describeRefusal(refusal)}.`;
  }
  return `${where} failed (${error.code}). ${ERROR_TEXT[error.code]}`;
}

const ENDED_TEXT: Record<RecordingEnded, string> = {
  end_anchor: "at the end mark",
  idle: "idle (no movement)",
  stop: "Stop, cut back to the last end mark",
  background: "the app went to the background",
  heat: "the phone got too hot",
  disk: "the disk filled up",
  limit: "a size or length limit",
  interrupted: "cut off, recovered at launch",
};

export function describeEnded(ended: RecordingEnded | null): string {
  return ended === null ? "—" : ENDED_TEXT[ended];
}

export interface RecBadge {
  readonly visible: boolean;
  readonly text: string;
}

/**
 * The REC badge over the camera: shown while the recording window is open, closing or being
 * saved, from the flow's state or the latest status, whichever says so.
 */
export function recBadge(state: WalkState, status: SessionStatus | null): RecBadge {
  const recorder = status?.recorder.state;
  const phase = state.recording.phase;
  const closing = phase === "closing" || recorder === "closing";
  const saving = phase === "finalizing" || recorder === "finalizing";
  const open = phase === "open" || recorder === "open";
  if (!closing && !saving && !open) return { visible: false, text: "" };
  if (saving) return { visible: true, text: "REC · saving" };
  if (closing) {
    const left = status?.recorder.closingInS;
    return {
      visible: true,
      text:
        typeof left === "number"
          ? `REC · closing in ${Math.max(0, Math.ceil(left))} s`
          : "REC · closing",
    };
  }
  return { visible: true, text: `REC ${formatDuration(state.recordingS)}` };
}

/** The summary's rows: counts and durations. */
export function summaryRows(summary: WalkSummary): FigureRow[] {
  const rows: FigureRow[] = [
    { label: "Session", value: formatDuration(summary.sessionS) },
    { label: "Recording window", value: formatDuration(summary.recordingS) },
    { label: "Start marks", value: String(summary.startMarks) },
    { label: "End marks", value: String(summary.endMarks) },
    { label: "Tags", value: String(summary.tags) },
  ];
  for (const button of NODE_TAG_ROW) {
    const count = summary.tagsByKind[button.kind];
    if (count) rows.push({ label: `  ${button.label}`, value: String(count) });
  }
  const recording = summary.recording;
  switch (recording.phase) {
    case "none":
    case "armed":
      rows.push({ label: "Recording", value: "None (no start mark, or record off)" });
      break;
    case "discarded":
      rows.push({ label: "Recording", value: "Discarded (no end mark)" });
      break;
    case "failed":
      rows.push({ label: "Recording", value: "Failed" });
      break;
    case "closed":
      rows.push({ label: "Recording", value: recording.closed === false ? "Cut off" : "Saved" });
      rows.push({ label: "Ended", value: describeEnded(recording.ended) });
      if (recording.trimmed) rows.push({ label: "Cut back", value: "Yes" });
      break;
    case "open":
    case "closing":
    case "finalizing":
      rows.push({ label: "Recording", value: "Still saving" });
      break;
  }
  return rows;
}
