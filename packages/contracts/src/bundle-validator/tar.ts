// A strict, streaming reader for uncompressed ustar archives, without dependencies. It reads
// from any async iterable of bytes (a Node stream from a file or from S3), holds at most one
// 512-byte header and the current chunk in memory, and never seeks.
//
// Supported: POSIX ustar headers (magic "ustar\0", version "00", with the 155-byte prefix field)
// and GNU-style headers (magic "ustar  \0") for regular files (type '0' or NUL) and directories
// (type '5'); octal size fields only (so members under 8 GiB); unsigned header checksums. The
// archive ends with two zero blocks, which may be followed only by zero padding (tar's record
// blocking). Everything else is reported: links, devices, FIFOs and contiguous files, pax
// extended and global headers, GNU long names and other extension headers, bad checksums,
// truncation and trailing data. The Swift packBundle writes plain ustar, and every bundle path
// fits in a 100-byte name.

import type { BundleLimits } from "./limits.ts";
import { BundleIoError, problem, type SourceEvent } from "./source.ts";

const BLOCK = 512;
const TRAILING_READ = 64 * 1024;
const EMPTY = new Uint8Array(0);

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new BundleIoError("The tar stream must yield bytes, not strings or objects");
}

/** Reads a byte stream in exact amounts, keeping only the current chunk. */
class ByteReader {
  readonly #iterator: AsyncIterator<unknown>;
  #pending: Uint8Array = EMPTY;
  #ended = false;
  /** Bytes consumed so far. */
  position = 0;

  constructor(source: AsyncIterable<unknown>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  async #fill(): Promise<boolean> {
    while (this.#pending.length === 0) {
      if (this.#ended) return false;
      let result: IteratorResult<unknown>;
      try {
        result = await this.#iterator.next();
      } catch (cause) {
        throw new BundleIoError("Reading the tar stream failed", { cause });
      }
      if (result.done === true) {
        this.#ended = true;
        return false;
      }
      this.#pending = toBytes(result.value);
    }
    return true;
  }

  #take(count: number): Uint8Array {
    const taken = this.#pending.subarray(0, count);
    this.#pending = this.#pending.subarray(count);
    this.position += count;
    return taken;
  }

  /** Reads `count` bytes into a new array; it is shorter only at the end of the stream. */
  async read(count: number): Promise<Uint8Array> {
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count && (await this.#fill())) {
      const piece = this.#take(Math.min(count - filled, this.#pending.length));
      out.set(piece, filled);
      filled += piece.length;
    }
    return filled === count ? out : out.subarray(0, filled);
  }

  /** Yields the next `count` bytes as views into the source's chunks; stops early at the end. */
  async *pieces(count: number): AsyncGenerator<Uint8Array> {
    let remaining = count;
    while (remaining > 0 && (await this.#fill())) {
      const piece = this.#take(Math.min(remaining, this.#pending.length));
      remaining -= piece.length;
      yield piece;
    }
  }

  /** Skips up to `count` bytes and returns how many were skipped. */
  async skip(count: number): Promise<number> {
    let skipped = 0;
    while (skipped < count && (await this.#fill())) {
      skipped += this.#take(Math.min(count - skipped, this.#pending.length)).length;
    }
    return skipped;
  }

  /** Stops reading the source (closes a Node stream). */
  async close(): Promise<void> {
    try {
      await this.#iterator.return?.();
    } catch {
      // The source is being abandoned; a failure to close it changes nothing.
    }
  }
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

/**
 * Parses an octal numeric field: optional leading spaces, at least one octal digit, then only
 * NULs or spaces. Returns null for anything else, including GNU base-256 values.
 */
function parseOctal(header: Uint8Array, start: number, length: number): number | null {
  let i = start;
  const end = start + length;
  while (i < end && header[i] === 0x20) i++;
  let value = 0;
  let digits = 0;
  while (i < end) {
    const byte = header[i] ?? 0;
    if (byte < 0x30 || byte > 0x37) break;
    value = value * 8 + (byte - 0x30);
    digits++;
    i++;
  }
  if (digits === 0) return null;
  for (; i < end; i++) {
    const byte = header[i];
    if (byte !== 0 && byte !== 0x20) return null;
  }
  return value;
}

/** A NUL-terminated field as a string, one character per byte (path rules reject non-ASCII). */
function readString(header: Uint8Array, start: number, length: number): string {
  let text = "";
  for (let i = start; i < start + length; i++) {
    const byte = header[i] ?? 0;
    if (byte === 0) break;
    text += String.fromCharCode(byte);
  }
  return text;
}

function hasBytes(header: Uint8Array, start: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (header[start + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

type ParsedHeader =
  | { readonly ok: true; readonly name: string; readonly size: number; readonly type: string }
  | {
      readonly ok: false;
      readonly code: "tar.bad_header" | "tar.bad_checksum";
      readonly message: string;
    };

function parseHeader(header: Uint8Array): ParsedHeader {
  const stored = parseOctal(header, 148, 8);
  if (stored === null) {
    return {
      ok: false,
      code: "tar.bad_header",
      message: "The header's checksum field is not octal",
    };
  }
  let computed = 0;
  for (let i = 0; i < BLOCK; i++) computed += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  if (stored !== computed) {
    return {
      ok: false,
      code: "tar.bad_checksum",
      message: `Header checksum mismatch (stored ${stored}, computed ${computed})`,
    };
  }
  const posix = hasBytes(header, 257, "ustar\u000000");
  const gnu = hasBytes(header, 257, "ustar  \u0000");
  if (!posix && !gnu) {
    return { ok: false, code: "tar.bad_header", message: "Not a ustar header (no ustar magic)" };
  }
  if (((header[124] ?? 0) & 0x80) !== 0) {
    return { ok: false, code: "tar.bad_header", message: "Base-256 size fields are not supported" };
  }
  const size = parseOctal(header, 124, 12);
  if (size === null) {
    return { ok: false, code: "tar.bad_header", message: "The header's size field is not octal" };
  }
  const name = readString(header, 0, 100);
  const prefix = posix ? readString(header, 345, 155) : "";
  return {
    ok: true,
    name: prefix === "" ? name : `${prefix}/${name}`,
    size,
    type: String.fromCharCode(header[156] ?? 0),
  };
}

const UNSUPPORTED_TYPES: Record<string, string> = {
  x: "A pax extended header",
  g: "A pax global header",
  L: "A GNU long name header",
  K: "A GNU long link name header",
};

const SPECIAL_TYPES: Record<string, string> = {
  "3": "A character device",
  "4": "A block device",
  "6": "A FIFO",
  "7": "A contiguous file (type 7)",
};

function paddedSize(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK;
}

/**
 * Reads a tar stream as source events. A fatal problem ends the events: the stream could not be
 * read past it. Throws BundleIoError only when the source itself fails.
 */
export async function* readTar(
  source: AsyncIterable<unknown>,
  limits: BundleLimits,
): AsyncGenerator<SourceEvent> {
  const reader = new ByteReader(source);
  try {
    let entries = 0;
    while (true) {
      const headerAt = reader.position;
      const header = await reader.read(BLOCK);
      if (header.length === 0) {
        const message =
          headerAt === 0
            ? "The tar is empty"
            : "The tar ends without its end-of-archive marker (two zero blocks)";
        yield problem("tar.truncated", null, message, true);
        return;
      }
      if (header.length < BLOCK) {
        yield problem("tar.truncated", null, "The tar ends inside a header", true);
        return;
      }

      if (isZeroBlock(header)) {
        const second = await reader.read(BLOCK);
        if (second.length < BLOCK) {
          yield problem(
            "tar.truncated",
            null,
            "The tar ends after one zero block; the end-of-archive marker is two",
            true,
          );
          return;
        }
        if (!isZeroBlock(second)) {
          yield problem("tar.bad_header", null, "A zero block in the middle of the archive", true);
          return;
        }
        // Only zero padding may follow the end-of-archive marker.
        while (true) {
          const rest = await reader.read(TRAILING_READ);
          if (rest.length === 0) return;
          if (!isZeroBlock(rest)) {
            yield problem("tar.trailing_data", null, "Data after the end-of-archive marker");
            return;
          }
          if (reader.position > limits.maxBundleBytes) {
            yield problem("limits.bundle_size", null, tooLarge(limits), true);
            return;
          }
        }
      }

      if (headerAt === 0 && header[0] === 0x1f && header[1] === 0x8b) {
        yield problem(
          "tar.bad_header",
          null,
          "This is gzip data; a bundle is an uncompressed tar",
          true,
        );
        return;
      }
      const parsed = parseHeader(header);
      if (!parsed.ok) {
        yield problem(parsed.code, null, `${parsed.message} (header at byte ${headerAt})`, true);
        return;
      }
      entries++;
      if (entries > limits.maxEntries) {
        yield problem(
          "limits.entry_count",
          null,
          `More than ${limits.maxEntries} entries (maxEntries)`,
          true,
        );
        return;
      }
      const { name, size, type } = parsed;
      const padded = paddedSize(size);
      if (reader.position + padded > limits.maxBundleBytes) {
        yield problem("limits.bundle_size", name, tooLarge(limits), true);
        return;
      }

      const bodyAt = reader.position;
      if (type === "0" || type === "\u0000") {
        let opened = false;
        yield {
          kind: "file",
          name,
          size,
          open: () => {
            if (opened) throw new Error(`${name} was opened twice`);
            opened = true;
            return reader.pieces(size);
          },
        };
      } else if (type === "5") {
        if (size > 0) {
          yield problem("tar.bad_header", name, "A directory entry with data");
        }
        yield { kind: "directory", name };
      } else if (type === "1" || type === "2") {
        const what = type === "1" ? "A hard link" : "A symbolic link";
        yield problem(
          "entry.link",
          name,
          `${what}; only regular files and directories are allowed`,
        );
      } else if (SPECIAL_TYPES[type] !== undefined) {
        yield problem(
          "entry.special_file",
          name,
          `${SPECIAL_TYPES[type]}; only regular files and directories are allowed`,
        );
      } else {
        const what = UNSUPPORTED_TYPES[type] ?? `An entry of type ${JSON.stringify(type)}`;
        yield problem("tar.unsupported_entry", name, `${what} is not supported`);
      }

      // Skip whatever the consumer did not read, then the padding to the next block.
      const remaining = bodyAt + padded - reader.position;
      if ((await reader.skip(remaining)) < remaining) {
        yield problem("tar.truncated", name, "The tar ends inside this member", true);
        return;
      }
    }
  } finally {
    await reader.close();
  }
}

function tooLarge(limits: BundleLimits): string {
  return `The tar is larger than ${limits.maxBundleBytes} bytes (maxBundleBytes)`;
}
