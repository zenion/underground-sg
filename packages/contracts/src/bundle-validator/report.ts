// Problems and the validation report. Every problem has a stable code from PROBLEM_CODES; ingest
// stores `failure_reason` from the report and tools may match on codes, so never rename a code.
//
// Messages name files, line numbers and frame indices, never values from poses, IMU samples,
// timestamps or GNSS fixes: those are the contributor's personal data, and reports are stored
// and logged.

export type Severity = "error" | "warning";

export interface CodeInfo {
  readonly severity: Severity;
  /** What the code means; README.md lists these. */
  readonly summary: string;
}

export const error = (summary: string): CodeInfo => ({ severity: "error", summary });
export const warning = (summary: string): CodeInfo => ({ severity: "warning", summary });

/**
 * Every problem code, in report order: problems are sorted by their code's position here, then
 * by file and line, so the most fundamental problem comes first. Codes starting with `tar.`,
 * `entry.`, `path.` or `limits.` are about the container; the rest are about the content.
 */
export const PROBLEM_CODES = {
  // The container: the tar stream or the directory
  "tar.bad_header": error(
    "A tar header is not a ustar header, or the input is not an uncompressed tar",
  ),
  "tar.bad_checksum": error("A tar header's checksum does not match"),
  "tar.truncated": error(
    "The tar ends inside a header or member, or without its end-of-archive marker",
  ),
  "tar.trailing_data": error("Non-zero bytes after the end-of-archive marker"),
  "tar.unsupported_entry": error("A pax, GNU or other extension header"),
  "entry.link": error("A symbolic or hard link"),
  "entry.special_file": error("A device, FIFO, socket or other file that is not regular"),
  "entry.duplicate": error("Two tar members with the same name"),
  "path.invalid": error(
    "An empty name, a control or non-ASCII character, or a file name ending in /",
  ),
  "path.absolute": error("An absolute path"),
  "path.dot_dot": error("A .. path segment"),
  "path.backslash": error("A backslash in a path"),
  "path.not_normalised": error("An empty or . path segment"),
  "path.outside_bundle_directory": error(
    "A path that is not under the one capture-<uuid>/ directory",
  ),
  "path.outside_layout": error("A file or directory that is not in the bundle layout"),
  "limits.bundle_size": error("The bundle is larger than maxBundleBytes"),
  "limits.entry_count": error("More entries than maxEntries"),
  "limits.file_size": error("A file is larger than the limit for its type"),
  "limits.line_length": error("A JSONL line is longer than maxJsonlLineBytes"),
  "limits.ply_vertices": error("The PLY declares more vertices than maxPlyVertices"),
  "limits.ply_faces": error("The PLY declares more faces than maxPlyFaces"),
  "limits.image_pixels": error("image_size has more pixels than maxImagePixels"),

  // Files and documents
  "file.missing": error("A required file is missing"),
  "manifest.schema_version": error("schema_version is not 1"),
  "bundle.capture_id_mismatch": error(
    "The bundle directory is not named capture-<manifest.capture_id>",
  ),
  "json.invalid": error(
    "A JSON file or JSONL line is not valid UTF-8 JSON, or a JSONL line is blank",
  ),
  "schema.invalid": error("A JSON file or JSONL line does not match its schema"),
  "files.duplicate_listing": error("manifest.files lists a path twice"),
  "files.listed_but_missing": error("A file listed in manifest.files is not in the bundle"),
  "files.not_listed": error("A file in the bundle is not listed in manifest.files"),
  "files.bytes_mismatch": error("A file's size differs from manifest.files"),
  "files.sha256_mismatch": error("A file's SHA-256 differs from manifest.files"),
  "quarantine.not_keyframe": error("A quarantined frame is not a keyframe in poses.jsonl"),
  "quarantine.file_present": error("A quarantined keyframe's file is still in the bundle"),
  "quarantine.file_not_listed": error(
    "A quarantined keyframe's file is not listed in manifest.files",
  ),

  // Frames and keyframes
  "manifest.frame_count": error("frame_count differs from the lines in poses.jsonl"),
  "manifest.keyframe_count": error("keyframe_count differs from the keyframe lines in poses.jsonl"),
  "keyframe.jpeg_missing": error("A keyframe has no JPEG"),
  "keyframe.depth_missing": error("A keyframe has no depth PNG"),
  "keyframe.confidence_missing": error("A keyframe has no confidence PNG, while others have one"),
  "keyframe.blur_line_missing": error("A keyframe has no privacy/blur.jsonl line"),
  "keyframe.unexpected_file": error("A JPEG or PNG for a frame that is not a keyframe"),
  "order.frame": error("frame does not strictly increase within a JSONL file"),
  "order.t": error("t does not strictly increase within a JSONL file"),
  "refined.not_keyframe": error(
    "A refined_keyframes.jsonl line for a frame that is not a keyframe",
  ),
  "tags.frame_not_in_poses": error("A tag's frame is not in poses.jsonl"),

  // Images
  "manifest.depth_size": error("depth_size is not [256, 192]"),
  "manifest.orientation": error("image_size or depth_size is portrait (width less than height)"),
  "manifest.aspect_ratio": error("image_size and depth_size have different aspect ratios"),
  "jpeg.invalid": error(
    "Not a complete JPEG: SOI, a frame header (SOFn), one or more scans (SOS), then EOI",
  ),
  "jpeg.format": error("A keyframe JPEG is not 3-component colour"),
  "jpeg.extra_image": error(
    "A keyframe JPEG carries a thumbnail (JFIF, JFXX or Exif), an MPF segment or bytes after EOI",
  ),
  "jpeg.size_mismatch": error("A keyframe JPEG's size differs from image_size"),
  "png.invalid": error("Not a complete PNG: a malformed IHDR or chunk, no IDAT or no IEND"),
  "png.trailing_data": error("Bytes after a PNG's IEND chunk"),
  "png.format": error(
    "A depth PNG is not 16-bit greyscale, or a confidence PNG not 8-bit greyscale",
  ),
  "png.size_mismatch": error("A depth or confidence PNG's size differs from depth_size"),

  // Anchors
  "anchors.roles": error("Not exactly one start and one end anchor"),
  "anchors.photo_not_keyframe": error("An anchor's photo is not a keyframe in poses.jsonl"),
  "anchors.photo_missing": error("An anchor's photo is not in the bundle"),
  "anchors.photo_quarantined": error("An anchor's photo is a quarantined keyframe"),
  "anchors.facing": error("An anchor's facing is not a horizontal unit vector"),

  // Privacy records
  "blur.not_keyframe": error("A privacy/blur.jsonl line for a frame that is not a keyframe"),
  "blur.box_outside_image": error("A blur box extends beyond image_size"),
  "manifest.faces_blurred": error(
    "faces_blurred differs from the face boxes in privacy/blur.jsonl",
  ),
  "manifest.screens_blurred": error(
    "screens_blurred differs from the screen boxes in privacy/blur.jsonl",
  ),

  // Mesh
  "ply.header": error("The PLY header is not exactly the documented one"),
  "ply.truncated": error("The PLY body ends before the declared vertices and faces"),
  "ply.vertex_index": error("A face refers to a vertex index beyond the vertex count"),
  "ply.classification": error("A face classification is not 0 to 7"),
  "ply.non_triangle_face": error("A face whose vertex_indices list does not have 3 entries"),

  // Warnings: checks beyond docs/capture-bundle.md
  "ply.non_finite_vertex": warning("A vertex coordinate is NaN or infinite"),
  "ply.trailing_bytes": warning("Bytes after the last declared face"),
  "png.ihdr_crc": warning("A PNG's IHDR chunk CRC does not match"),
  "transform.not_affine": warning("A transform's last row is not [0, 0, 0, 1]: written row-major?"),
  "manifest.time_order": warning("session_started_at, started_at and ended_at are out of order"),
  "preview.invalid_json": warning("preview/floorplan.geojson is not a JSON object"),
} as const satisfies Record<string, CodeInfo>;

export type ProblemCode = keyof typeof PROBLEM_CODES;

/** A table of problem codes, in report order, like PROBLEM_CODES. */
export type CodeTable<C extends string> = Readonly<Record<C, CodeInfo>>;

const CONTAINER_PREFIXES = ["parts.", "set.", "tar.", "entry.", "path.", "limits."];

/**
 * Whether a code is about the container (the tar, the directory, or a recording's export parts
 * and replay set) rather than the content.
 */
export function isContainerCode(code: string): boolean {
  return CONTAINER_PREFIXES.some((prefix) => code.startsWith(prefix));
}

export interface Problem<C extends string = ProblemCode> {
  readonly code: C;
  readonly severity: Severity;
  /** The file, relative to the bundle directory (or the tar member name); null for the bundle. */
  readonly file: string | null;
  /** 1-based line of a JSONL file. */
  readonly line?: number;
  readonly message: string;
}

/** Problems left out of the report: more than the per-file or per-code cap. */
export interface OmittedProblems<C extends string = ProblemCode> {
  readonly code: C;
  readonly file: string | null;
  readonly count: number;
}

export interface ValidationInfo {
  /** Tar members or directory entries read. */
  readonly entries: number;
  /** Bytes of file content read. */
  readonly bytes: number;
  /** Lines in poses.jsonl, and those with keyframe true; null if poses.jsonl is unusable. */
  readonly frames: number | null;
  readonly keyframes: number | null;
  /** Frames by tracking state; null if poses.jsonl is unusable. */
  readonly tracking: {
    readonly normal: number;
    readonly limited: number;
    readonly not_available: number;
  } | null;
  /** Share of frames with limited tracking, 0 to 1. */
  readonly limited_tracking_share: number | null;
  readonly quarantined_frames: readonly number[];
  readonly mesh: { readonly vertices: number; readonly faces: number } | null;
  /** Checks that could not run, and why. */
  readonly checks_skipped: readonly string[];
}

export interface ValidationReport {
  /** True when there are no errors; warnings don't make a bundle invalid. */
  readonly valid: boolean;
  readonly source: "tar" | "directory";
  /** From the manifest when it is readable, otherwise null. */
  readonly capture_id: string | null;
  readonly errors: readonly Problem[];
  readonly warnings: readonly Problem[];
  readonly omitted: readonly OmittedProblems[];
  readonly info: ValidationInfo;
  /** One line for captures.failure_reason: the first error, or null when valid. */
  readonly failure_reason: string | null;
}

/** At most this many problems with one code in one file are kept while validating. */
const MAX_PER_CODE_AND_FILE = 20;
/** At most this many problems with one code are reported. */
const MAX_PER_CODE = 100;
const MAX_DISPLAY_PATH = 200;
/** A backstop: every message is cut to this many characters. */
const MAX_MESSAGE = 1000;
const MAX_FAILURE_REASON = 500;

/**
 * Text as it can be shown safely: control and non-ASCII characters are escaped (a tar member
 * name or a JSON key is untrusted and could hold terminal escapes) and long text is cut short.
 */
function escapeText(text: string, max: number): string {
  let shown = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    shown += code >= 0x20 && code < 0x7f ? char : `\\u{${code.toString(16).padStart(2, "0")}}`;
    if (shown.length > max) return `${shown.slice(0, max)}...`;
  }
  return shown;
}

/** A name (a member name, a path, a JSON key) as it can be shown safely: see escapeText. */
export function displayPath(name: string): string {
  return escapeText(name, MAX_DISPLAY_PATH);
}

function compareProblems(
  rank: ReadonlyMap<string, number>,
  a: Problem<string>,
  b: Problem<string>,
) {
  return (
    (rank.get(a.code) ?? 0) - (rank.get(b.code) ?? 0) ||
    (a.file ?? "").localeCompare(b.file ?? "", "en") ||
    (a.line ?? 0) - (b.line ?? 0) ||
    a.message.localeCompare(b.message, "en")
  );
}

/**
 * Collects problems, capping repeats so a bad file can't flood the report. Messages are escaped
 * and cut short as a backstop, so a message can't carry terminal escapes or a whole document.
 * The codes are the bundle's PROBLEM_CODES unless another table is given (validate-recording's).
 */
export class Reporter<C extends string = ProblemCode> {
  readonly #codes: CodeTable<C>;
  readonly #rank: ReadonlyMap<string, number>;
  #problems: Problem<C>[] = [];
  #kept = new Map<string, number>();
  #omitted = new Map<string, OmittedProblems<C>>();
  /** displayPath of each file name seen, so it is worked out once per file, not per problem. */
  readonly #shownFiles = new Map<string, string>();

  constructor(codes?: CodeTable<C>) {
    this.#codes = codes ?? (PROBLEM_CODES as unknown as CodeTable<C>);
    this.#rank = new Map(Object.keys(this.#codes).map((code, rank) => [code, rank]));
  }

  #show(file: string): string {
    let shown = this.#shownFiles.get(file);
    if (shown === undefined) {
      shown = displayPath(file);
      this.#shownFiles.set(file, shown);
    }
    return shown;
  }

  add(code: C, file: string | null, rawMessage: string, line?: number): void {
    const shownFile = file === null ? null : this.#show(file);
    const key = `${code}\u0000${shownFile ?? ""}`;
    const kept = this.#kept.get(key) ?? 0;
    if (kept >= MAX_PER_CODE_AND_FILE) {
      this.#omit(code, shownFile, 1);
      return;
    }
    this.#kept.set(key, kept + 1);
    const { severity } = this.#codes[code];
    const message = escapeText(rawMessage, MAX_MESSAGE);
    this.#problems.push(
      line === undefined
        ? { code, severity, file: shownFile, message }
        : { code, severity, file: shownFile, line, message },
    );
  }

  #omit(code: C, file: string | null, count: number): void {
    const key = `${code}\u0000${file ?? ""}`;
    const previous = this.#omitted.get(key);
    this.#omitted.set(key, { code, file, count: (previous?.count ?? 0) + count });
  }

  hasErrors(): boolean {
    return this.#problems.some((problem) => problem.severity === "error");
  }

  has(code: C, file?: string): boolean {
    return this.#problems.some(
      (problem) => problem.code === code && (file === undefined || problem.file === file),
    );
  }

  /** Drops every content problem (used when the document's version is not one this reads). */
  dropContentProblems(): void {
    this.#problems = this.#problems.filter((problem) => isContainerCode(problem.code));
    for (const [key, omitted] of this.#omitted) {
      if (!isContainerCode(omitted.code)) this.#omitted.delete(key);
    }
  }

  /** The problems in report order, with at most MAX_PER_CODE per code. */
  finish(): { errors: Problem<C>[]; warnings: Problem<C>[]; omitted: OmittedProblems<C>[] } {
    const rank = this.#rank;
    const sorted = [...this.#problems].sort((a, b) => compareProblems(rank, a, b));
    const perCode = new Map<C, number>();
    const errors: Problem<C>[] = [];
    const warnings: Problem<C>[] = [];
    for (const problem of sorted) {
      const count = (perCode.get(problem.code) ?? 0) + 1;
      perCode.set(problem.code, count);
      if (count > MAX_PER_CODE) {
        this.#omit(problem.code, problem.file, 1);
      } else if (problem.severity === "error") {
        errors.push(problem);
      } else {
        warnings.push(problem);
      }
    }
    const omitted = [...this.#omitted.values()].sort(
      (a, b) =>
        (rank.get(a.code) ?? 0) - (rank.get(b.code) ?? 0) ||
        (a.file ?? "").localeCompare(b.file ?? "", "en"),
    );
    return { errors, warnings, omitted };
  }
}

/** Where a problem is: its file and line, or `whole` for one about the whole input. */
export function where(problem: Problem<string>, whole = "(bundle)"): string {
  if (problem.file === null) return whole;
  return problem.line === undefined ? problem.file : `${problem.file}:${problem.line}`;
}

/** The failure reason for captures.failure_reason: the first error, or null if there is none. */
export function failureReason(
  errors: readonly Problem<string>[],
  whole = "(bundle)",
): string | null {
  const first = errors[0];
  if (first === undefined) return null;
  const more = errors.length > 1 ? ` (and ${errors.length - 1} more errors)` : "";
  const text = `${first.code} ${where(first, whole)}: ${first.message}`;
  const cut = text.length > MAX_FAILURE_REASON ? `${text.slice(0, MAX_FAILURE_REASON)}...` : text;
  return `${cut}${more}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

/** The report as text for a terminal: one line per problem, then the info. */
export function formatReport(report: ValidationReport, name: string): string {
  const lines: string[] = [];
  const verdict = report.valid ? "valid" : "INVALID";
  lines.push(
    `${displayPath(name)} (${report.source}): ${verdict}, ${plural(report.errors.length, "error")}, ${plural(report.warnings.length, "warning")}`,
  );
  const problems = [...report.errors, ...report.warnings];
  const codeWidth = Math.max(0, ...problems.map((problem) => problem.code.length));
  const whereWidth = Math.min(40, Math.max(0, ...problems.map((problem) => where(problem).length)));
  for (const problem of problems) {
    lines.push(
      `  ${problem.severity.padEnd(7)}  ${problem.code.padEnd(codeWidth)}  ${where(problem).padEnd(whereWidth)}  ${problem.message}`,
    );
  }
  for (const omitted of report.omitted) {
    const scope = omitted.file === null ? "" : ` in ${omitted.file}`;
    lines.push(
      `  omitted  ${plural(omitted.count, "more problem")} with code ${omitted.code}${scope}`,
    );
  }
  const { info } = report;
  const facts: string[] = [];
  if (info.frames !== null && info.keyframes !== null) {
    facts.push(`${plural(info.frames, "frame")}, ${plural(info.keyframes, "keyframe")}`);
  }
  if (info.tracking !== null && info.limited_tracking_share !== null && info.frames !== null) {
    facts.push(
      `limited tracking ${(info.limited_tracking_share * 100).toFixed(1)}% (${info.tracking.limited} of ${info.frames} frames)`,
    );
  }
  if (info.mesh !== null) {
    facts.push(
      `mesh ${plural(info.mesh.vertices, "vertex", "vertices")}, ${plural(info.mesh.faces, "face")}`,
    );
  }
  facts.push(`${plural(info.entries, "entry", "entries")}, ${formatBytes(info.bytes)}`);
  if (info.quarantined_frames.length > 0) {
    facts.push(`quarantined frames ${info.quarantined_frames.join(", ")}`);
  }
  lines.push(`  info     ${facts.join("; ")}`);
  for (const skipped of info.checks_skipped) lines.push(`  skipped  ${skipped}`);
  return `${lines.join("\n")}\n`;
}
