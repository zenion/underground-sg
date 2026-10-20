// A replay set (docs/session-recording.md, "Replay sets"): one rec-<recording_id>/ directory and
// the session's capture-<capture_id>/ bundles, from one tar or from directories. Each member goes
// to the recording's collector or to its bundle's BundleCollector, so every bundle gets
// validate-bundle's own report; then each kept segment is paired with its bundle.

import { createHash } from "node:crypto";
import { BundleCollector } from "../bundle-validator/bundle.ts";
import { BUNDLE_DIRECTORY_PATTERN, checkMemberName } from "../bundle-validator/layout.ts";
import type { BundleLimits } from "../bundle-validator/limits.ts";
import {
  failureReason,
  type ProblemCode,
  Reporter,
  type ValidationReport,
} from "../bundle-validator/report.ts";
import { problem, type SourceEvent } from "../bundle-validator/source.ts";
import type { RecordingManifest } from "../generated/contracts.ts";
import type { RecordingLimits } from "../recording.ts";
import { RECORDING_PROBLEM_CODES, type RecordingProblemCode } from "./codes.ts";
import { RECORDING_DIRECTORY_PATTERN } from "./layout.ts";
import { RecordingCollector } from "./recording.ts";
import { type BundleResult, type RecordingValidationReport, WHOLE_SET } from "./report.ts";

export interface SetOptions {
  /**
   * `tar`: one stream (a tar file, a stream or an export's parts), where a fatal problem stops
   * everything. `directory`: one walk per directory, where it stops only that directory's.
   */
  readonly mode: "tar" | "directory";
  /**
   * A replay set, so each kept segment has its bundle beside the recording. A set is checked as
   * exported: every kept segment has its end_t and manifest_sha256.
   */
  readonly isSet: boolean;
  /** The tar's limit, for messages: maxExportParts parts of this many bytes. */
  readonly partBytes: number;
}

interface BundleState {
  readonly collector: BundleCollector;
  entries: number;
  bytes: number;
  /** Over a limit: its later members are skipped. */
  stopped: boolean;
  /** SHA-256 of its manifest.json, once read in full. */
  manifestSha256: string | null;
}

/** The first segment of a member name. */
function topOf(name: string): string {
  const slash = name.indexOf("/");
  return slash === -1 ? name : name.slice(0, slash);
}

/** `open`, hashing the content as it passes; `done` gets the digest if it was all read. */
function hashing(
  open: () => AsyncIterable<Uint8Array>,
  size: number,
  done: (sha256: string) => void,
): () => AsyncIterable<Uint8Array> {
  return async function* () {
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of open()) {
      hash.update(chunk);
      bytes += chunk.length;
      yield chunk;
    }
    if (bytes === size) done(hash.digest("hex"));
  };
}

export class SetCollector {
  readonly reporter = new Reporter<RecordingProblemCode>(RECORDING_PROBLEM_CODES);
  readonly #limits: RecordingLimits;
  readonly #bundleLimits: BundleLimits;
  readonly #options: SetOptions;
  #recording: RecordingCollector | null = null;
  #recordingTop: string | null = null;
  readonly #bundles = new Map<string, BundleState>();
  /** Top-level names already reported as outside the set. */
  readonly #outside = new Set<string>();
  /** Reading stopped early: everything (tar mode) or the recording (directory mode). */
  #fatal = false;
  #entries = 0;
  #bytes = 0;

  constructor(limits: RecordingLimits, bundleLimits: BundleLimits, options: SetOptions) {
    this.#limits = limits;
    this.#bundleLimits = bundleLimits;
    this.#options = options;
  }

  /** recording.json, if it is valid. */
  get manifest(): RecordingManifest | null {
    return this.#recording?.manifest ?? null;
  }

  /** The recording_id from the recording directory's name, if there is a recording. */
  get recordingId(): string | null {
    const top = this.#recordingTop;
    return top === null ? null : (RECORDING_DIRECTORY_PATTERN.exec(top)?.[1] ?? null);
  }

  /** A member name as reported: relative to the recording directory when it is inside it. */
  #shown(name: string): string {
    const prefix = this.#recordingTop === null ? null : `${this.#recordingTop}/`;
    return prefix !== null && name.startsWith(prefix) && name.length > prefix.length
      ? name.slice(prefix.length)
      : name;
  }

  /** A container problem from the tar reader, the walker or the name rules, as a recording code. */
  #fromSource(code: ProblemCode, message: string): [RecordingProblemCode, string] {
    if (code === "limits.bundle_size") {
      return this.#options.mode === "tar"
        ? [
            "limits.set_size",
            `The tar is larger than ${this.#limits.maxExportParts * this.#options.partBytes} bytes (maxExportParts parts of ${this.#options.partBytes} bytes)`,
          ]
        : [
            "limits.recording_size",
            `The recording is larger than ${this.#limits.maxRecordingBytes} bytes (maxRecordingBytes)`,
          ];
    }
    if (code === "path.outside_bundle_directory") {
      return [
        "path.outside_set",
        "Outside rec-<recording_id>/ and the capture-<capture_id>/ bundles: a replay set holds only those",
      ];
    }
    if (Object.hasOwn(RECORDING_PROBLEM_CODES, code)) {
      return [code as RecordingProblemCode, message];
    }
    throw new Error(`No recording problem code for ${code}`);
  }

  #bundle(top: string): BundleState {
    let state = this.#bundles.get(top);
    if (state === undefined) {
      state = {
        collector: new BundleCollector(this.#bundleLimits, new Set()),
        entries: 0,
        bytes: 0,
        stopped: false,
        manifestSha256: null,
      };
      this.#bundles.set(top, state);
    }
    return state;
  }

  #isBundleTop(top: string): boolean {
    return this.#options.isSet && BUNDLE_DIRECTORY_PATTERN.test(top);
  }

  async consume(events: AsyncIterable<SourceEvent>): Promise<void> {
    for await (const event of events) await this.handle(event);
  }

  /** Reads one event. Throws only what the source throws (BundleIoError). */
  async handle(event: SourceEvent): Promise<void> {
    if (event.kind === "problem") {
      await this.#problem(event);
      return;
    }
    const isDirectory = event.kind === "directory";
    this.#entries++;
    if (event.kind === "file") this.#bytes += event.size;
    const checked = checkMemberName(event.name, isDirectory);
    if (!checked.ok) {
      const [code, message] = this.#fromSource(checked.code, checked.message);
      this.reporter.add(code, this.#shown(event.name), message);
      return;
    }
    const { top, inner } = checked;
    if (this.#isBundleTop(top)) {
      await this.#toBundle(top, inner, event);
    } else if (RECORDING_DIRECTORY_PATTERN.test(top) && (this.#recordingTop ?? top) === top) {
      if (this.#recording === null) {
        this.#recordingTop = top;
        this.#recording = new RecordingCollector(this.reporter, this.#limits, top);
      }
      if (event.kind === "directory") this.#recording.directory(inner);
      else await this.#recording.file(inner, event.size, event.open, event.reread);
    } else if (!this.#outside.has(top)) {
      this.#outside.add(top);
      const why = RECORDING_DIRECTORY_PATTERN.test(top)
        ? "A second recording directory: a replay set holds one recording"
        : "Not rec-<recording_id>/ or capture-<capture_id>/: a replay set holds only those";
      this.reporter.add("path.outside_set", top, why);
    }
  }

  async #problem(event: Extract<SourceEvent, { kind: "problem" }>): Promise<void> {
    const top = event.name === null ? null : topOf(event.name);
    if (
      top !== null &&
      this.#isBundleTop(top) &&
      (this.#options.mode === "directory" || !event.fatal)
    ) {
      // In directory mode each bundle has its own walk, so a fatal problem stops only that one.
      await this.#bundle(top).collector.handle(event);
      return;
    }
    const [code, message] = this.#fromSource(event.code, event.message);
    this.reporter.add(code, event.name === null ? null : this.#shown(event.name), message);
    if (!event.fatal) return;
    this.#fatal = true;
    if (this.#options.mode === "tar") {
      // Nothing after this was read, so no bundle can be checked across its files either.
      for (const bundle of this.#bundles.values()) await bundle.collector.handle(event);
    }
  }

  async #toBundle(
    top: string,
    inner: string,
    event: Exclude<SourceEvent, { kind: "problem" }>,
  ): Promise<void> {
    const bundle = this.#bundle(top);
    if (bundle.stopped) return;
    bundle.entries++;
    if (event.kind === "file") bundle.bytes += event.size;
    const limits = this.#bundleLimits;
    if (bundle.entries > limits.maxEntries || bundle.bytes > limits.maxBundleBytes) {
      bundle.stopped = true;
      await bundle.collector.handle(
        bundle.entries > limits.maxEntries
          ? problem(
              "limits.entry_count",
              null,
              `More than ${limits.maxEntries} entries (maxEntries)`,
              true,
            )
          : problem(
              "limits.bundle_size",
              event.name,
              `The bundle is larger than ${limits.maxBundleBytes} bytes (maxBundleBytes)`,
              true,
            ),
      );
      return;
    }
    if (event.kind === "file" && inner === "manifest.json") {
      const open = hashing(event.open, event.size, (sha256) => {
        bundle.manifestSha256 = sha256;
      });
      await bundle.collector.handle({ ...event, open });
    } else {
      await bundle.collector.handle(event);
    }
  }

  /** Runs every check that needs the whole input and builds the report. */
  async finish(
    source: RecordingValidationReport["source"],
    extra: {
      readonly skipped?: readonly string[];
      readonly parts?: number;
      readonly tarBytes?: number;
    } = {},
  ): Promise<RecordingValidationReport> {
    const skipped: string[] = [...(extra.skipped ?? [])];
    const recording = this.#recording;
    if (recording === null) {
      if (!this.#fatal && skipped.length === 0) {
        this.reporter.add("set.no_recording", null, "No rec-<recording_id>/ directory");
      }
    } else {
      skipped.push(...(await recording.finish(this.#fatal)));
    }
    const bundles: BundleResult[] = [];
    const bundleSource = this.#options.mode === "tar" ? "tar" : "directory";
    for (const top of [...this.#bundles.keys()].sort()) {
      const report = (this.#bundles.get(top) as BundleState).collector.finish(bundleSource);
      bundles.push({ directory: top, report });
      if (!report.valid) this.#bundleInvalid(top, report);
    }
    const manifest = this.manifest;
    if (manifest !== null && !this.#fatal) {
      if (this.#options.isSet) this.#pairSegments(manifest);
      else
        skipped.push(
          "Segments against their bundles: a recording directory alone, without its replay set",
        );
    }
    const { errors, warnings, omitted } = this.reporter.finish();
    const info = recording?.info();
    return {
      valid: errors.length === 0 && bundles.every((bundle) => bundle.report.valid),
      source,
      recording_id: this.recordingId,
      errors,
      warnings,
      omitted,
      info: {
        entries: this.#entries,
        bytes: this.#bytes,
        profile: manifest?.profile ?? null,
        ended: manifest?.window.ended ?? null,
        closed: manifest?.closed ?? null,
        lines: info?.lines ?? {},
        candidates: info?.candidates ?? 0,
        candidates_kept: info?.candidates_kept ?? 0,
        mesh_blocks: info?.mesh_blocks ?? 0,
        mesh_inflated_bytes: info?.mesh_inflated_bytes ?? null,
        segments: manifest?.segments.length ?? null,
        parts: extra.parts ?? null,
        tar_bytes: extra.tarBytes ?? null,
        checks_skipped: skipped,
      },
      bundles,
      failure_reason: failureReason(errors, WHOLE_SET),
    };
  }

  #bundleInvalid(top: string, report: ValidationReport): void {
    const first = report.errors[0];
    const firstCode = first === undefined ? "" : `, the first ${first.code}`;
    this.reporter.add(
      "bundle.invalid",
      `${top}/`,
      `validate-bundle finds ${report.errors.length} ${report.errors.length === 1 ? "error" : "errors"}${firstCode} (see the bundle's report)`,
    );
  }

  /** Each kept segment against its bundle in the set, and each bundle against a segment. */
  #pairSegments(manifest: RecordingManifest): void {
    const kept = new Set<string>();
    manifest.segments.forEach((segment, index) => {
      const top = `capture-${segment.capture_id}`;
      const label = `Segment ${index} (${top})`;
      if (!segment.kept) return;
      kept.add(top);
      if (segment.end_t === null || segment.manifest_sha256 === null) {
        this.reporter.add(
          "segment.incomplete",
          "recording.json",
          `${label} is kept, but its ${segment.end_t === null ? "end_t" : "manifest_sha256"} is null; in an exported set every kept segment has both`,
        );
      }
      const bundle = this.#bundles.get(top);
      if (bundle === undefined) {
        this.reporter.add(
          "segment.bundle_missing",
          "recording.json",
          `${label}: ${top}/ is not in the set`,
        );
      } else if (
        segment.manifest_sha256 !== null &&
        bundle.manifestSha256 !== null &&
        bundle.manifestSha256 !== segment.manifest_sha256
      ) {
        this.reporter.add(
          "segment.manifest_sha256_mismatch",
          "recording.json",
          `${label}: manifest_sha256 differs from the SHA-256 of ${top}/manifest.json`,
        );
      }
    });
    for (const top of this.#bundles.keys()) {
      if (!kept.has(top)) {
        this.reporter.add(
          "segment.bundle_not_listed",
          `${top}/`,
          "No kept segment in recording.json is this bundle",
        );
      }
    }
  }
}
