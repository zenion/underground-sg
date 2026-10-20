// The debug card's figures (the lean recorder design, section 13): what the module sends in every
// fifth status (`debug`, about once a second), the boundary trace's own counts, and the recovery
// and self-test reports, worded for the screen. Pure, so Vitest covers it in Node.
//
// Counts, rates, sizes, durations and timings only: never a pose, a position, a session time or a
// time of day. The module's figures are a flat record of scalars, so the card shows a known key
// with its unit (FIGURE_SECTIONS), a per-stream key ("stream.<file>.<metric>") in that stream's
// row, and any other key only when its name and value pass the screen below (`Other`). A figure
// that fails is counted as not shown, never printed. Strings are shown only when they are codes
// (`serious`, `no_mesh_history`), or lists of codes for the Documents names, so a clock reading
// ("09:41:07") or a coordinate can't get through as text.

import type {
  DebugFigures,
  RecoveryReport,
  SelfTestReport,
} from "../../modules/capture-native/src/types.ts";
import type { BoundaryTraceFigures } from "./boundary-trace.ts";

export type FigureUnit =
  /** A whole number of things. */
  | "count"
  /** Microseconds, milliseconds: timings of work. */
  | "us"
  | "ms"
  /** A length of time in seconds, shown as m:ss. */
  | "duration"
  /** Per second. */
  | "rate"
  | "fps"
  | "bytes"
  | "kib"
  | "mb"
  | "mbPerMin"
  | "percent"
  /** A state or code: lowercase letters, digits and underscores. */
  | "code"
  /** Codes separated by commas (the Documents names). */
  | "codes"
  | "flag";

export interface FigureSpec {
  readonly key: string;
  readonly label: string;
  readonly unit: FigureUnit;
}

export interface FigureSection {
  readonly title: string;
  readonly specs: readonly FigureSpec[];
}

export interface FigureRow {
  readonly label: string;
  readonly value: string;
}

export interface FormattedSection {
  readonly title: string;
  readonly rows: readonly FigureRow[];
}

export interface FormattedFigures {
  readonly sections: readonly FormattedSection[];
  /** Figures left out: an unknown key or a value that failed the screen. */
  readonly notShown: number;
}

const spec = (key: string, label: string, unit: FigureUnit): FigureSpec => ({ key, label, unit });

/** The keys the module sends, by section (design section 13). The native glue uses these names. */
export const FIGURE_SECTIONS: readonly FigureSection[] = Object.freeze([
  {
    title: "Delegate",
    specs: [
      spec("delegateUsP50", "Frame work p50", "us"),
      spec("delegateUsP95", "Frame work p95", "us"),
      spec("snapshotFrameMs", "Snapshot frame", "ms"),
      spec("frameGaps", "Frame gaps", "count"),
      spec("frameGapLargest", "Largest gap (frames)", "count"),
      spec("fps", "Frame rate", "fps"),
      spec("deliveryLagMs", "Delivery lag", "ms"),
    ],
  },
  {
    title: "Motion",
    specs: [
      spec("imuHz", "IMU samples", "rate"),
      spec("motionHz", "Device motion", "rate"),
      spec("motionLagMs", "Motion lag", "ms"),
      spec("altitudeHz", "Altimeter", "rate"),
    ],
  },
  {
    title: "Recorder",
    specs: [
      spec("recorderState", "State", "code"),
      spec("degradation", "Degradation", "code"),
      spec("windowS", "Window length", "duration"),
      spec("backlogKiB", "Write backlog", "kib"),
      spec("checkpointAgeS", "Checkpoint age", "duration"),
      spec("fsyncMsP95", "fsync p95", "ms"),
      spec("fullSyncMsP95", "Full sync p95", "ms"),
      spec("encodeUsP95", "Encode p95", "us"),
      spec("candidatesDropped", "Candidates dropped", "count"),
    ],
  },
  {
    title: "Mesh",
    specs: [
      spec("meshSnapshots", "Snapshots", "count"),
      spec("meshSnapshotsSkipped", "Skipped (busy)", "count"),
      spec("meshAnchors", "Anchors", "count"),
      spec("meshCopyMsP50", "Copy p50", "ms"),
      spec("meshCopyMsP95", "Copy p95", "ms"),
      spec("meshCollectMsP50", "Collect p50", "ms"),
      spec("meshCollectMsP95", "Collect p95", "ms"),
      spec("meshDeflateMsP50", "Deflate p50", "ms"),
      spec("meshDeflateMsP95", "Deflate p95", "ms"),
      spec("meshBlocksWritten", "Blocks written", "count"),
      spec("meshBlocksReused", "Blocks reused", "count"),
      spec("meshBlocksSkipped", "Blocks skipped", "count"),
      spec("meshRawMB", "Raw", "mb"),
      spec("meshCompressedMB", "Compressed", "mb"),
      spec("finalSnapshotMs", "Final snapshot", "ms"),
      spec("finalizeMs", "Finalize", "ms"),
    ],
  },
  {
    title: "GNSS",
    specs: [
      spec("gnssState", "State", "code"),
      spec("gnssBuffered", "Buffered (count)", "count"),
      spec("gnssWritten", "Written (count)", "count"),
      spec("gnssAuthorization", "Authorisation", "code"),
    ],
  },
  {
    title: "Device",
    specs: [
      spec("thermal", "Thermal", "code"),
      spec("toFairS", "Time to fair", "duration"),
      spec("toSeriousS", "Time to serious", "duration"),
      spec("memoryMB", "Memory", "mb"),
      spec("memoryPeakMB", "Memory peak", "mb"),
      spec("cpuPercent", "CPU", "percent"),
      spec("freeDiskBytes", "Free disk", "bytes"),
      spec("lowPowerMode", "Low Power Mode", "flag"),
      spec("framesProtection", "frames.jsonl protection", "code"),
      spec("documentsNames", "Documents holds", "codes"),
    ],
  },
]);

/** The recording's files, in the order the streams section lists them (session-recording.md). */
export const STREAMS: readonly string[] = Object.freeze([
  "frames",
  "imu",
  "motion",
  "altitude",
  "anchors",
  "events",
  "actions",
  "telemetry",
  "location",
  "boundary",
  "mesh_index",
  "mesh_bin",
]);

/** The per-stream metrics: `stream.<file>.<metric>`. */
export const STREAM_METRICS: readonly FigureSpec[] = Object.freeze([
  spec("bytes", "size", "bytes"),
  spec("mbPerMin", "rate", "mbPerMin"),
  spec("linesPerS", "lines", "rate"),
  spec("dropsOutside", "outside the window", "count"),
  spec("dropsOrder", "out of order", "count"),
  spec("dropsLong", "too long", "count"),
  spec("dropsBackpressure", "backpressure", "count"),
]);

const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const KEY = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

/**
 * Words an unknown key may not have: poses and places, and clocks. An unknown figure named like
 * one is never shown, whatever its value.
 */
const REFUSED_KEY_WORDS: ReadonlySet<string> = new Set([
  "transform",
  "pose",
  "camera",
  "hit",
  "position",
  "point",
  "lat",
  "lon",
  "lng",
  "latitude",
  "longitude",
  "heading",
  "facing",
  "fix",
  "fixes",
  "gnss",
  "location",
  "altitude",
  "x",
  "y",
  "z",
  "t",
  "at",
  "time",
  "date",
  "clock",
  "wall",
  "timestamp",
  "epoch",
  "uptime",
  "now",
]);

/** The words of a key: camelCase, snake_case and dotted parts, lowercased. */
export function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.replace(/\d+$/, "").toLowerCase())
    .filter((word) => word !== "");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function fixed(value: number, digits: number): string {
  return value.toFixed(digits);
}

/** "0:42", "12:05", "1:02:03". Negative or non-finite values give "—". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const whole = Math.floor(seconds);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "512 B", "3.4 KB", "12.0 MB", "1.25 GB" (powers of 1024). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${fixed(value, value < 10 ? 2 : 1)} ${units[unit]}`;
}

function formatRate(perSecond: number): string {
  return `${fixed(perSecond, perSecond < 10 ? 1 : 0)}/s`;
}

/** A figure's value in its unit, or null when the value doesn't fit the unit (not shown). */
export function formatFigure(value: unknown, unit: FigureUnit): string | null {
  if (value === null || value === undefined) return unit === "code" ? "none" : "—";
  switch (unit) {
    case "code":
      return typeof value === "string" && CODE.test(value) ? value : null;
    case "codes": {
      if (typeof value !== "string") return null;
      if (value === "") return "nothing";
      const names = value.split(",");
      return names.every((name) => CODE.test(name)) ? names.join(", ") : null;
    }
    case "flag":
      return typeof value === "boolean" ? (value ? "Yes" : "No") : null;
    default:
      break;
  }
  if (!isFiniteNumber(value)) return null;
  switch (unit) {
    case "count":
      return Number.isInteger(value) && value >= 0 ? String(value) : null;
    case "us":
      return `${fixed(value, value < 10 ? 1 : 0)} µs`;
    case "ms":
      return `${fixed(value, value < 10 ? 1 : 0)} ms`;
    case "duration":
      return formatDuration(value);
    case "rate":
      return formatRate(value);
    case "fps":
      return `${fixed(value, 0)} fps`;
    case "bytes":
      return formatBytes(value);
    case "kib":
      return `${fixed(value, 0)} KiB`;
    case "mb":
      return `${fixed(value, value < 10 ? 1 : 0)} MB`;
    case "mbPerMin":
      return `${fixed(value, 1)} MB/min`;
    case "percent":
      return `${fixed(value, 0)} %`;
  }
}

/** An unknown figure's value: a number, a flag or a code, else null. */
function formatOther(value: unknown): string | null {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return CODE.test(value) ? value : null;
  if (value === null) return "—";
  if (!isFiniteNumber(value)) return null;
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(4)));
}

function otherKeyAllowed(key: string): boolean {
  return KEY.test(key) && !keyWords(key).some((word) => REFUSED_KEY_WORDS.has(word));
}

/** The module's debug figures as the card's sections. Null (none yet) gives no sections. */
export function formatDebugFigures(figures: DebugFigures | null | undefined): FormattedFigures {
  if (!figures) return { sections: [], notShown: 0 };
  let notShown = 0;
  const used = new Set<string>();
  const sections: FormattedSection[] = [];

  for (const section of FIGURE_SECTIONS) {
    const rows: FigureRow[] = [];
    for (const item of section.specs) {
      if (!(item.key in figures)) continue;
      used.add(item.key);
      const value = formatFigure(figures[item.key], item.unit);
      if (value === null) notShown++;
      else rows.push({ label: item.label, value });
    }
    if (rows.length > 0) sections.push({ title: section.title, rows });
  }

  const streamRows: FigureRow[] = [];
  for (const stream of STREAMS) {
    const parts: string[] = [];
    const drops: string[] = [];
    let present = false;
    for (const metric of STREAM_METRICS) {
      const key = `stream.${stream}.${metric.key}`;
      if (!(key in figures)) continue;
      used.add(key);
      present = true;
      const value = formatFigure(figures[key], metric.unit);
      if (value === null) {
        notShown++;
        continue;
      }
      if (metric.key.startsWith("drops")) {
        if (value !== "0") drops.push(`${value} ${metric.label}`);
      } else {
        parts.push(value);
      }
    }
    if (!present) continue;
    parts.push(drops.length === 0 ? "no drops" : `dropped ${drops.join(", ")}`);
    streamRows.push({ label: stream.replace("_", " "), value: parts.join(" · ") });
  }
  if (streamRows.length > 0) sections.push({ title: "Streams", rows: streamRows });

  const otherRows: FigureRow[] = [];
  for (const key of Object.keys(figures).sort()) {
    if (used.has(key)) continue;
    const value = otherKeyAllowed(key) ? formatOther(figures[key]) : null;
    if (value === null) notShown++;
    else otherRows.push({ label: key, value });
  }
  if (otherRows.length > 0) sections.push({ title: "Other", rows: otherRows });

  return { sections, notShown };
}

/** The boundary trace's counts (src/capture/boundary-trace.ts). */
export function formatTraceFigures(figures: BoundaryTraceFigures): FormattedSection {
  return {
    title: "Boundary trace",
    rows: [
      { label: "Lines sent", value: String(figures.sent) },
      { label: "Batches (failed)", value: `${figures.batches} (${figures.failedBatches})` },
      { label: "Waiting for the open", value: String(figures.buffered) },
      { label: "Dropped before the open", value: String(figures.droppedBeforeOpen) },
      { label: "Dropped after the end", value: String(figures.droppedAfterEnd) },
      { label: "Dropped over the limit", value: String(figures.droppedOverLimit) },
      { label: "Too large", value: String(figures.tooLarge) },
      { label: "Not serializable", value: String(figures.unserializable) },
      { label: "Clamped (out of order)", value: String(figures.clamped) },
      { label: "Refused (no time)", value: String(figures.refused) },
    ],
  };
}

/** What recovery did at launch: counts, or why there is no report. */
export function formatRecoveryReport(report: RecoveryReport | null): FormattedSection {
  if (!report) {
    return { title: "Recovery", rows: [{ label: "Report", value: "None in this build" }] };
  }
  return {
    title: "Recovery",
    rows: [
      { label: "Done", value: report.done ? "Yes" : "Not yet (waiting for unlock)" },
      { label: "Recovered (cut back)", value: String(report.recovered) },
      { label: "Finished from the journal", value: String(report.finished) },
      { label: "Discarded", value: String(report.discarded) },
      { label: "Swept", value: String(report.swept) },
    ],
  };
}

function protectionText(value: string): string {
  return CODE.test(value) || /^[A-Za-z]{1,64}$/.test(value) ? value : "unknown";
}

/** The on-device self-test's report (design D18): results and timings only. */
export function formatSelfTestReport(report: SelfTestReport): FormattedSection {
  const names = report.documentsNames.filter((name) => /^[A-Za-z0-9_.-]{1,64}$/.test(name));
  const documents =
    names.length !== report.documentsNames.length
      ? "unexpected names"
      : names.length === 0
        ? "nothing"
        : names.join(", ");
  return {
    title: report.passed ? "Self-test: passed" : "Self-test: FAILED",
    rows: [
      { label: "Protection while writing", value: protectionText(report.protectionWhileWriting) },
      { label: "Protection after closing", value: protectionText(report.protectionAfterClose) },
      { label: "Excluded from backup", value: report.excludedFromBackup ? "Yes" : "No" },
      { label: "Compression round trip", value: report.compressionMatches ? "Matches" : "Differs" },
      { label: "SHA-256 vectors", value: report.sha256Matches ? "Match" : "Differ" },
      { label: "Encode", value: `${fixed(report.encodeMBps, 0)} MB/s` },
      { label: "Deflate", value: `${fixed(report.deflateMBps, 0)} MB/s` },
      { label: "SHA-256", value: `${fixed(report.sha256MBps, 0)} MB/s` },
      { label: "Documents holds", value: documents },
      { label: "Kept for export", value: report.keptId ?? "No" },
    ],
  };
}

/**
 * Whether the self-test's Documents names are what design section 12 allows: nothing, or only
 * `exports`.
 */
export function documentsAsExpected(names: readonly string[]): boolean {
  return names.every((name) => name === "exports");
}

/**
 * The module's log ring (value-free codes): only lines made of codes, whole numbers and
 * separators. A line with a decimal number or a clock reading ("1.29", "09:41") is not shown.
 */
export function formatLogTail(lines: readonly string[]): { lines: string[]; notShown: number } {
  const shown = lines.filter(
    (line) => /^[A-Za-z0-9_ .,:=/#()-]{1,160}$/.test(line) && !/\d[.:]\d/.test(line),
  );
  return { lines: shown, notShown: lines.length - shown.length };
}
