// Entry points: validate a recording directory, a replay set (a directory or a tar, from a file
// or a stream), or an export's parts.

import { createReadStream } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { readFileChunks, walkDirectory } from "../bundle-validator/directory.ts";
import { BUNDLE_DIRECTORY_PATTERN } from "../bundle-validator/layout.ts";
import { type BundleLimits, resolveLimits } from "../bundle-validator/limits.ts";
import {
  BundleIoError,
  problem,
  type RangeReader,
  READ_CHUNK_BYTES,
  type SourceEvent,
} from "../bundle-validator/source.ts";
import { readTar, type TarLimits } from "../bundle-validator/tar.ts";
import { UPLOAD_PART_BYTES } from "../capture-bundle.ts";
import { DEFAULT_RECORDING_LIMITS, type RecordingLimits } from "../recording.ts";
import { RECORDING_DIRECTORY_PATTERN, RECORDING_LAYOUT_DIRECTORIES } from "./layout.ts";
import { checkParts, PartReader, readPartsJson } from "./parts.ts";
import type { RecordingValidationReport } from "./report.ts";
import { SetCollector } from "./set.ts";

export interface ValidateRecordingOptions {
  /** Overrides for DEFAULT_RECORDING_LIMITS (tests use small ones). */
  readonly limits?: Partial<RecordingLimits>;
  /** Overrides for DEFAULT_BUNDLE_LIMITS, for the set's bundles. */
  readonly bundleLimits?: Partial<BundleLimits>;
  /** The export's part size, UPLOAD_PART_BYTES by default (tests use small parts). */
  readonly partBytes?: number;
}

interface Settings {
  readonly limits: RecordingLimits;
  readonly bundleLimits: BundleLimits;
  readonly partBytes: number;
}

/** DEFAULT_RECORDING_LIMITS with `overrides` applied; every value must be a positive integer. */
export function resolveRecordingLimits(overrides: Partial<RecordingLimits> = {}): RecordingLimits {
  const limits = { ...DEFAULT_RECORDING_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(
        `Recording limit ${name} must be a positive integer, got ${String(value)}`,
      );
    }
  }
  return Object.freeze(limits);
}

function settings(options: ValidateRecordingOptions): Settings {
  const partBytes = options.partBytes ?? UPLOAD_PART_BYTES;
  if (!Number.isSafeInteger(partBytes) || partBytes < 1) {
    throw new TypeError(`partBytes must be a positive integer, got ${String(partBytes)}`);
  }
  return {
    limits: resolveRecordingLimits(options.limits),
    bundleLimits: resolveLimits(options.bundleLimits),
    partBytes,
  };
}

/**
 * The tar reader's limits for a replay set: the export's whole tar, and entries enough for the
 * recording and the most bundles a recording can list (200 segments).
 */
function tarLimits({ limits, bundleLimits, partBytes }: Settings): TarLimits {
  return {
    maxBundleBytes: limits.maxExportParts * partBytes,
    maxEntries: limits.maxEntries + 200 * bundleLimits.maxEntries,
  };
}

/** The recording directory's walker limits. */
function recordingWalkLimits({ limits }: Settings): TarLimits {
  return { maxBundleBytes: limits.maxRecordingBytes, maxEntries: limits.maxEntries };
}

/**
 * Validates a replay set's tar read from `source` (a Node stream or any async iterable of byte
 * chunks), read once. `range`, when the tar can be read again, lets the mesh blocks be inflated;
 * without it that check is skipped. Rejects with BundleIoError if the source fails.
 */
export async function validateRecordingTar(
  source: AsyncIterable<unknown>,
  options: ValidateRecordingOptions = {},
  range?: RangeReader,
): Promise<RecordingValidationReport> {
  const resolved = settings(options);
  const set = new SetCollector(resolved.limits, resolved.bundleLimits, {
    mode: "tar",
    isSet: true,
    partBytes: resolved.partBytes,
  });
  await set.consume(readTar(source, tarLimits(resolved), range));
  return set.finish("tar");
}

/**
 * A replay set directory's events: its rec-<recording_id>/ walked with the recording layout, and
 * each capture-<capture_id>/ with the bundle layout. Anything else at the top is reported.
 */
async function* setDirectoryEvents(root: string, resolved: Settings): AsyncGenerator<SourceEvent> {
  let names: string[];
  try {
    names = (await readdir(root)).sort();
  } catch (cause) {
    throw new BundleIoError(`Cannot list ${root}`, { cause });
  }
  for (const name of names) {
    const path = join(root, name);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(path);
    } catch (cause) {
      throw new BundleIoError(`Cannot read ${path}`, { cause });
    }
    const isDirectory = stats.isDirectory() && !stats.isSymbolicLink();
    let events: AsyncIterable<SourceEvent> | null = null;
    if (stats.isSymbolicLink()) {
      yield problem("entry.link", name, "A symbolic link or junction; it was not followed");
      continue;
    }
    if (isDirectory && RECORDING_DIRECTORY_PATTERN.test(name)) {
      events = walkDirectory(path, recordingWalkLimits(resolved), RECORDING_LAYOUT_DIRECTORIES);
    } else if (isDirectory && BUNDLE_DIRECTORY_PATTERN.test(name)) {
      events = walkDirectory(path, resolved.bundleLimits);
    }
    if (events === null) {
      // The set collector reports this as path.outside_set.
      yield problem(
        "path.outside_bundle_directory",
        isDirectory ? `${name}/` : name,
        "Outside the replay set's directories",
      );
      continue;
    }
    for await (const event of events) {
      // The walker names a limit problem with no file; it belongs to this directory.
      yield event.kind === "problem" && event.name === null
        ? { ...event, name: `${name}/` }
        : event;
    }
  }
}

/**
 * Validates a recording directory, rec-<recording_id>/, alone (no segment is paired with its
 * bundle), or a replay set directory holding it and the session's capture-<capture_id>/ bundles.
 */
export async function validateRecordingDirectory(
  path: string,
  options: ValidateRecordingOptions = {},
): Promise<RecordingValidationReport> {
  const resolved = settings(options);
  const absolute = resolve(path);
  const isRecording = RECORDING_DIRECTORY_PATTERN.test(basename(absolute));
  const set = new SetCollector(resolved.limits, resolved.bundleLimits, {
    mode: "directory",
    isSet: !isRecording,
    partBytes: resolved.partBytes,
  });
  if (isRecording) {
    await set.consume(
      walkDirectory(absolute, recordingWalkLimits(resolved), RECORDING_LAYOUT_DIRECTORIES),
    );
    return set.finish("directory");
  }
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(absolute);
  } catch (cause) {
    throw new BundleIoError(`Cannot read ${path}`, { cause });
  }
  if (!stats.isDirectory()) throw new BundleIoError(`${path} is not a directory`);
  await set.consume(setDirectoryEvents(absolute, resolved));
  return set.finish("set_directory");
}

/**
 * Validates an export's folder: parts.json and the parts it lists, checked against it, then read
 * in order as the replay set's tar without writing a joined file.
 */
export async function validateRecordingParts(
  dir: string,
  options: ValidateRecordingOptions = {},
): Promise<RecordingValidationReport> {
  const resolved = settings(options);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(dir);
  } catch (cause) {
    throw new BundleIoError(`Cannot read ${dir}`, { cause });
  }
  if (!stats.isDirectory()) throw new BundleIoError(`${dir} is not a directory`);
  const set = new SetCollector(resolved.limits, resolved.bundleLimits, {
    mode: "tar",
    isSet: true,
    partBytes: resolved.partBytes,
  });
  const parts = await readPartsJson(dir, resolved.limits, set.reporter);
  if (parts === null) {
    return set.finish("parts", { skipped: ["The tar: parts.json is missing or not valid"] });
  }
  const files = await checkParts(dir, parts, resolved.partBytes, set.reporter);
  const counts = { parts: parts.parts.length, tarBytes: parts.tar_bytes };
  if (files === null) {
    return set.finish("parts", { ...counts, skipped: ["The tar: a part is missing"] });
  }
  const reader = new PartReader(files);
  await set.consume(
    readTar(reader.stream(), tarLimits(resolved), (start, length) => reader.range(start, length)),
  );
  await reader.verify(parts, set.reporter);
  const recordingId = set.recordingId;
  if (recordingId !== null && recordingId !== parts.recording_id) {
    set.reporter.add(
      "parts.recording_id_mismatch",
      "parts.json",
      `recording_id is ${parts.recording_id}, but the set's recording is rec-${recordingId}`,
    );
  }
  return set.finish("parts", counts);
}

/**
 * Validates a recording directory, a replay set directory or a replay set's tar file at `input`,
 * or a tar read from a stream.
 */
export async function validateRecording(
  input: string | AsyncIterable<unknown>,
  options: ValidateRecordingOptions = {},
): Promise<RecordingValidationReport> {
  if (typeof input !== "string") return validateRecordingTar(input, options);
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(input);
  } catch (cause) {
    throw new BundleIoError(`Cannot read ${input}`, { cause });
  }
  if (stats.isDirectory()) return validateRecordingDirectory(input, options);
  if (!stats.isFile()) throw new BundleIoError(`${input} is not a directory or a file`);
  return validateRecordingTar(
    createReadStream(input, { highWaterMark: READ_CHUNK_BYTES }),
    options,
    (start, length) => readFileChunks(input, length, start),
  );
}
