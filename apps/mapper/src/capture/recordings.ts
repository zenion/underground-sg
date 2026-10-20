// How the Recordings screen words the phone's recordings (the lean recorder design, sections 9
// and 10): ids, sizes, durations and ages in days only, never a date or a time of day; which
// actions each one allows; the export's progress; and the runbook for copying an export to the
// PC with the Apple Devices app. Pure, so Vitest covers it in Node.

import type {
  BuildProfile,
  ExportProgress,
  RecordingListState,
  RecordingSummary,
} from "../../modules/capture-native/src/types.ts";
import type { Tone } from "../ui.tsx";
import { CORRIDOR_VENUES } from "../walk/venues.ts";
import { type FigureRow, formatBytes, formatDuration } from "./figures.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isRecordingId(id: string): boolean {
  return UUID.test(id);
}

const STATE_TEXT: Record<RecordingListState, { readonly text: string; readonly tone: Tone }> = {
  open: { text: "Recording now", tone: "warn" },
  needs_recovery: { text: "Needs recovery (reopen the app)", tone: "warn" },
  closed: { text: "Closed, not exported", tone: "normal" },
  recovered: { text: "Recovered (cut back), not exported", tone: "warn" },
  exported: { text: "Exported", tone: "good" },
};

export function describeRecordingState(state: RecordingListState): {
  readonly text: string;
  readonly tone: Tone;
} {
  return STATE_TEXT[state];
}

/** "today", "1 day", "12 days". */
export function describeAge(ageDays: number): string {
  if (!Number.isFinite(ageDays) || ageDays < 1) return "today";
  const days = Math.floor(ageDays);
  return days === 1 ? "1 day" : `${days} days`;
}

/** The venues' names from the corridor list; an id the app doesn't know counts as "other". */
export function describeVenues(ids: readonly string[]): string {
  if (ids.length === 0) return "none";
  let others = 0;
  const names: string[] = [];
  for (const id of ids) {
    const venue = CORRIDOR_VENUES.find((item) => item.id === id);
    if (venue) names.push(venue.name);
    else others++;
  }
  if (others > 0) names.push(others === 1 ? "1 other" : `${others} others`);
  return names.join(", ");
}

/** The rows of one recording's card: counts, sizes, a duration and an age. */
export function recordingRows(summary: RecordingSummary): FigureRow[] {
  const ended =
    summary.ended === null ? "—" : summary.trimmed ? `${summary.ended}, cut back` : summary.ended;
  const rows: FigureRow[] = [
    { label: "Kind", value: `${summary.profile}, ${summary.origin}` },
    { label: "Ended", value: ended },
    {
      label: "Length",
      value: summary.durationS === null ? "—" : formatDuration(summary.durationS),
    },
    { label: "Size", value: `${formatBytes(summary.bytes)} in ${summary.files} files` },
    { label: "Age", value: describeAge(summary.ageDays) },
    { label: "Venues", value: describeVenues(summary.venues) },
  ];
  if (summary.exportParts !== null) {
    rows.push({ label: "Export", value: `${summary.exportParts} parts in exports` });
  }
  return rows;
}

/**
 * Whether Export is offered: only the walk build exports (design section 11), and only a recording
 * the recorder closed or recovery finished, that isn't exported yet.
 */
export function canExport(summary: RecordingSummary, profile: BuildProfile | null): boolean {
  return profile === "walk" && (summary.state === "closed" || summary.state === "recovered");
}

/** Whether Delete is offered: never for the recording being made. */
export function canDelete(summary: RecordingSummary): boolean {
  return summary.state !== "open";
}

/** 0 to 100, whole. */
export function exportPercent(progress: ExportProgress | null): number {
  if (!progress || !(progress.bytesTotal > 0)) return 0;
  const percent = Math.floor((progress.bytesDone / progress.bytesTotal) * 100);
  return Math.min(100, Math.max(0, percent));
}

/** Where the export goes on the PC, in the repo (git-ignored). */
export function holdingFolder(id: string): string {
  return `.data/holding/${isRecordingId(id) ? id : "<recording id>"}/`;
}

/** Folders an export must never be saved into on the PC: they are synced or backed up. */
export const NEVER_SAVE_INTO: readonly string[] = Object.freeze([
  "Downloads",
  "Documents",
  "Desktop",
  "a OneDrive folder",
]);

/**
 * The Apple Devices runbook (ADR 0010; design section 10): from the phone's exports folder
 * straight into the repo's git-ignored holding folder, then validated and deleted.
 */
export function exportRunbook(id: string | null): readonly string[] {
  const folder = holdingFolder(id ?? "");
  const replay = id && isRecordingId(id) ? `replay-${id}` : "replay-<recording id>";
  return [
    "Export the recording here first. Export one at a time, so the exports folder holds only it.",
    "Connect the iPhone to the PC by USB and unlock it. Open the Apple Devices app, select the iPhone, then Files, then Underground SG Mapper.",
    `In Explorer, create ${folder} in the repo (the folder the PC's checkout is in).`,
    `Drag exports (it holds ${replay}) from Apple Devices straight into ${folder}. Save nowhere else: never ${NEVER_SAVE_INTO.join(", ")}, which are synced or backed up.`,
    `On the PC, check it: node packages/contracts/src/recording-validator/cli.ts --parts ${folder}exports/${replay}`,
    "Only once that passes, delete the recording here (Delete), so the phone's copy is gone too.",
  ];
}
