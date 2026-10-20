// The recording's core: takes the files of one rec-<recording_id>/ directory in a single pass,
// hashing every file and parsing what it needs as the bytes stream past, and keeps only small
// facts per file and line. The checks across files run at the end, so member order doesn't
// matter; the mesh blocks are then read a second time (mesh.ts).

import { createHash } from "node:crypto";
import {
  collectingSink,
  describeVersion,
  MAX_INVALID_JSONL_LINES,
  type Sink,
} from "../bundle-validator/bundle.ts";
import {
  type ImageSize,
  JpegParser,
  type PngHeader,
  PngParser,
} from "../bundle-validator/images.ts";
import { LineSplitter, parseJsonBytes } from "../bundle-validator/jsonl.ts";
import type { Reporter } from "../bundle-validator/report.ts";
import { describeSchemaError, schemaValidator } from "../bundle-validator/schemas.ts";
import type { RangeReader } from "../bundle-validator/source.ts";
import { DEPTH_SIZE } from "../capture-bundle.ts";
import type {
  ActionLine,
  AnchorHistoryLine,
  BlurLine,
  BoundaryLine,
  MeshHistoryLine,
  MotionLine,
  RecordingEventLine,
  RecordingFrameLine,
  RecordingManifest,
} from "../generated/contracts.ts";
import {
  ARBITRARY_MOTION_REFERENCE_FRAMES,
  ATTITUDE_NORM_TOLERANCE,
  type EventDetailRule,
  eventDetailAllowed,
  FINAL_SAMPLE_ENDS,
  RECORDING_EVENT_DETAILS,
  RECORDING_PLUMBING_CALLS,
  RECORDING_SCHEMA_FILES,
  RECORDING_VERSION,
  type RecordingJsonPath,
  type RecordingLimits,
} from "../recording.ts";
import type { RecordingProblemCode } from "./codes.ts";
import {
  binaryPath,
  type CandidateDirectory,
  candidatePath,
  classifyRecordingPath,
  RECORDING_LAYOUT_DIRECTORIES,
  RECORDING_REQUIRED_FILES,
  type RecordingEntry,
  type RecordingJsonlPath,
  SAMPLE_STREAMS,
} from "./layout.ts";
import { checkMeshBlocks, type MeshBlock } from "./mesh.ts";

/** Schema errors reported per document or line; the rest are left out. */
const SCHEMA_ERRORS_PER_DOCUMENT = 5;
/**
 * Distinct final-line capture ids kept per file. A valid file has one; more than recording.json's
 * 200 segments, so that any unknown one is among those kept.
 */
const MAX_FINAL_CAPTURE_IDS = 256;

const INVALID = Symbol("invalid");

/** What each event detail rule allows, for messages. */
const DETAIL_RULES: Record<EventDetailRule, string> = {
  null: "null",
  ended: "a window.ended value",
  thermal: "a thermal state",
  degradation: "a degradation step",
  uuid: "a lowercase UUID",
  integer: "decimal digits with an optional minus",
  code: "a short lowercase code",
};

interface FileRecord {
  readonly bytes: number;
  /** Null when the content was not read in full (over its size limit, or cut short). */
  readonly sha256: string | null;
}

interface TimedLine {
  readonly t: number;
  readonly line: number;
}

class JsonlState {
  lines = 0;
  invalidLines = 0;
  complete = false;
  lastFrame: number | null = null;
  lastSeq: number | null = null;
  lastT: number | null = null;
  /** The earliest and latest t of the valid lines, for the window check. */
  earliest: TimedLine | null = null;
  latest: TimedLine | null = null;
  splitter: LineSplitter | null = null;
  /** Usable for cross-file checks: read in full, and every line parsed and schema-valid. */
  get usable(): boolean {
    return this.complete && this.invalidLines === 0;
  }
}

/**
 * The final lines of anchors.jsonl or mesh/history.jsonl. window.end_t is known only at the end,
 * so this keeps the first final line's t and the first line whose t differs from it: if the
 * first is at end_t, any line that differs is not.
 */
class FinalLines {
  count = 0;
  first: TimedLine | null = null;
  /** The first final line whose t differs from the first one's. */
  differingLine: number | null = null;
  /** Each distinct non-null capture_id, with the first line that has it. */
  readonly captureIds = new Map<string, number>();

  add(t: number, captureId: string | null, line: number): void {
    this.count++;
    if (this.first === null) this.first = { t, line };
    else if (t !== this.first.t && this.differingLine === null) this.differingLine = line;
    if (captureId !== null && !this.captureIds.has(captureId)) {
      if (this.captureIds.size < MAX_FINAL_CAPTURE_IDS) this.captureIds.set(captureId, line);
    }
  }
}

interface BlurFacts {
  readonly line: number;
  readonly right: number;
  readonly bottom: number;
}

interface MeshBin {
  readonly size: number;
  readonly complete: boolean;
  readonly reread: RangeReader | undefined;
}

/** Counts for the report's info. */
export interface RecordingInfo {
  /** Lines read in each JSONL file. */
  readonly lines: Readonly<Record<string, number>>;
  /** frames.jsonl lines with a candidate, and those kept. */
  readonly candidates: number;
  readonly candidates_kept: number;
  /** Mesh history: blocks in the index, and the bytes they inflated to (null if not checked). */
  readonly mesh_blocks: number;
  readonly mesh_inflated_bytes: number | null;
}

function isTooLargeMarker(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const record = value as Record<string, unknown>;
  return (
    keys.length === 2 &&
    record["omitted"] === "too_large" &&
    Number.isSafeInteger(record["bytes"]) &&
    (record["bytes"] as number) >= 0
  );
}

/** Collects one recording's files and runs its checks; problems go to the set's reporter. */
export class RecordingCollector {
  readonly #reporter: Reporter<RecordingProblemCode>;
  readonly #limits: RecordingLimits;
  /** The recording directory's name, rec-<recording_id>. */
  readonly #top: string;
  readonly #seenNames = new Set<string>();
  readonly #files = new Map<string, FileRecord>();
  readonly #jsonl = new Map<RecordingJsonlPath, JsonlState>();
  #entries = 0;
  #bytes = 0;
  #sizeReported = false;
  #entriesReported = false;
  // recording.json, when it parsed and passed its schema.
  #manifest: RecordingManifest | null = null;
  #versionMismatch: unknown;
  // Facts from lines that passed their schema.
  #candidates = 0;
  readonly #keptFrames = new Map<number, number>();
  readonly #blur = new Map<number, BlurFacts>();
  #headingLine: number | null = null;
  #meshStopped = false;
  readonly #historySeen = {
    "anchors.jsonl": new Set<string>(),
    "mesh/history.jsonl": new Set<string>(),
  };
  readonly #finals = {
    "anchors.jsonl": new FinalLines(),
    "mesh/history.jsonl": new FinalLines(),
  };
  readonly #meshBlocks: MeshBlock[] = [];
  #meshBin: MeshBin | null = null;
  #meshInflated: number | null = null;
  /** boundary.jsonl's binary paths, with the first line naming each. */
  readonly #binaries = new Map<string, number>();
  readonly #jpegs = new Map<number, ImageSize>();
  readonly #pngs: Record<"depth" | "confidence", Map<number, PngHeader>> = {
    depth: new Map(),
    confidence: new Map(),
  };
  readonly #skippedWhileReading: string[] = [];

  constructor(reporter: Reporter<RecordingProblemCode>, limits: RecordingLimits, top: string) {
    this.#reporter = reporter;
    this.#limits = limits;
    this.#top = top;
  }

  /** recording.json, if it is valid. */
  get manifest(): RecordingManifest | null {
    return this.#manifest;
  }

  /** Bytes of the recording's files, from their sizes. */
  get bytes(): number {
    return this.#bytes;
  }

  #add(code: RecordingProblemCode, file: string | null, message: string, line?: number): void {
    this.#reporter.add(code, file, message, line);
  }

  #count(): void {
    this.#entries++;
    if (this.#entries > this.#limits.maxEntries && !this.#entriesReported) {
      this.#entriesReported = true;
      this.#add(
        "limits.entry_count",
        null,
        `The recording has more than ${this.#limits.maxEntries} entries (maxEntries)`,
      );
    }
  }

  /** A second member with the same name is reported; returns whether the name is new. */
  #isNew(inner: string): boolean {
    if (this.#seenNames.has(inner)) {
      this.#add("entry.duplicate", inner, "A second member with this name");
      return false;
    }
    this.#seenNames.add(inner);
    return true;
  }

  /** A directory, relative to the recording directory ("" for the directory itself). */
  directory(inner: string): void {
    this.#count();
    if (inner === "" || !this.#isNew(inner)) return;
    if (!(RECORDING_LAYOUT_DIRECTORIES as readonly string[]).includes(inner)) {
      this.#add("path.outside_layout", inner, `Directory ${inner}/ is not in the recording layout`);
    }
  }

  #limitFor(entry: RecordingEntry): { limit: number; name: keyof RecordingLimits } | null {
    switch (entry.kind) {
      case "manifest":
        return { limit: this.#limits.maxJsonBytes, name: "maxJsonBytes" };
      case "jsonl":
        return { limit: this.#limits.maxJsonlBytes, name: "maxJsonlBytes" };
      case "mesh_bin":
        return { limit: this.#limits.maxMeshHistoryBytes, name: "maxMeshHistoryBytes" };
      case "candidate":
        return entry.directory === "candidates"
          ? { limit: this.#limits.maxJpegBytes, name: "maxJpegBytes" }
          : { limit: this.#limits.maxPngBytes, name: "maxPngBytes" };
      case "binary":
        return null;
    }
  }

  /** A file, relative to the recording directory. Throws only what the source throws. */
  async file(
    inner: string,
    size: number,
    open: () => AsyncIterable<Uint8Array>,
    reread: RangeReader | undefined,
  ): Promise<void> {
    this.#count();
    if (!this.#isNew(inner)) return;
    const entry = classifyRecordingPath(inner);
    if (entry === null) {
      this.#add("path.outside_layout", inner, `${inner} is not in the recording layout`);
      return;
    }
    this.#bytes += size;
    if (this.#bytes > this.#limits.maxRecordingBytes && !this.#sizeReported) {
      this.#sizeReported = true;
      this.#add(
        "limits.recording_size",
        null,
        `The recording is larger than ${this.#limits.maxRecordingBytes} bytes (maxRecordingBytes)`,
      );
    }
    const limit = this.#limitFor(entry);
    if (limit !== null && size > limit.limit) {
      this.#add(
        "limits.file_size",
        inner,
        `${size} bytes; the limit is ${limit.limit} (${limit.name})`,
      );
      this.#files.set(inner, { bytes: size, sha256: null });
      return;
    }
    const sink = this.#sinkFor(inner, entry);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of open()) {
      bytes += chunk.length;
      hash.update(chunk);
      sink?.push(chunk);
    }
    const complete = bytes === size;
    sink?.end(complete);
    this.#files.set(inner, { bytes, sha256: complete ? hash.digest("hex") : null });
    if (entry.kind === "mesh_bin") this.#meshBin = { size: bytes, complete, reread };
    if (entry.kind === "binary" && complete && bytes % 4 !== 0) {
      this.#add(
        "boundary.binary_size",
        inner,
        `${bytes} bytes is not a whole number of float32 values`,
      );
    }
  }

  #sinkFor(inner: string, entry: RecordingEntry): Sink | null {
    switch (entry.kind) {
      case "manifest":
        return collectingSink((bytes) => {
          const value = this.#parseJson(bytes, inner);
          if (value !== INVALID) this.#readManifest(value);
        });
      case "jsonl":
        return this.#jsonlSink(entry.path);
      case "candidate":
        return entry.directory === "candidates"
          ? this.#jpegSink(inner, entry.frame)
          : this.#pngSink(inner, entry.directory, entry.frame);
      case "mesh_bin":
      case "binary":
        return null;
    }
  }

  #parseJson(bytes: Uint8Array, file: string, line?: number): unknown {
    const parsed = parseJsonBytes(bytes, line !== undefined);
    if (parsed.ok) return parsed.value;
    this.#add("json.invalid", file, parsed.message, line);
    return INVALID;
  }

  /** Validates against the file's schema; returns the value if valid, else null. */
  #validate<T>(path: RecordingJsonPath, value: unknown, line?: number): T | null {
    const validate = schemaValidator(RECORDING_SCHEMA_FILES[path]);
    if (validate(value)) return value as T;
    for (const error of (validate.errors ?? []).slice(0, SCHEMA_ERRORS_PER_DOCUMENT)) {
      this.#add("schema.invalid", path, describeSchemaError(error), line);
    }
    return null;
  }

  #readManifest(value: unknown): void {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const version = (value as Record<string, unknown>)["recording_version"];
      if (version !== undefined && version !== RECORDING_VERSION) {
        this.#versionMismatch = version;
        return;
      }
    }
    this.#manifest = this.#validate<RecordingManifest>("recording.json", value);
  }

  #jsonlSink(path: RecordingJsonlPath): Sink {
    const state = new JsonlState();
    this.#jsonl.set(path, state);
    const splitter = new LineSplitter(
      this.#limits.maxJsonlLineBytes,
      (bytes, line) => this.#jsonlLine(path, state, bytes, line),
      (line) => {
        state.lines++;
        this.#add(
          "limits.line_length",
          path,
          `Longer than ${this.#limits.maxJsonlLineBytes} bytes (maxJsonlLineBytes)`,
          line,
        );
        this.#invalidLine(path, state, line);
      },
    );
    state.splitter = splitter;
    return {
      push: (chunk) => splitter.push(chunk),
      end: (complete) => {
        if (!complete) return;
        splitter.end();
        state.complete = true;
      },
    };
  }

  /** Counts an invalid line; after MAX_INVALID_JSONL_LINES, the rest of the file is not split. */
  #invalidLine(path: RecordingJsonlPath, state: JsonlState, line: number): void {
    state.invalidLines++;
    if (state.invalidLines === MAX_INVALID_JSONL_LINES) {
      state.splitter?.stop();
      this.#skippedWhileReading.push(
        `${path} after line ${line}: ${MAX_INVALID_JSONL_LINES} lines are invalid, so the rest is not parsed`,
      );
    }
  }

  #jsonlLine(path: RecordingJsonlPath, state: JsonlState, bytes: Uint8Array, line: number): void {
    state.lines++;
    const parsed = this.#parseJson(bytes, path, line);
    if (parsed === INVALID) {
      this.#invalidLine(path, state, line);
      return;
    }
    const value = this.#validate<Record<string, unknown>>(path, parsed, line);
    if (value === null) {
      this.#invalidLine(path, state, line);
      return;
    }
    this.#checkOrder(path, state, value, line);
    switch (path) {
      case "frames.jsonl":
        this.#frameLine(value as unknown as RecordingFrameLine, line);
        break;
      case "motion.jsonl":
        this.#motionLine(value as unknown as MotionLine, line);
        break;
      case "anchors.jsonl":
        this.#anchorLine(value as unknown as AnchorHistoryLine, line);
        break;
      case "mesh/history.jsonl":
        this.#meshLine(value as unknown as MeshHistoryLine, line);
        break;
      case "events.jsonl":
        this.#eventLine(value as unknown as RecordingEventLine, line);
        break;
      case "actions.jsonl":
        this.#actionLine(value as unknown as ActionLine, line);
        break;
      case "boundary.jsonl":
        this.#boundaryLine(value as unknown as BoundaryLine, line);
        break;
      case "privacy/blur.jsonl":
        this.#blurLine(value as unknown as BlurLine, line);
        break;
      default:
        break;
    }
  }

  /** frame and seq strictly increase; t strictly increases in the sample streams, else never decreases. */
  #checkOrder(
    path: RecordingJsonlPath,
    state: JsonlState,
    value: Record<string, unknown>,
    line: number,
  ): void {
    const frame = value["frame"];
    if (typeof frame === "number" && path !== "anchors.jsonl") {
      if (state.lastFrame !== null && frame <= state.lastFrame) {
        this.#add(
          "order.frame",
          path,
          `frame ${frame} does not increase: the line before has frame ${state.lastFrame}`,
          line,
        );
      }
      state.lastFrame = frame;
    }
    const seq = value["seq"];
    if (typeof seq === "number") {
      if (state.lastSeq !== null && seq <= state.lastSeq) {
        this.#add(
          "order.seq",
          path,
          `seq ${seq} does not increase: the line before has seq ${state.lastSeq}`,
          line,
        );
      }
      state.lastSeq = seq;
    }
    const t = value["t"];
    if (typeof t !== "number") return;
    if (state.lastT !== null) {
      if (SAMPLE_STREAMS.includes(path) && t <= state.lastT) {
        this.#add(
          "order.t",
          path,
          "t does not increase: it is not greater than on the line before",
          line,
        );
      } else if (t < state.lastT) {
        this.#add("order.t", path, "t decreases: it is less than on the line before", line);
      }
    }
    state.lastT = t;
    if (state.earliest === null || t < state.earliest.t) state.earliest = { t, line };
    if (state.latest === null || t > state.latest.t) state.latest = { t, line };
  }

  #frameLine(frame: RecordingFrameLine, line: number): void {
    if (frame.candidate === null) return;
    this.#candidates++;
    if (frame.candidate === "kept" && !this.#keptFrames.has(frame.frame)) {
      this.#keptFrames.set(frame.frame, line);
    }
  }

  #motionLine(motion: MotionLine, line: number): void {
    const norm = Math.hypot(...motion.attitude);
    if (!(Math.abs(norm - 1) <= ATTITUDE_NORM_TOLERANCE)) {
      this.#add(
        "motion.attitude_norm",
        "motion.jsonl",
        `The attitude's norm is not within ${ATTITUDE_NORM_TOLERANCE} of 1`,
        line,
      );
    }
    if (motion.heading !== null && this.#headingLine === null) this.#headingLine = line;
  }

  /** The rules anchors.jsonl and mesh/history.jsonl share. */
  #historyLine(
    path: "anchors.jsonl" | "mesh/history.jsonl",
    entry: AnchorHistoryLine | MeshHistoryLine,
    line: number,
  ): void {
    const seen = this.#historySeen[path];
    if (!seen.has(entry.anchor)) {
      seen.add(entry.anchor);
      if (entry.op !== "add") {
        this.#add(
          "history.first_not_add",
          path,
          `The anchor's first line is an ${entry.op}, not an add`,
          line,
        );
      }
    }
    if (entry.capture_id !== null && !entry.final) {
      this.#add(
        "history.capture_id_not_final",
        path,
        "capture_id is set on a line that is not final",
        line,
      );
    }
    if (entry.final) this.#finals[path].add(entry.t, entry.capture_id, line);
  }

  #anchorLine(anchor: AnchorHistoryLine, line: number): void {
    this.#historyLine("anchors.jsonl", anchor, line);
    if ((anchor.transform === null) !== (anchor.op === "remove")) {
      this.#add(
        "history.null_fields",
        "anchors.jsonl",
        anchor.op === "remove"
          ? "transform is set on a remove line"
          : `transform is null on an ${anchor.op} line`,
        line,
      );
    }
    if ((anchor.frame !== null) !== (anchor.kind === "keyframe")) {
      this.#add(
        "anchors.frame",
        "anchors.jsonl",
        anchor.kind === "keyframe"
          ? "frame is null on a keyframe anchor's line"
          : `frame is set on a ${anchor.kind} anchor's line; only keyframe anchors have one`,
        line,
      );
    }
  }

  #meshLine(mesh: MeshHistoryLine, line: number): void {
    this.#historyLine("mesh/history.jsonl", mesh, line);
    const fields = [mesh.transform, mesh.offset, mesh.bytes, mesh.vertices, mesh.faces];
    if (mesh.op === "remove") {
      if (fields.some((field) => field !== null)) {
        this.#add(
          "history.null_fields",
          "mesh/history.jsonl",
          "transform, offset, bytes, vertices and faces must be null on a remove line",
          line,
        );
      }
      return;
    }
    const { offset, bytes, vertices, faces } = mesh;
    if (
      mesh.transform === null ||
      offset === null ||
      bytes === null ||
      vertices === null ||
      faces === null
    ) {
      this.#add(
        "history.null_fields",
        "mesh/history.jsonl",
        `transform, offset, bytes, vertices and faces must all be set on an ${mesh.op} line`,
        line,
      );
      return;
    }
    this.#meshBlocks.push({ line, offset, bytes, vertices, faces });
  }

  #eventLine(event: RecordingEventLine, line: number): void {
    if (!eventDetailAllowed(event.kind, event.detail)) {
      const rule = DETAIL_RULES[RECORDING_EVENT_DETAILS[event.kind]];
      this.#add(
        "events.detail",
        "events.jsonl",
        `The detail of a ${event.kind} event must be ${rule} (RECORDING_EVENT_DETAILS)`,
        line,
      );
    }
    if (
      event.kind === "degradation" &&
      (event.detail === "no_mesh_history" || event.detail === "no_recording")
    ) {
      this.#meshStopped = true;
    }
  }

  /** A JSON text field: it must parse; the too-large marker is a warning. */
  #jsonText(text: string, field: string, path: RecordingJsonlPath, line: number): void {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.#add("json_text.invalid", path, `${field} is not JSON text`, line);
      return;
    }
    if (isTooLargeMarker(value)) {
      this.#add(
        "json_text.too_large",
        path,
        `${field} holds the too-large marker: its value was left out`,
        line,
      );
    }
  }

  #actionLine(action: ActionLine, line: number): void {
    if ((RECORDING_PLUMBING_CALLS as readonly string[]).includes(action.call)) {
      this.#add(
        "actions.plumbing_call",
        "actions.jsonl",
        `${action.call} is the recorder's plumbing, which actions.jsonl never logs`,
        line,
      );
    }
    this.#jsonText(action.args, "args", "actions.jsonl", line);
    if (action.result !== null) this.#jsonText(action.result, "result", "actions.jsonl", line);
  }

  #boundaryLine(boundary: BoundaryLine, line: number): void {
    if ((boundary.value === null) === (boundary.binary === null)) {
      this.#add(
        "boundary.value_binary",
        "boundary.jsonl",
        boundary.value === null
          ? "Both value and binary are null; exactly one is set"
          : "Both value and binary are set; exactly one is",
        line,
      );
    }
    if (boundary.value !== null) this.#jsonText(boundary.value, "value", "boundary.jsonl", line);
    if (boundary.binary !== null) {
      const expected = binaryPath(boundary.seq);
      if (boundary.binary !== expected) {
        this.#add(
          "boundary.binary_path",
          "boundary.jsonl",
          `binary is not ${expected}, the path for this line's seq`,
          line,
        );
      }
      if (!this.#binaries.has(boundary.binary)) this.#binaries.set(boundary.binary, line);
    }
  }

  #blurLine(blur: BlurLine, line: number): void {
    let right = 0;
    let bottom = 0;
    for (const box of blur.boxes) {
      right = Math.max(right, box.x + box.w);
      bottom = Math.max(bottom, box.y + box.h);
    }
    if (!this.#blur.has(blur.frame)) this.#blur.set(blur.frame, { line, right, bottom });
  }

  #jpegSink(inner: string, frame: number): Sink {
    const parser = new JpegParser();
    return {
      push: (chunk) => {
        if (!parser.done) parser.push(chunk);
      },
      end: (complete) => {
        if (!complete) return;
        const result = parser.end();
        if (!result.ok) {
          this.#add("jpeg.invalid", inner, result.message);
          return;
        }
        const jpeg = result.value;
        if (jpeg.components !== 3) {
          this.#add(
            "jpeg.format",
            inner,
            `${jpeg.components} ${jpeg.components === 1 ? "component" : "components"}; a candidate JPEG is 3-component colour (YCbCr)`,
          );
        }
        if (jpeg.extraImage !== null) {
          this.#add(
            "jpeg.extra_image",
            inner,
            `${jpeg.extraImage}; a candidate JPEG holds its one blurred image and nothing else`,
          );
        }
        this.#jpegs.set(frame, jpeg);
      },
    };
  }

  #pngSink(inner: string, directory: "depth" | "confidence", frame: number): Sink {
    const parser = new PngParser();
    return {
      push: (chunk) => {
        if (!parser.done) parser.push(chunk);
      },
      end: (complete) => {
        if (!complete) return;
        const result = parser.end();
        if (!result.ok) {
          this.#add("png.invalid", inner, result.message);
          return;
        }
        const png = result.value;
        if (!png.crcOk) this.#add("png.ihdr_crc", inner, "The IHDR chunk's CRC does not match");
        if (png.trailingBytes > 0) {
          this.#add("png.trailing_data", inner, `${png.trailingBytes} bytes after the IEND chunk`);
        }
        const bitDepth = directory === "depth" ? 16 : 8;
        if (png.colourType !== 0 || png.bitDepth !== bitDepth) {
          this.#add(
            "png.format",
            inner,
            `${png.bitDepth}-bit, colour type ${png.colourType}; a ${directory} PNG is ${bitDepth}-bit greyscale (colour type 0)`,
          );
        }
        this.#pngs[directory].set(frame, png);
      },
    };
  }

  // Checks across files

  #has(path: string): boolean {
    return this.#files.has(path);
  }

  /**
   * Runs the checks across files, then the mesh blocks' second read. `fatal`: the input could
   * not be read to the end. Returns the checks that could not run, and why.
   */
  async finish(fatal: boolean): Promise<string[]> {
    if (!fatal && this.#versionMismatch !== undefined) {
      this.#reporter.dropContentProblems();
      this.#add(
        "recording.version",
        "recording.json",
        `recording_version is ${describeVersion(this.#versionMismatch)}; this validator reads version ${RECORDING_VERSION}`,
      );
      return [`Content checks: the recording is not recording_version ${RECORDING_VERSION}`];
    }
    const skipped: string[] = [];
    if (fatal) {
      skipped.push("Checks across files: the recording could not be read to the end");
    } else {
      await this.#crossChecks(skipped);
    }
    skipped.push(...this.#skippedWhileReading);
    return skipped;
  }

  async #crossChecks(skipped: string[]): Promise<void> {
    const manifest = this.#manifest;
    const reportedMissing = this.#checkRequiredFiles(manifest);
    if (manifest === null) {
      skipped.push(
        this.#has("recording.json")
          ? "Checks against recording.json: it is not valid"
          : "Checks against recording.json: it is missing",
      );
    } else {
      this.#checkDirectoryName(manifest);
      const open = this.#checkWindow(manifest);
      if (open) {
        skipped.push("The files listing: the recording is still open, so files is empty");
      } else {
        this.#checkListing(manifest, reportedMissing);
      }
      this.#checkSegments(manifest);
      this.#checkStreamsAgainstManifest(manifest);
    }
    this.#checkCandidates(manifest, skipped);
    this.#checkBinaries();
    await this.#checkMesh(skipped);
  }

  /** Required files; the mesh history's pair; the profile's files. Returns those missing. */
  #checkRequiredFiles(manifest: RecordingManifest | null): Set<string> {
    const missing = new Set<string>();
    const require = (path: string, why: string) => {
      if (this.#has(path)) return;
      this.#add("file.missing", path, `${path} ${why}`);
      missing.add(path);
    };
    for (const path of RECORDING_REQUIRED_FILES) require(path, "is required but missing");
    const bin = this.#has("mesh/history.bin");
    const index = this.#has("mesh/history.jsonl");
    if (bin || index) {
      require("mesh/history.bin", "is missing; mesh/history.jsonl is its index");
      require("mesh/history.jsonl", "is missing; it is mesh/history.bin's index");
    } else if (
      manifest !== null &&
      manifest.arkit.scene_reconstruction !== "none" &&
      !this.#meshStopped
    ) {
      const why =
        "is required unless the mesh history stopped before its first snapshot (no degradation event says it did)";
      require("mesh/history.bin", why);
      require("mesh/history.jsonl", why);
    }
    if (manifest !== null && manifest.profile !== "lean") {
      require("privacy/blur.jsonl", `is required in ${manifest.profile}`);
    }
    return missing;
  }

  #checkDirectoryName(manifest: RecordingManifest): void {
    if (this.#top !== `rec-${manifest.recording_id}`) {
      this.#add(
        "recording.id_mismatch",
        `${this.#top}/`,
        `The recording directory is ${this.#top}, but recording_id is ${manifest.recording_id}`,
      );
    }
  }

  /** recording.json's window and the values that depend on it; returns whether it is open. */
  #checkWindow(manifest: RecordingManifest): boolean {
    const { window, rates } = manifest;
    const nulls = [window.end_t === null, window.ended === null, rates === null];
    if (nulls.some((isNull) => isNull !== nulls[0])) {
      this.#add(
        "recording.window_state",
        "recording.json",
        "window.end_t, window.ended and rates are null together, only while the recording is open",
      );
    }
    const open = window.end_t === null;
    if (open) {
      this.#add(
        "recording.open",
        "recording.json",
        "window.end_t is null: the recording was never closed, nor recovered at the next launch",
      );
    }
    if (window.end_t !== null && window.end_t < window.start_t) {
      this.#add(
        "recording.window_order",
        "recording.json",
        "window.end_t is before window.start_t",
      );
    }
    const dense = manifest.profile === "dense";
    const maxSeconds = dense ? this.#limits.maxDenseSessionSeconds : this.#limits.maxSessionSeconds;
    if (window.end_t !== null && window.end_t - window.start_t > maxSeconds) {
      this.#add(
        "limits.session_length",
        "recording.json",
        `The window is longer than ${maxSeconds} s (${dense ? "maxDenseSessionSeconds" : "maxSessionSeconds"})`,
      );
    }
    if ((manifest.origin === "synthetic") !== (manifest.build.profile === "synthetic")) {
      this.#add(
        "recording.build_profile",
        "recording.json",
        `build.profile is ${manifest.build.profile} but origin is ${manifest.origin}; synthetic goes with synthetic`,
      );
    }
    if ((manifest.profile === "lean") !== (manifest.detector_versions === null)) {
      this.#add(
        "recording.detector_versions",
        "recording.json",
        manifest.profile === "lean"
          ? "detector_versions is set in lean, which runs no detectors"
          : `detector_versions is null in ${manifest.profile}, which blurs its candidates`,
      );
    }
    const { width, height } = manifest.arkit.video_format;
    if (width * height > this.#limits.maxImagePixels) {
      this.#add(
        "limits.image_pixels",
        "recording.json",
        `arkit.video_format is ${width * height} pixels; the limit is ${this.#limits.maxImagePixels} (maxImagePixels)`,
      );
    }
    return open;
  }

  /** Every file listed, every listed file present, sizes and digests. */
  #checkListing(manifest: RecordingManifest, reportedMissing: ReadonlySet<string>): void {
    const listed = new Map<string, (typeof manifest.files)[number]>();
    for (const entry of manifest.files) {
      if (listed.has(entry.path)) {
        this.#add("files.duplicate_listing", "recording.json", `files lists ${entry.path} twice`);
        continue;
      }
      listed.set(entry.path, entry);
      const record = this.#files.get(entry.path);
      if (record === undefined) {
        if (!reportedMissing.has(entry.path)) {
          this.#add(
            "files.listed_but_missing",
            entry.path,
            "Listed in files, but not in the recording",
          );
        }
      } else if (record.sha256 === null) {
        // Not read in full: over its size limit (reported already) or cut short.
      } else if (record.bytes !== entry.bytes) {
        this.#add(
          "files.bytes_mismatch",
          entry.path,
          `${record.bytes} bytes, but files says ${entry.bytes}`,
        );
      } else if (record.sha256 !== entry.sha256) {
        this.#add("files.sha256_mismatch", entry.path, "The SHA-256 differs from files");
      }
    }
    for (const path of this.#files.keys()) {
      if (path !== "recording.json" && !listed.has(path)) {
        this.#add("files.not_listed", path, "In the recording, but not listed in files");
      }
    }
  }

  /** The segment rules recording.json can be checked for alone. */
  #checkSegments(manifest: RecordingManifest): void {
    const seen = new Set<string>();
    manifest.segments.forEach((segment, index) => {
      const label = `Segment ${index} (capture-${segment.capture_id})`;
      if (seen.has(segment.capture_id)) {
        this.#add("segment.duplicate", "recording.json", `${label} is listed twice`);
      }
      seen.add(segment.capture_id);
      if (segment.end_t !== null && segment.end_t < segment.start_t) {
        this.#add("segment.order", "recording.json", `${label}: end_t is before start_t`);
      }
      if (segment.manifest_sha256 !== null && segment.end_t === null) {
        this.#add(
          "segment.hash_without_end",
          "recording.json",
          `${label} has a manifest_sha256 but no end_t`,
        );
      }
    });
  }

  /** The line checks that need recording.json: the window, final lines, heading, motion. */
  #checkStreamsAgainstManifest(manifest: RecordingManifest): void {
    const { start_t, end_t, ended } = manifest.window;
    for (const [path, state] of this.#jsonl) {
      if (state.earliest !== null && state.earliest.t < start_t) {
        this.#add(
          "window.outside",
          path,
          "t is before window.start_t: nothing from before the recording opened is written",
          state.earliest.line,
        );
      }
      if (end_t !== null && state.latest !== null && state.latest.t > end_t) {
        this.#add(
          "window.outside",
          path,
          "t is after window.end_t: nothing from after the recording closed is kept",
          state.latest.line,
        );
      }
    }
    const segments = new Set(manifest.segments.map((segment) => segment.capture_id));
    for (const path of ["anchors.jsonl", "mesh/history.jsonl"] as const) {
      const finals = this.#finals[path];
      const first = finals.first;
      if (first === null) continue;
      if (ended === null || !(FINAL_SAMPLE_ENDS as readonly string[]).includes(ended)) {
        this.#add(
          "history.final_unexpected",
          path,
          `${finals.count} final lines, but a recording that ended ${ended ?? "(still open)"} takes no final sample`,
          first.line,
        );
        continue;
      }
      const notAtEnd = first.t !== end_t ? first.line : finals.differingLine;
      if (notAtEnd !== null) {
        this.#add(
          "history.final_not_at_end",
          path,
          "A final line's t is not window.end_t",
          notAtEnd,
        );
      }
      for (const [captureId, line] of finals.captureIds) {
        if (!segments.has(captureId)) {
          this.#add(
            "history.capture_id_unknown",
            path,
            `capture_id ${captureId} is not one of recording.json's segments`,
            line,
          );
        }
      }
    }
    const frame = manifest.motion?.reference_frame;
    if (
      this.#headingLine !== null &&
      frame !== undefined &&
      (ARBITRARY_MOTION_REFERENCE_FRAMES as readonly string[]).includes(frame)
    ) {
      this.#add(
        "motion.heading_arbitrary",
        "motion.jsonl",
        `heading is set, but motion.reference_frame is ${frame}, which has no north`,
        this.#headingLine,
      );
    }
    const motion = this.#jsonl.get("motion.jsonl");
    if (motion?.complete === true && (motion.lines === 0) !== (manifest.motion === null)) {
      this.#add(
        "motion.file_state",
        "motion.jsonl",
        manifest.motion === null
          ? `${motion.lines} lines, but recording.json's motion is null: the file is empty without device motion`
          : "Empty, but recording.json's motion is set: it is empty only without device motion",
      );
    }
  }

  /** Kept candidates against their files and blur lines; image formats and sizes. */
  #checkCandidates(manifest: RecordingManifest | null, skipped: string[]): void {
    const files = [...this.#files.keys()];
    const lean = manifest?.profile === "lean";
    if (lean) {
      for (const path of files) {
        const entry = classifyRecordingPath(path);
        if (entry?.kind === "candidate" || path === "privacy/blur.jsonl") {
          this.#add("candidate.unexpected_file", path, "A lean recording keeps no candidates");
        }
      }
    }
    const frames = this.#jsonl.get("frames.jsonl");
    if (frames?.usable !== true) {
      skipped.push("Candidate checks: frames.jsonl is missing, cut short or has invalid lines");
      return;
    }
    const blurUsable = this.#jsonl.get("privacy/blur.jsonl")?.usable === true;
    const confidenceInUse = files.some((path) => path.startsWith("confidence/"));
    const directories: CandidateDirectory[] = confidenceInUse
      ? ["candidates", "depth", "confidence"]
      : ["candidates", "depth"];
    const missingCodes = {
      candidates: "candidate.jpeg_missing",
      depth: "candidate.depth_missing",
      confidence: "candidate.confidence_missing",
    } as const satisfies Record<CandidateDirectory, RecordingProblemCode>;
    for (const [frame, line] of [...this.#keptFrames].sort(([a], [b]) => a - b)) {
      for (const directory of directories) {
        const path = candidatePath(directory, frame);
        if (this.#has(path)) continue;
        const others = directory === "confidence" ? ", while other candidates have one" : "";
        this.#add(
          missingCodes[directory],
          path,
          `The candidate kept at frames.jsonl line ${line} (frame ${frame}) has no ${path}${others}`,
        );
      }
      if (blurUsable && !this.#blur.has(frame)) {
        this.#add(
          "candidate.blur_line_missing",
          "privacy/blur.jsonl",
          `The candidate kept at frames.jsonl line ${line} (frame ${frame}) has no blur line`,
        );
      }
    }
    if (!lean) {
      for (const path of files) {
        const entry = classifyRecordingPath(path);
        if (entry?.kind !== "candidate" || this.#keptFrames.has(entry.frame)) continue;
        this.#add(
          "candidate.unexpected_file",
          path,
          `Frame ${entry.frame} is not a kept candidate in frames.jsonl`,
        );
      }
    }
    if (blurUsable) {
      for (const [frame, facts] of this.#blur) {
        if (!this.#keptFrames.has(frame)) {
          this.#add(
            "blur.not_candidate",
            "privacy/blur.jsonl",
            `Frame ${frame} is not a kept candidate in frames.jsonl`,
            facts.line,
          );
        }
      }
    }
    if (manifest === null) return;
    const { width, height } = manifest.arkit.video_format;
    for (const [frame, size] of this.#jpegs) {
      if (size.width !== width || size.height !== height) {
        this.#add(
          "jpeg.size_mismatch",
          candidatePath("candidates", frame),
          `${size.width} x ${size.height} pixels, but arkit.video_format is ${width} x ${height}`,
        );
      }
    }
    for (const directory of ["depth", "confidence"] as const) {
      for (const [frame, png] of this.#pngs[directory]) {
        if (png.width !== DEPTH_SIZE[0] || png.height !== DEPTH_SIZE[1]) {
          this.#add(
            "png.size_mismatch",
            candidatePath(directory, frame),
            `${png.width} x ${png.height} pixels; depth and confidence are ${DEPTH_SIZE[0]} x ${DEPTH_SIZE[1]}`,
          );
        }
      }
    }
    for (const [frame, facts] of this.#blur) {
      if (facts.right > width || facts.bottom > height) {
        this.#add(
          "blur.box_outside_image",
          "privacy/blur.jsonl",
          `A box for frame ${frame} reaches x = ${facts.right}, y = ${facts.bottom}, beyond arkit.video_format ${width} x ${height}`,
          facts.line,
        );
      }
    }
  }

  /** Each binary line's file is there, and each file has a line. */
  #checkBinaries(): void {
    for (const [path, line] of this.#binaries) {
      if (!this.#has(path)) {
        this.#add(
          "boundary.binary_missing",
          path,
          `boundary.jsonl line ${line} names this file, but it is not in the recording`,
        );
      }
    }
    if (this.#jsonl.get("boundary.jsonl")?.usable !== true) return;
    for (const path of this.#files.keys()) {
      if (classifyRecordingPath(path)?.kind === "binary" && !this.#binaries.has(path)) {
        this.#add("boundary.unexpected_file", path, "No boundary.jsonl line names this file");
      }
    }
  }

  /** The index's blocks against history.bin, then each block inflated. */
  async #checkMesh(skipped: string[]): Promise<void> {
    const index = this.#jsonl.get("mesh/history.jsonl");
    const bin = this.#meshBin;
    if (index === undefined || bin === null) return;
    if (!index.usable || !bin.complete) {
      skipped.push("Mesh block checks: mesh/history.jsonl or history.bin is cut short or invalid");
      return;
    }
    const blocks = [...this.#meshBlocks].sort((a, b) => a.offset - b.offset || a.line - b.line);
    const inside: MeshBlock[] = [];
    let end = 0;
    for (const block of blocks) {
      if (block.offset + block.bytes > bin.size) {
        this.#add(
          "mesh.block_outside_bin",
          "mesh/history.jsonl",
          `The block's ${block.bytes} bytes at offset ${block.offset} end past history.bin's ${bin.size} bytes`,
          block.line,
        );
      } else if (block.offset < end) {
        this.#add(
          "mesh.block_overlap",
          "mesh/history.jsonl",
          "The block overlaps another block in history.bin",
          block.line,
        );
      } else {
        inside.push(block);
        end = block.offset + block.bytes;
      }
    }
    if (bin.reread === undefined) {
      skipped.push(
        "Mesh block inflate check: the tar was read from a stream, which can't be read twice",
      );
      return;
    }
    this.#meshInflated = await checkMeshBlocks(
      inside,
      (start, length) => (bin.reread as RangeReader)(start, length),
      this.#limits.maxMeshBlockBytes,
      (code, line, message) => this.#add(code, "mesh/history.jsonl", message, line),
    );
  }

  info(): RecordingInfo {
    const lines: Record<string, number> = {};
    for (const [path, state] of [...this.#jsonl].sort(([a], [b]) => (a < b ? -1 : 1))) {
      lines[path] = state.lines;
    }
    return {
      lines,
      candidates: this.#candidates,
      candidates_kept: this.#keptFrames.size,
      mesh_blocks: this.#meshBlocks.length,
      mesh_inflated_bytes: this.#meshInflated,
    };
  }
}
