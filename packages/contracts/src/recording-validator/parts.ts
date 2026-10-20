// An export's parts (docs/session-recording.md, "Export and import"): parts.json and 0000.part,
// 0001.part and so on, which joined make the replay set's tar. The parts are read in order as
// one stream, so the tar is validated without a joined file ever being written; each part's and
// the whole tar's SHA-256 are worked out in the same pass.

import { createHash, type Hash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { readFileChunks } from "../bundle-validator/directory.ts";
import { parseJsonBytes } from "../bundle-validator/jsonl.ts";
import type { Reporter } from "../bundle-validator/report.ts";
import { describeSchemaError, schemaValidator } from "../bundle-validator/schemas.ts";
import { BundleIoError } from "../bundle-validator/source.ts";
import type { ExportParts } from "../generated/contracts.ts";
import { RECORDING_SET_SCHEMA_FILES, type RecordingLimits } from "../recording.ts";
import type { RecordingProblemCode } from "./codes.ts";

/** Schema errors reported for parts.json; the rest are left out. */
const SCHEMA_ERRORS = 5;

type PartsReporter = Reporter<RecordingProblemCode>;

/** A part on disk, with the size it has there. */
export interface PartFile {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  /** Its entry in parts.json. */
  readonly sha256: string;
}

async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch (cause) {
    if ((cause as { code?: unknown }).code === "ENOENT") return null;
    throw new BundleIoError(`Cannot read ${path}`, { cause });
  }
}

/** parts.json, if it is there, parses and matches its schema; problems are reported. */
export async function readPartsJson(
  dir: string,
  limits: RecordingLimits,
  reporter: PartsReporter,
): Promise<ExportParts | null> {
  const path = join(dir, "parts.json");
  const stats = await statOrNull(path);
  if (stats === null || !stats.isFile()) {
    reporter.add("file.missing", "parts.json", "parts.json is required beside the parts");
    return null;
  }
  if (stats.size > limits.maxJsonBytes) {
    reporter.add(
      "limits.file_size",
      "parts.json",
      `${stats.size} bytes; the limit is ${limits.maxJsonBytes} (maxJsonBytes)`,
    );
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    throw new BundleIoError(`Cannot read ${path}`, { cause });
  }
  const parsed = parseJsonBytes(bytes, false);
  if (!parsed.ok) {
    reporter.add("json.invalid", "parts.json", parsed.message);
    return null;
  }
  const validate = schemaValidator(RECORDING_SET_SCHEMA_FILES["parts.json"]);
  if (validate(parsed.value)) return parsed.value as ExportParts;
  for (const error of (validate.errors ?? []).slice(0, SCHEMA_ERRORS)) {
    reporter.add("schema.invalid", "parts.json", describeSchemaError(error));
  }
  return null;
}

/** A part's name: 0 is 0000.part. */
export function partName(index: number): string {
  return `${String(index).padStart(4, "0")}.part`;
}

/**
 * The rules parts.json's schema leaves to code, and each listed part on disk. Returns the parts
 * to read, or null when one is missing (the tar can't be put together).
 */
export async function checkParts(
  dir: string,
  parts: ExportParts,
  partBytes: number,
  reporter: PartsReporter,
): Promise<PartFile[] | null> {
  const misnamed = parts.parts.findIndex((part, index) => part.name !== partName(index));
  if (misnamed !== -1) {
    reporter.add(
      "parts.names",
      "parts.json",
      `Part ${misnamed} is not named ${partName(misnamed)}; the names run from 0000.part without gaps`,
    );
  }
  let total = 0;
  parts.parts.forEach((part, index) => {
    total += part.bytes;
    if (index < parts.parts.length - 1 && part.bytes !== partBytes) {
      reporter.add(
        "parts.part_size",
        "parts.json",
        `Part ${index} is ${part.bytes} bytes; every part but the last is ${partBytes}`,
      );
    }
  });
  if (total !== parts.tar_bytes) {
    reporter.add(
      "parts.tar_bytes",
      "parts.json",
      `The parts add up to ${total} bytes, but tar_bytes is ${parts.tar_bytes}`,
    );
  }
  const files: PartFile[] = [];
  let missing = false;
  for (const part of parts.parts) {
    const path = join(dir, part.name);
    const stats = await statOrNull(path);
    if (stats === null || !stats.isFile()) {
      reporter.add("parts.missing", part.name, "parts.json lists this part, but it is not here");
      missing = true;
      continue;
    }
    if (stats.size !== part.bytes) {
      reporter.add(
        "parts.bytes_mismatch",
        part.name,
        `${stats.size} bytes, but parts.json says ${part.bytes}`,
      );
    }
    files.push({ name: part.name, path, size: stats.size, sha256: part.sha256 });
  }
  return missing ? null : files;
}

/**
 * Reads the parts as one tar stream, hashing each part and the whole as the bytes pass, and reads
 * ranges of that tar again (for the mesh blocks).
 */
export class PartReader {
  readonly #files: readonly PartFile[];
  /** Where each part starts in the tar. */
  readonly #starts: readonly number[];
  readonly #whole: Hash = createHash("sha256");
  #partHash: Hash = createHash("sha256");
  /** The part being hashed, and how much of it has been. */
  #part = 0;
  #partBytes = 0;
  readonly #digests: string[] = [];

  constructor(files: readonly PartFile[]) {
    this.#files = files;
    let start = 0;
    this.#starts = files.map((file) => {
      const at = start;
      start += file.size;
      return at;
    });
  }

  /** The tar's bytes, from the parts on disk. */
  get bytes(): number {
    return this.#files.reduce((sum, file) => sum + file.size, 0);
  }

  /** Hashes `chunk`, which is the next bytes of the current part. */
  #hash(chunk: Uint8Array): void {
    this.#whole.update(chunk);
    this.#partHash.update(chunk);
    this.#partBytes += chunk.length;
  }

  #endPart(): void {
    this.#digests.push(this.#partHash.digest("hex"));
    this.#partHash = createHash("sha256");
    this.#part++;
    this.#partBytes = 0;
  }

  /** The rest of the parts, from where hashing has got to, hashing as they pass. */
  async *stream(): AsyncGenerator<Uint8Array> {
    while (this.#part < this.#files.length) {
      const file = this.#files[this.#part] as PartFile;
      for await (const chunk of readFileChunks(
        file.path,
        file.size - this.#partBytes,
        this.#partBytes,
      )) {
        this.#hash(chunk);
        yield chunk;
      }
      this.#endPart();
    }
  }

  /** `length` bytes of the tar from `start`, read from the parts again. */
  async *range(start: number, length: number): AsyncGenerator<Uint8Array> {
    let at = start;
    const end = start + length;
    for (let index = 0; index < this.#files.length && at < end; index++) {
      const file = this.#files[index] as PartFile;
      const partStart = this.#starts[index] as number;
      if (at >= partStart + file.size) continue;
      const take = Math.min(end, partStart + file.size) - at;
      yield* readFileChunks(file.path, take, at - partStart);
      at += take;
    }
    if (at < end) throw new BundleIoError("A range past the end of the parts");
  }

  /**
   * Hashes whatever the tar reader left unread (it stops at the end-of-archive marker or at a
   * fatal problem), then checks each part's SHA-256 and the whole tar's against parts.json.
   */
  async verify(parts: ExportParts, reporter: PartsReporter): Promise<void> {
    for await (const _chunk of this.stream()) {
      // stream() hashes as it reads.
    }
    this.#files.forEach((file, index) => {
      if (this.#digests[index] !== file.sha256) {
        reporter.add("parts.sha256_mismatch", file.name, "The SHA-256 differs from parts.json");
      }
    });
    if (this.#whole.digest("hex") !== parts.tar_sha256) {
      reporter.add(
        "parts.tar_sha256_mismatch",
        "parts.json",
        "The SHA-256 of the parts joined differs from tar_sha256",
      );
    }
  }
}
