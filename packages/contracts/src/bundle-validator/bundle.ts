// The validator's core: takes the source events of one bundle in a single pass, hashing every
// file and parsing what it needs as the bytes stream past, and keeps only small facts per file.
// The cross-file checks run at the end, so the order of tar members does not matter.

import { createHash } from "node:crypto";
import {
  type CaptureBundleJsonPath,
  DEPTH_SIZE,
  SCHEMA_VERSION,
  TRACKING_LIMITED_PREFIX,
} from "../capture-bundle.ts";
import type {
  BlurLine,
  CaptureAnchors,
  CaptureManifest,
  CaptureTags,
  ManifestFile,
  PoseLine,
  RefinedKeyframeLine,
  Transform,
} from "../generated/contracts.ts";
import { type ImageSize, JpegParser, type PngHeader, PngParser } from "./images.ts";
import { LineSplitter, parseJsonBytes } from "./jsonl.ts";
import {
  BUNDLE_DIRECTORY_PATTERN,
  type BundleFile,
  checkLayoutPath,
  checkMemberName,
  classifyBundlePath,
  type JsonlPath,
  type KeyframeDirectory,
  keyframeFilePath,
  REQUIRED_FILES,
} from "./layout.ts";
import type { BundleLimits } from "./limits.ts";
import { PlyParser, type PlyResult } from "./ply.ts";
import { failureReason, type ProblemCode, Reporter, type ValidationReport } from "./report.ts";
import { describeSchemaError, validatorFor } from "./schemas.ts";
import type { SourceEvent } from "./source.ts";

/** `facing` must have |y| and | |facing| - 1 | at most this. */
export const FACING_TOLERANCE = 1e-3;
/** A transform's last row must be [0, 0, 0, 1] within this, or a warning is given. */
export const AFFINE_TOLERANCE = 1e-4;
/** Schema errors reported per document or line; the rest are left out. */
const SCHEMA_ERRORS_PER_DOCUMENT = 5;
/**
 * A JSONL file with this many invalid lines is unusable for the cross-file checks, so its later
 * lines are not split or parsed, only hashed: a hostile file of millions of short bad lines then
 * costs no more than its digest.
 */
export const MAX_INVALID_JSONL_LINES = 100;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const INVALID = Symbol("invalid");

interface FileRecord {
  readonly bytes: number;
  /** Null when the content was not read in full (over its size limit, or cut short). */
  readonly sha256: string | null;
}

export interface Sink {
  push(chunk: Uint8Array): void;
  end(complete: boolean): void;
}

class JsonlState {
  lines = 0;
  invalidLines = 0;
  complete = false;
  lastFrame: number | null = null;
  lastT: number | null = null;
  splitter: LineSplitter | null = null;
  /** Usable for cross-file checks: read in full, and every line parsed and schema-valid. */
  get usable(): boolean {
    return this.complete && this.invalidLines === 0;
  }
}

/** What the cross-file checks share. */
interface CrossCheckContext {
  readonly manifest: CaptureManifest | null;
  /** manifest.files by path. */
  readonly listed: ReadonlyMap<string, ManifestFile>;
  /** poses.jsonl if it is usable, else null. */
  readonly poses: JsonlState | null;
  readonly blurUsable: boolean;
  /** The per-keyframe directories in use: confidence/ only if any confidence PNG is. */
  readonly keyframeDirectories: readonly KeyframeDirectory[];
  /** Files already reported missing, so the listing check doesn't report them again. */
  readonly reportedMissing: Set<string>;
  /** Files of quarantined keyframes, which are expected to be missing. */
  readonly quarantinedPaths: Set<string>;
}

const KEYFRAME_FILE_MISSING = {
  keyframes: { code: "keyframe.jpeg_missing", what: "JPEG" },
  depth: { code: "keyframe.depth_missing", what: "depth PNG" },
  confidence: { code: "keyframe.confidence_missing", what: "confidence PNG" },
} as const satisfies Record<KeyframeDirectory, { code: ProblemCode; what: string }>;

interface BlurFacts {
  readonly line: number;
  readonly right: number;
  readonly bottom: number;
}

/** A sink that keeps a copy of every chunk and hands over the whole file if it was complete. */
export function collectingSink(onEnd: (bytes: Uint8Array) => void): Sink {
  const pieces: Uint8Array[] = [];
  return {
    push: (chunk) => {
      pieces.push(chunk.slice());
    },
    end: (complete) => {
      if (complete) onEnd(Buffer.concat(pieces));
    },
  };
}

function isAffine(transform: Transform): boolean {
  const near = (value: number, expected: number) => Math.abs(value - expected) <= AFFINE_TOLERANCE;
  return (
    near(transform[3], 0) &&
    near(transform[7], 0) &&
    near(transform[11], 0) &&
    near(transform[15], 1)
  );
}

function boxes(count: number, kind: string): string {
  return `${count} ${kind} ${count === 1 ? "box" : "boxes"}`;
}

function sizeText(size: readonly number[]): string {
  return `[${size.join(", ")}]`;
}

/**
 * A version other than 1 (schema_version, or a recording's recording_version), described without
 * echoing the data: an integer is shown, any other value only by its type, since it could be a
 * whole document of personal data.
 */
export function describeVersion(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "number") return "a number that is not an integer";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/** Collects one bundle's events and produces its report. */
export class BundleCollector {
  readonly #limits: BundleLimits;
  readonly #quarantined: ReadonlySet<number>;
  readonly #reporter = new Reporter();
  readonly #seenNames = new Set<string>();
  readonly #files = new Map<string, FileRecord>();
  readonly #jsonl = new Map<JsonlPath, JsonlState>();
  readonly #jpegs = new Map<number, ImageSize>();
  readonly #pngs: Record<"depth" | "confidence", Map<number, PngHeader>> = {
    depth: new Map(),
    confidence: new Map(),
  };
  #top: string | null = null;
  #topValid = false;
  #fatal = false;
  #entries = 0;
  #bytes = 0;
  // JSON documents that parsed and passed their schema.
  #manifest: CaptureManifest | null = null;
  #versionMismatch: unknown = undefined;
  #anchors: CaptureAnchors | null = null;
  #tags: CaptureTags | null = null;
  #mesh: PlyResult | null = null;
  // Facts from JSONL lines that passed their schema.
  readonly #frames = new Set<number>();
  readonly #keyframes = new Set<number>();
  #keyframeLines = 0;
  readonly #tracking = { normal: 0, limited: 0, not_available: 0 };
  readonly #refined = new Map<number, number>();
  readonly #blur = new Map<number, BlurFacts>();
  #faceBoxes = 0;
  #screenBoxes = 0;
  /** Checks skipped while reading, for info.checks_skipped. */
  readonly #skippedWhileReading: string[] = [];

  constructor(limits: BundleLimits, quarantined: ReadonlySet<number>) {
    this.#limits = limits;
    this.#quarantined = quarantined;
  }

  #add(code: ProblemCode, file: string | null, message: string, line?: number): void {
    this.#reporter.add(code, file, message, line);
  }

  /**
   * A member name as reported: relative to the bundle directory once that is known, so problems
   * name files the same way in a tar and in a directory; otherwise the whole name.
   */
  #shown(name: string): string {
    const prefix = this.#top === null ? null : `${this.#top}/`;
    return prefix !== null && name.startsWith(prefix) && name.length > prefix.length
      ? name.slice(prefix.length)
      : name;
  }

  /** Reads every event. Throws only what the source throws (BundleIoError). */
  async consume(events: AsyncIterable<SourceEvent>): Promise<void> {
    for await (const event of events) await this.handle(event);
  }

  /**
   * Reads one event. validate-recording hands each bundle of a replay set its own events this
   * way, from the one tar of the set.
   */
  async handle(event: SourceEvent): Promise<void> {
    if (event.kind === "problem") {
      this.#add(event.code, event.name === null ? null : this.#shown(event.name), event.message);
      if (event.fatal) this.#fatal = true;
    } else if (event.kind === "directory") {
      this.#entries++;
      this.#checkName(event.name, true);
    } else {
      this.#entries++;
      await this.#readFile(event.name, event.size, event.open);
    }
  }

  /** Checks a member name; returns the path inside the bundle directory and its file kind. */
  #checkName(
    name: string,
    isDirectory: boolean,
  ): { inner: string; file: BundleFile | null } | null {
    const checked = checkMemberName(name, isDirectory);
    if (!checked.ok) {
      this.#add(checked.code, name, checked.message);
      return null;
    }
    const key = isDirectory && name.endsWith("/") ? name.slice(0, -1) : name;
    if (this.#seenNames.has(key)) {
      this.#add("entry.duplicate", this.#shown(name), "A second member with this name");
      return null;
    }
    this.#seenNames.add(key);
    if (this.#top === null) {
      this.#top = checked.top;
      this.#topValid = BUNDLE_DIRECTORY_PATTERN.test(checked.top);
      if (!this.#topValid) {
        this.#add(
          "path.outside_bundle_directory",
          checked.top,
          "The bundle directory must be named capture-<capture_id>, with a lowercase UUID",
        );
      }
    } else if (checked.top !== this.#top) {
      this.#add(
        "path.outside_bundle_directory",
        name,
        `Outside the bundle directory ${this.#top}/: a bundle has one top-level directory`,
      );
      return null;
    }
    const layout = checkLayoutPath(checked.inner, isDirectory);
    if (!layout.ok) {
      this.#add(layout.code, this.#shown(name), layout.message);
      return null;
    }
    return { inner: checked.inner, file: layout.file };
  }

  #limitFor(file: BundleFile): { limit: number; name: keyof BundleLimits } {
    switch (file.kind) {
      case "manifest":
      case "json":
      case "preview":
        return { limit: this.#limits.maxJsonBytes, name: "maxJsonBytes" };
      case "jsonl":
        return { limit: this.#limits.maxJsonlBytes, name: "maxJsonlBytes" };
      case "keyframe":
        return file.directory === "keyframes"
          ? { limit: this.#limits.maxJpegBytes, name: "maxJpegBytes" }
          : { limit: this.#limits.maxPngBytes, name: "maxPngBytes" };
      case "ply":
        return { limit: this.#limits.maxPlyBytes, name: "maxPlyBytes" };
    }
  }

  async #readFile(
    name: string,
    size: number,
    open: () => AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const checked = this.#checkName(name, false);
    if (checked === null || checked.file === null) return;
    const { inner, file } = checked;
    const { limit, name: limitName } = this.#limitFor(file);
    if (size > limit) {
      this.#add("limits.file_size", inner, `${size} bytes; the limit is ${limit} (${limitName})`);
      this.#files.set(inner, { bytes: size, sha256: null });
      return;
    }
    const sink = this.#sinkFor(inner, file);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of open()) {
      bytes += chunk.length;
      hash.update(chunk);
      sink.push(chunk);
    }
    const complete = bytes === size;
    sink.end(complete);
    this.#bytes += bytes;
    this.#files.set(inner, { bytes, sha256: complete ? hash.digest("hex") : null });
  }

  #sinkFor(inner: string, file: BundleFile): Sink {
    switch (file.kind) {
      case "manifest":
        return this.#jsonSink(inner, (value) => this.#readManifest(value));
      case "json":
        return this.#jsonSink(inner, (value) => {
          if (file.path === "anchors.json") {
            this.#anchors = this.#validate<CaptureAnchors>(file.path, value);
          } else {
            this.#tags = this.#validate<CaptureTags>(file.path, value);
          }
        });
      case "preview":
        return this.#previewSink(inner);
      case "jsonl":
        return this.#jsonlSink(file.path);
      case "keyframe":
        return file.directory === "keyframes"
          ? this.#jpegSink(inner, file.frame)
          : this.#pngSink(inner, file.directory, file.frame);
      case "ply":
        return this.#plySink(inner);
    }
  }

  /** Parses UTF-8 JSON; reports json.invalid and returns INVALID if it isn't. */
  #parseJson(bytes: Uint8Array, file: string, line?: number): unknown {
    const parsed = parseJsonBytes(bytes, line !== undefined);
    if (parsed.ok) return parsed.value;
    this.#add("json.invalid", file, parsed.message, line);
    return INVALID;
  }

  /** Validates against the file's schema; returns the value if valid, else null. */
  #validate<T>(path: CaptureBundleJsonPath, value: unknown, line?: number): T | null {
    const validate = validatorFor(path);
    if (validate(value)) return value as T;
    for (const error of (validate.errors ?? []).slice(0, SCHEMA_ERRORS_PER_DOCUMENT)) {
      this.#add("schema.invalid", path, describeSchemaError(error), line);
    }
    return null;
  }

  #jsonSink(inner: string, onValue: (value: unknown) => void): Sink {
    return collectingSink((bytes) => {
      const value = this.#parseJson(bytes, inner);
      if (value !== INVALID) onValue(value);
    });
  }

  #readManifest(value: unknown): void {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const version = (value as Record<string, unknown>)["schema_version"];
      if (version !== undefined && version !== SCHEMA_VERSION) {
        this.#versionMismatch = version;
        return;
      }
    }
    this.#manifest = this.#validate<CaptureManifest>("manifest.json", value);
  }

  #previewSink(inner: string): Sink {
    return collectingSink((bytes) => {
      let value: unknown;
      try {
        value = JSON.parse(decoder.decode(bytes));
      } catch {
        value = undefined;
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        this.#add("preview.invalid_json", inner, "Not a UTF-8 JSON object (GeoJSON)");
      }
    });
  }

  #jsonlSink(path: JsonlPath): Sink {
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
  #invalidLine(path: JsonlPath, state: JsonlState, line: number): void {
    state.invalidLines++;
    if (state.invalidLines === MAX_INVALID_JSONL_LINES) {
      state.splitter?.stop();
      this.#skippedWhileReading.push(
        `${path} after line ${line}: ${MAX_INVALID_JSONL_LINES} lines are invalid, so the rest is not parsed`,
      );
    }
  }

  #jsonlLine(path: JsonlPath, state: JsonlState, bytes: Uint8Array, line: number): void {
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
    const frame = value["frame"];
    if (typeof frame === "number") {
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
    const t = value["t"];
    if (typeof t === "number") {
      if (state.lastT !== null && t <= state.lastT) {
        this.#add(
          "order.t",
          path,
          "t does not increase: it is not greater than on the line before",
          line,
        );
      }
      state.lastT = t;
    }
    switch (path) {
      case "poses.jsonl":
        this.#poseLine(value as unknown as PoseLine, line);
        break;
      case "refined_keyframes.jsonl":
        this.#refinedLine(value as unknown as RefinedKeyframeLine, line);
        break;
      case "privacy/blur.jsonl":
        this.#blurLine(value as unknown as BlurLine, line);
        break;
      default:
        break;
    }
  }

  #checkTransform(transform: Transform, file: string, line?: number): void {
    if (!isAffine(transform)) {
      this.#add(
        "transform.not_affine",
        file,
        "The transform's last row is not [0, 0, 0, 1]; transforms are column-major, with the translation in elements 12 to 14",
        line,
      );
    }
  }

  #poseLine(pose: PoseLine, line: number): void {
    this.#frames.add(pose.frame);
    if (pose.keyframe) {
      this.#keyframes.add(pose.frame);
      this.#keyframeLines++;
    }
    if (pose.tracking === "normal") this.#tracking.normal++;
    else if (pose.tracking.startsWith(TRACKING_LIMITED_PREFIX)) this.#tracking.limited++;
    else this.#tracking.not_available++;
    this.#checkTransform(pose.transform, "poses.jsonl", line);
  }

  #refinedLine(refined: RefinedKeyframeLine, line: number): void {
    if (!this.#refined.has(refined.frame)) this.#refined.set(refined.frame, line);
    this.#checkTransform(refined.transform, "refined_keyframes.jsonl", line);
  }

  #blurLine(blur: BlurLine, line: number): void {
    let right = 0;
    let bottom = 0;
    for (const box of blur.boxes) {
      right = Math.max(right, box.x + box.w);
      bottom = Math.max(bottom, box.y + box.h);
      if (box.kind === "face") this.#faceBoxes++;
      else if (box.kind === "screen") this.#screenBoxes++;
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
            `${jpeg.components} ${jpeg.components === 1 ? "component" : "components"}; a keyframe JPEG is 3-component colour (YCbCr)`,
          );
        }
        if (jpeg.extraImage !== null) {
          this.#add(
            "jpeg.extra_image",
            inner,
            `${jpeg.extraImage}; a keyframe JPEG holds its one blurred image and nothing else`,
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

  #plySink(inner: string): Sink {
    const parser = new PlyParser(this.#limits, (problem) =>
      this.#add(problem.code, inner, problem.message),
    );
    return {
      push: (chunk) => parser.push(chunk),
      end: (complete) => {
        this.#mesh = parser.end(complete);
      },
    };
  }

  // Cross-file checks

  #has(path: string): boolean {
    return this.#files.has(path);
  }

  /** Runs the cross-file checks and builds the report. */
  finish(source: "tar" | "directory"): ValidationReport {
    if (!this.#fatal && this.#versionMismatch !== undefined) {
      this.#reporter.dropContentProblems();
      this.#add(
        "manifest.schema_version",
        "manifest.json",
        `schema_version is ${describeVersion(this.#versionMismatch)}; this validator reads version ${SCHEMA_VERSION}`,
      );
      return this.#report(source, [
        `Content checks: the bundle is not schema_version ${SCHEMA_VERSION}`,
      ]);
    }
    const skipped: string[] = [];
    if (this.#fatal) skipped.push("Cross-file checks: the bundle could not be read to the end");
    else this.#crossChecks(skipped);
    skipped.push(...this.#skippedWhileReading);
    return this.#report(source, skipped);
  }

  #crossChecks(skipped: string[]): void {
    const manifest = this.#manifest;
    const poses = this.#jsonl.get("poses.jsonl");
    const listed = this.#listedFiles(manifest);
    const confidenceInUse = [...this.#files.keys(), ...listed.keys()].some((path) =>
      path.startsWith("confidence/"),
    );
    const context: CrossCheckContext = {
      manifest,
      listed,
      poses: poses?.usable === true ? poses : null,
      blurUsable: this.#jsonl.get("privacy/blur.jsonl")?.usable === true,
      keyframeDirectories: confidenceInUse
        ? ["keyframes", "depth", "confidence"]
        : ["keyframes", "depth"],
      reportedMissing: new Set(),
      quarantinedPaths: new Set(),
    };

    this.#checkRequiredFiles(context);
    this.#checkBundleDirectory(manifest);
    this.#checkQuarantine(context);
    if (context.poses !== null) {
      this.#checkFrames(context, context.poses);
    } else {
      skipped.push(
        "Frame and keyframe checks: poses.jsonl is missing, cut short or has invalid lines",
      );
    }
    if (manifest !== null) {
      this.#checkListing(context, manifest);
      this.#checkManifestValues(context, manifest);
    } else {
      skipped.push(
        this.#has("manifest.json")
          ? "Checks against manifest.json: it is not valid"
          : "Checks against manifest.json: it is missing",
      );
    }
    this.#checkAnchors(context);
  }

  #checkRequiredFiles(context: CrossCheckContext): void {
    for (const path of REQUIRED_FILES) {
      if (!this.#has(path)) {
        this.#add("file.missing", path, `${path} is required but missing`);
        context.reportedMissing.add(path);
      }
    }
  }

  /** manifest.files by path; a path listed twice is reported. */
  #listedFiles(manifest: CaptureManifest | null): Map<string, ManifestFile> {
    const listed = new Map<string, ManifestFile>();
    for (const entry of manifest?.files ?? []) {
      if (listed.has(entry.path)) {
        this.#add(
          "files.duplicate_listing",
          "manifest.json",
          `manifest.files lists ${entry.path} twice`,
        );
      } else {
        listed.set(entry.path, entry);
      }
    }
    return listed;
  }

  #checkBundleDirectory(manifest: CaptureManifest | null): void {
    const top = this.#top;
    if (manifest === null || top === null || !this.#topValid) return;
    if (top !== `capture-${manifest.capture_id}`) {
      this.#add(
        "bundle.capture_id_mismatch",
        top,
        `The bundle directory is ${top}, but manifest.capture_id is ${manifest.capture_id}`,
      );
    }
  }

  /** Quarantined keyframes: their files must be gone but still listed. */
  #checkQuarantine(context: CrossCheckContext): void {
    for (const frame of this.#quarantined) {
      if (context.poses !== null && !this.#keyframes.has(frame)) {
        this.#add(
          "quarantine.not_keyframe",
          null,
          `Frame ${frame} is quarantined, but it is not a keyframe in poses.jsonl`,
        );
        continue;
      }
      for (const directory of context.keyframeDirectories) {
        const path = keyframeFilePath(directory, frame);
        context.quarantinedPaths.add(path);
        if (this.#has(path)) {
          this.#add(
            "quarantine.file_present",
            path,
            `Frame ${frame} is quarantined, so this file should have been removed`,
          );
        } else if (context.manifest !== null && !context.listed.has(path)) {
          this.#add(
            "quarantine.file_not_listed",
            path,
            `Frame ${frame} is quarantined; its removed file must still be listed in manifest.files`,
          );
        }
      }
    }
  }

  /** Frames and keyframes, against a usable poses.jsonl. */
  #checkFrames(context: CrossCheckContext, poses: JsonlState): void {
    const { manifest } = context;
    if (manifest !== null && manifest.frame_count !== poses.lines) {
      this.#add(
        "manifest.frame_count",
        "manifest.json",
        `frame_count is ${manifest.frame_count}, but poses.jsonl has ${poses.lines} lines`,
      );
    }
    if (manifest !== null && manifest.keyframe_count !== this.#keyframeLines) {
      this.#add(
        "manifest.keyframe_count",
        "manifest.json",
        `keyframe_count is ${manifest.keyframe_count}, but poses.jsonl has ${this.#keyframeLines} keyframe lines`,
      );
    }
    for (const frame of [...this.#keyframes].sort((a, b) => a - b)) {
      if (!this.#quarantined.has(frame)) {
        for (const directory of context.keyframeDirectories) {
          const path = keyframeFilePath(directory, frame);
          if (this.#has(path)) continue;
          const { code, what } = KEYFRAME_FILE_MISSING[directory];
          const others = directory === "confidence" ? ", while other keyframes have one" : "";
          this.#add(code, path, `Keyframe ${frame} has no ${what}: ${path} is missing${others}`);
          context.reportedMissing.add(path);
        }
      }
      if (context.blurUsable && !this.#blur.has(frame)) {
        this.#add(
          "keyframe.blur_line_missing",
          "privacy/blur.jsonl",
          `Keyframe ${frame} has no line in privacy/blur.jsonl`,
        );
      }
    }
    for (const path of this.#files.keys()) {
      const file = classifyBundlePath(path);
      if (file?.kind !== "keyframe" || this.#keyframes.has(file.frame)) continue;
      const why = this.#frames.has(file.frame) ? "is not a keyframe" : "is not in poses.jsonl";
      this.#add("keyframe.unexpected_file", path, `Frame ${file.frame} ${why}`);
    }
    if (context.blurUsable) {
      for (const [frame, facts] of this.#blur) {
        if (!this.#keyframes.has(frame)) {
          this.#add(
            "blur.not_keyframe",
            "privacy/blur.jsonl",
            `Frame ${frame} is not a keyframe in poses.jsonl`,
            facts.line,
          );
        }
      }
    }
    for (const [frame, line] of this.#refined) {
      if (!this.#keyframes.has(frame)) {
        this.#add(
          "refined.not_keyframe",
          "refined_keyframes.jsonl",
          `Frame ${frame} is not a keyframe in poses.jsonl`,
          line,
        );
      }
    }
    this.#tags?.forEach((tag, index) => {
      if (!this.#frames.has(tag.frame)) {
        this.#add(
          "tags.frame_not_in_poses",
          "tags.json",
          `Tag ${index} (${tag.type} ${tag.kind}) has frame ${tag.frame}, which is not in poses.jsonl`,
        );
      }
    });
  }

  /** Every file listed, every listed file present, sizes and digests. */
  #checkListing(context: CrossCheckContext, manifest: CaptureManifest): void {
    for (const entry of manifest.files) {
      if (context.listed.get(entry.path) !== entry) continue; // a duplicate listing
      const record = this.#files.get(entry.path);
      if (record === undefined) {
        const expected =
          context.quarantinedPaths.has(entry.path) || context.reportedMissing.has(entry.path);
        if (!expected) {
          this.#add(
            "files.listed_but_missing",
            entry.path,
            "Listed in manifest.files, but not in the bundle",
          );
        }
      } else if (record.sha256 === null) {
        // Not read because it is over its size limit, which is reported already.
      } else if (record.bytes !== entry.bytes) {
        this.#add(
          "files.bytes_mismatch",
          entry.path,
          `${record.bytes} bytes, but manifest.files says ${entry.bytes}`,
        );
      } else if (record.sha256 !== entry.sha256) {
        this.#add("files.sha256_mismatch", entry.path, "The SHA-256 differs from manifest.files");
      }
    }
    for (const path of this.#files.keys()) {
      if (path !== "manifest.json" && !context.listed.has(path)) {
        this.#add("files.not_listed", path, "In the bundle, but not listed in manifest.files");
      }
    }
  }

  /** Image sizes, blur boxes and counts, and times, against manifest.json. */
  #checkManifestValues(context: CrossCheckContext, manifest: CaptureManifest): void {
    const imageSize = sizeText(manifest.image_size);
    const depthSize = sizeText(manifest.depth_size);
    const [imageWidth, imageHeight] = manifest.image_size;
    const [depthWidth, depthHeight] = manifest.depth_size;
    if (depthWidth !== DEPTH_SIZE[0] || depthHeight !== DEPTH_SIZE[1]) {
      this.#add(
        "manifest.depth_size",
        "manifest.json",
        `depth_size is ${depthSize}; it is always ${sizeText(DEPTH_SIZE)}, ARKit's scene depth in the sensor's landscape orientation`,
      );
    }
    const portrait = [
      ...(imageWidth < imageHeight ? [`image_size ${imageSize}`] : []),
      ...(depthWidth < depthHeight ? [`depth_size ${depthSize}`] : []),
    ];
    if (portrait.length > 0) {
      this.#add(
        "manifest.orientation",
        "manifest.json",
        `${portrait.join(" and ")} ${portrait.length === 1 ? "is" : "are"} portrait; images are written in the sensor's native landscape orientation, not rotated for display`,
      );
    } else if (imageWidth * depthHeight !== depthWidth * imageHeight) {
      this.#add(
        "manifest.aspect_ratio",
        "manifest.json",
        `image_size ${imageSize} and depth_size ${depthSize} have different aspect ratios`,
      );
    }
    const imagePixels = imageWidth * imageHeight;
    if (imagePixels > this.#limits.maxImagePixels) {
      this.#add(
        "limits.image_pixels",
        "manifest.json",
        `image_size ${imageSize} is ${imagePixels} pixels; the limit is ${this.#limits.maxImagePixels} (maxImagePixels)`,
      );
    }
    for (const [frame, size] of this.#jpegs) {
      if (size.width !== imageWidth || size.height !== imageHeight) {
        this.#add(
          "jpeg.size_mismatch",
          keyframeFilePath("keyframes", frame),
          `${size.width} x ${size.height} pixels, but image_size is ${imageSize}`,
        );
      }
    }
    for (const directory of ["depth", "confidence"] as const) {
      for (const [frame, png] of this.#pngs[directory]) {
        if (png.width !== depthWidth || png.height !== depthHeight) {
          this.#add(
            "png.size_mismatch",
            keyframeFilePath(directory, frame),
            `${png.width} x ${png.height} pixels, but depth_size is ${depthSize}`,
          );
        }
      }
    }
    for (const [frame, facts] of this.#blur) {
      if (facts.right > imageWidth || facts.bottom > imageHeight) {
        this.#add(
          "blur.box_outside_image",
          "privacy/blur.jsonl",
          `A box for frame ${frame} reaches x = ${facts.right}, y = ${facts.bottom}, beyond image_size ${imageSize}`,
          facts.line,
        );
      }
    }
    if (context.blurUsable) {
      const { faces_blurred, screens_blurred } = manifest.privacy;
      if (faces_blurred !== this.#faceBoxes) {
        this.#add(
          "manifest.faces_blurred",
          "manifest.json",
          `privacy.faces_blurred is ${faces_blurred}, but privacy/blur.jsonl has ${boxes(this.#faceBoxes, "face")}`,
        );
      }
      if (screens_blurred !== this.#screenBoxes) {
        this.#add(
          "manifest.screens_blurred",
          "manifest.json",
          `privacy.screens_blurred is ${screens_blurred}, but privacy/blur.jsonl has ${boxes(this.#screenBoxes, "screen")}`,
        );
      }
    }
    const session = Date.parse(manifest.session_started_at);
    const started = Date.parse(manifest.started_at);
    const ended = Date.parse(manifest.ended_at);
    if (!(session <= started && started <= ended)) {
      this.#add(
        "manifest.time_order",
        "manifest.json",
        "Expected session_started_at <= started_at <= ended_at",
      );
    }
  }

  #checkAnchors(context: CrossCheckContext): void {
    const anchors = this.#anchors;
    if (anchors === null) return;
    const starts = anchors.filter((anchor) => anchor.role === "start").length;
    const ends = anchors.filter((anchor) => anchor.role === "end").length;
    if (starts !== 1 || ends !== 1) {
      this.#add(
        "anchors.roles",
        "anchors.json",
        `${starts} start and ${ends} end anchors; a segment has exactly one of each`,
      );
    }
    anchors.forEach((anchor, index) => {
      const label = `Anchor ${index} (${anchor.role})`;
      const [x, y, z] = anchor.facing;
      const length = Math.hypot(x, y, z);
      if (Math.abs(y) > FACING_TOLERANCE || Math.abs(length - 1) > FACING_TOLERANCE) {
        this.#add(
          "anchors.facing",
          "anchors.json",
          `${label}: facing has y = ${y.toFixed(4)} and length ${length.toFixed(4)}; it must be horizontal (|y| <= ${FACING_TOLERANCE}) and of unit length (within ${FACING_TOLERANCE})`,
        );
      }
      this.#checkTransform(anchor.transform, "anchors.json");
      const photo = classifyBundlePath(anchor.photo);
      const frame = photo?.kind === "keyframe" ? photo.frame : -1;
      if (this.#quarantined.has(frame)) {
        this.#add(
          "anchors.photo_quarantined",
          "anchors.json",
          `${label}: its photo ${anchor.photo} is a quarantined keyframe`,
        );
      } else if (context.poses !== null && !this.#keyframes.has(frame)) {
        this.#add(
          "anchors.photo_not_keyframe",
          "anchors.json",
          `${label}: its photo ${anchor.photo} is not a keyframe in poses.jsonl`,
        );
      } else if (!this.#has(anchor.photo) && !context.reportedMissing.has(anchor.photo)) {
        this.#add(
          "anchors.photo_missing",
          "anchors.json",
          `${label}: its photo ${anchor.photo} is not in the bundle`,
        );
      }
    });
  }

  #report(source: "tar" | "directory", skipped: string[]): ValidationReport {
    const { errors, warnings, omitted } = this.#reporter.finish();
    const poses = this.#jsonl.get("poses.jsonl");
    const posesUsable = !this.#fatal && poses?.usable === true;
    const frames = posesUsable && poses !== undefined ? poses.lines : null;
    return {
      valid: errors.length === 0,
      source,
      capture_id: this.#manifest?.capture_id ?? null,
      errors,
      warnings,
      omitted,
      info: {
        entries: this.#entries,
        bytes: this.#bytes,
        frames,
        keyframes: posesUsable ? this.#keyframeLines : null,
        tracking: posesUsable ? { ...this.#tracking } : null,
        limited_tracking_share:
          frames === null || frames === 0 ? null : this.#tracking.limited / frames,
        quarantined_frames: [...this.#quarantined].sort((a, b) => a - b),
        mesh: this.#mesh,
        checks_skipped: skipped,
      },
      failure_reason: failureReason(errors),
    };
  }
}
