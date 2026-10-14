// Image structure, streamed: a JPEG is walked marker by marker from SOI to EOI, and a PNG chunk
// by chunk from its IHDR to IEND. Pixel data is never decoded. Both report what the validator
// needs: the size and pixel format, and whether the file could hold a second image.

import { crc32 } from "node:zlib";

export type HeaderResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

export interface JpegInfo extends ImageSize {
  /** Image components in the frame header: 3 for colour (YCbCr), 1 for greyscale. */
  readonly components: number;
  /**
   * Why the file may hold a second image, or null: a thumbnail (JFIF, JFXX or Exif), an MPF
   * segment (which indexes further images) or bytes after EOI. The first one found.
   */
  readonly extraImage: string | null;
}

/** Start-of-frame markers (SOF0-3, 5-7, 9-11, 13-15); C4, C8 and CC are other segments. */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const SOS = 0xda;
const EOI = 0xd9;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;

/** Segments whose content is looked at; every other segment is skipped by its length. */
const COLLECTED_MARKERS = new Set([...SOF_MARKERS, APP0, APP1, APP2]);

function startsWith(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Whether an Exif APP1 segment (starting "Exif\0\0") has a thumbnail: a second IFD (IFD1)
 * after IFD0. Null if the TIFF structure can't be read, so a thumbnail can't be ruled out.
 */
function exifHasThumbnail(body: Uint8Array): boolean | null {
  const tiff = 6;
  if (body.length < tiff + 8) return null;
  const order = String.fromCharCode(body[tiff] ?? 0, body[tiff + 1] ?? 0);
  if (order !== "II" && order !== "MM") return null;
  const little = order === "II";
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (view.getUint16(tiff + 2, little) !== 42) return null;
  const ifd0 = view.getUint32(tiff + 4, little);
  const at = tiff + ifd0;
  if (ifd0 < 8 || at + 2 > body.length) return null;
  const next = at + 2 + view.getUint16(at, little) * 12;
  if (next + 4 > body.length) return null;
  return view.getUint32(next, little) !== 0;
}

type JpegState =
  | "soi0"
  | "soi1"
  | "marker"
  | "code"
  | "len0"
  | "len1"
  | "skip"
  | "collect"
  | "ecs"
  | "ecsFF"
  | "eoi"
  | "failed";

/**
 * Walks a JPEG while it streams past: SOI, marker segments, a frame header (SOFn), one or more
 * scans (SOS and their entropy-coded data, where FF 00 is a data byte and RSTn markers may
 * occur), and EOI. Fill bytes (extra FF before a marker) and standalone markers (RSTn, TEM)
 * between segments are allowed; segments are skipped by their length, except the frame header
 * and APP0 to APP2, which are read for the size, the components and thumbnails. A scan before
 * the frame header, a second frame header or SOI, or anything other than a marker between
 * segments makes it invalid. Bytes after EOI are counted, not parsed. Linear in the file size.
 */
export class JpegParser {
  #state: JpegState = "soi0";
  #marker = 0;
  #lengthHigh = 0;
  /** Bytes left in the current segment's body (skip or collect). */
  #remaining = 0;
  #segment: Uint8Array = new Uint8Array(0);
  #collected = 0;
  #frame: { width: number; height: number; components: number } | null = null;
  #scans = 0;
  #extraImage: string | null = null;
  #trailingBytes = 0;
  #failure: string | null = null;

  /** True once the data is known to be invalid: nothing more needs to be pushed. */
  get done(): boolean {
    return this.#failure !== null;
  }

  #fail(message: string): void {
    this.#failure = message;
    this.#state = "failed";
  }

  #foundExtraImage(reason: string): void {
    this.#extraImage ??= reason;
  }

  push(chunk: Uint8Array): void {
    let i = 0;
    while (i < chunk.length) {
      switch (this.#state) {
        case "failed":
          return;
        case "skip": {
          const take = Math.min(this.#remaining, chunk.length - i);
          i += take;
          this.#remaining -= take;
          if (this.#remaining === 0) this.#segmentSkipped();
          continue;
        }
        case "collect": {
          const take = Math.min(this.#remaining, chunk.length - i);
          this.#segment.set(chunk.subarray(i, i + take), this.#collected);
          this.#collected += take;
          i += take;
          this.#remaining -= take;
          if (this.#remaining === 0) this.#segmentCollected();
          continue;
        }
        case "ecs": {
          const ff = chunk.indexOf(0xff, i);
          if (ff === -1) return;
          i = ff + 1;
          this.#state = "ecsFF";
          continue;
        }
        case "eoi":
          this.#trailingBytes += chunk.length - i;
          return;
        default:
          break;
      }
      const byte = chunk[i++] ?? 0;
      switch (this.#state) {
        case "soi0":
        case "soi1":
          if (byte !== (this.#state === "soi0" ? 0xff : 0xd8)) {
            this.#fail("Not a JPEG: it does not start with SOI (FF D8)");
          } else {
            this.#state = this.#state === "soi0" ? "soi1" : "marker";
          }
          break;
        case "marker":
          if (byte === 0xff) this.#state = "code";
          else this.#fail("Data where a marker should start (expected FF)");
          break;
        case "code":
          this.#readMarkerCode(byte);
          break;
        case "ecsFF":
          // In entropy-coded data, FF 00 is a data byte and RSTn a restart marker; FF FF is fill.
          if (byte === 0x00 || (byte >= 0xd0 && byte <= 0xd7)) this.#state = "ecs";
          else if (byte !== 0xff) this.#readMarkerCode(byte);
          break;
        case "len0":
          this.#lengthHigh = byte;
          this.#state = "len1";
          break;
        case "len1":
          this.#readLength(this.#lengthHigh * 256 + byte);
          break;
        default:
          break;
      }
    }
  }

  #readMarkerCode(code: number): void {
    if (code === 0xff) {
      this.#state = "code"; // a fill byte
    } else if (code === 0x00) {
      this.#fail("Invalid marker FF 00 between segments");
    } else if (code === 0xd8) {
      this.#fail("A second SOI marker");
    } else if (code === EOI) {
      if (this.#frame === null) this.#fail("End of image (EOI) before a frame header (SOFn)");
      else if (this.#scans === 0) this.#fail("End of image (EOI) before a scan (SOS)");
      else this.#state = "eoi";
    } else if (code === SOS && this.#frame === null) {
      this.#fail("Scan (SOS) before a frame header (SOFn)");
    } else if (SOF_MARKERS.has(code) && this.#frame !== null) {
      this.#fail("A second frame header (SOFn): only one frame is supported");
    } else if ((code >= 0xd0 && code <= 0xd7) || code === 0x01) {
      this.#state = "marker"; // RSTn and TEM have no length
    } else {
      this.#marker = code;
      this.#state = "len0";
    }
  }

  #readLength(length: number): void {
    if (length < 2) {
      this.#fail("A segment length below 2");
      return;
    }
    if (SOF_MARKERS.has(this.#marker) && length < 8) {
      this.#fail("A frame header (SOFn) shorter than 8 bytes");
      return;
    }
    if (this.#marker === SOS && length < 8) {
      this.#fail("A scan header (SOS) shorter than 8 bytes");
      return;
    }
    this.#remaining = length - 2;
    if (this.#remaining === 0) {
      this.#segmentSkipped();
    } else if (COLLECTED_MARKERS.has(this.#marker)) {
      this.#segment = new Uint8Array(this.#remaining);
      this.#collected = 0;
      this.#state = "collect";
    } else {
      this.#state = "skip";
    }
  }

  /** After a segment that was skipped: a scan header is followed by entropy-coded data. */
  #segmentSkipped(): void {
    if (this.#marker === SOS) {
      this.#scans++;
      this.#state = "ecs";
    } else {
      this.#state = "marker";
    }
  }

  #segmentCollected(): void {
    const body = this.#segment;
    this.#segment = new Uint8Array(0);
    this.#state = "marker";
    if (SOF_MARKERS.has(this.#marker)) {
      this.#readFrameHeader(body);
    } else if (this.#marker === APP0) {
      if (
        startsWith(body, "JFIF\0") &&
        body.length >= 14 &&
        (body[12] ?? 0) * (body[13] ?? 0) > 0
      ) {
        this.#foundExtraImage("A JFIF thumbnail in the APP0 segment");
      } else if (startsWith(body, "JFXX\0")) {
        this.#foundExtraImage("A JFXX thumbnail (APP0 extension)");
      }
    } else if (this.#marker === APP1 && startsWith(body, "Exif\0\0")) {
      const thumbnail = exifHasThumbnail(body);
      if (thumbnail === null) this.#fail("A malformed Exif (APP1) segment");
      else if (thumbnail) this.#foundExtraImage("An Exif thumbnail (IFD1) in the APP1 segment");
    } else if (this.#marker === APP2 && startsWith(body, "MPF\0")) {
      this.#foundExtraImage("An MPF (APP2) segment, which indexes further images");
    }
  }

  #readFrameHeader(body: Uint8Array): void {
    const height = (body[1] ?? 0) * 256 + (body[2] ?? 0);
    const width = (body[3] ?? 0) * 256 + (body[4] ?? 0);
    const components = body[5] ?? 0;
    if (height === 0) {
      this.#fail("Frame header height 0 (a DNL marker) is not supported");
    } else if (width === 0) {
      this.#fail("Frame header width 0");
    } else if (components === 0 || body.length !== 6 + 3 * components) {
      this.#fail("A frame header whose length does not match its number of components");
    } else {
      this.#frame = { width, height, components };
    }
  }

  /** The result once all the data has been pushed. */
  end(): HeaderResult<JpegInfo> {
    if (this.#failure !== null) return { ok: false, message: this.#failure };
    const frame = this.#frame;
    if (this.#state !== "eoi" || frame === null) {
      const before =
        frame === null
          ? "a frame header (SOFn)"
          : this.#scans === 0
            ? "a scan (SOS)"
            : "its end of image marker (EOI)";
      return { ok: false, message: `The JPEG ends before ${before}` };
    }
    const trailing =
      this.#trailingBytes > 0 ? `${this.#trailingBytes} bytes after the end of image (EOI)` : null;
    return { ok: true, value: { ...frame, extraImage: this.#extraImage ?? trailing } };
  }
}

export interface PngHeader extends ImageSize {
  readonly bitDepth: number;
  readonly colourType: number;
  /** Whether the IHDR chunk's CRC matches. */
  readonly crcOk: boolean;
}

export interface PngInfo extends PngHeader {
  /** Bytes after the IEND chunk. */
  readonly trailingBytes: number;
}

/** Bytes needed for the signature and the IHDR chunk: 8 + 4 + 4 + 13 + 4. */
export const PNG_HEADER_BYTES = 33;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Bit depths allowed for each PNG colour type. */
const PNG_BIT_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

/** Parses the signature and the IHDR chunk from a PNG's first 33 (or fewer) bytes. */
export function parsePngHeader(bytes: Uint8Array): HeaderResult<PngHeader> {
  if (bytes.length < PNG_HEADER_BYTES) {
    return { ok: false, message: "Too short for a PNG signature and IHDR chunk" };
  }
  if (!PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) {
    return { ok: false, message: "Not a PNG: wrong signature" };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isIhdr =
    bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52;
  if (view.getUint32(8) !== 13 || !isIhdr) {
    return { ok: false, message: "The first chunk is not a 13-byte IHDR" };
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const bitDepth = view.getUint8(24);
  const colourType = view.getUint8(25);
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) {
    return { ok: false, message: "IHDR width or height is 0 or above 2^31 - 1" };
  }
  if (!(PNG_BIT_DEPTHS[colourType] ?? []).includes(bitDepth)) {
    return {
      ok: false,
      message: `IHDR has an invalid colour type ${colourType} with bit depth ${bitDepth}`,
    };
  }
  if (view.getUint8(26) !== 0 || view.getUint8(27) !== 0 || view.getUint8(28) > 1) {
    return { ok: false, message: "IHDR has an unknown compression, filter or interlace method" };
  }
  const crcOk = crc32(bytes.subarray(12, 29)) === view.getUint32(29);
  return { ok: true, value: { width, height, bitDepth, colourType, crcOk } };
}

/** A chunk type is four ASCII letters. */
function isChunkType(bytes: Uint8Array): boolean {
  return bytes.every((byte) => (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a));
}

type PngState = "header" | "chunkHeader" | "chunkBody" | "afterIend" | "failed";

/**
 * Walks a PNG while it streams past: the signature and IHDR, then each chunk's length and type,
 * skipping its data and CRC, to IEND. Requires an IDAT chunk and an empty IEND; bytes after IEND
 * are counted. Chunk data is never decompressed, and only the IHDR CRC is checked.
 */
export class PngParser {
  #state: PngState = "header";
  readonly #header = new Uint8Array(PNG_HEADER_BYTES);
  #headerFilled = 0;
  #headerResult: HeaderResult<PngHeader> | null = null;
  readonly #chunkHeader = new Uint8Array(8);
  #chunkHeaderFilled = 0;
  /** Data and CRC bytes left in the current chunk. */
  #remaining = 0;
  #inIend = false;
  #sawIdat = false;
  #trailingBytes = 0;
  #failure: string | null = null;

  /** True once the data is known to be invalid: nothing more needs to be pushed. */
  get done(): boolean {
    return this.#state === "failed";
  }

  #fail(message: string): void {
    this.#failure ??= message;
    this.#state = "failed";
  }

  push(chunk: Uint8Array): void {
    let i = 0;
    while (i < chunk.length) {
      switch (this.#state) {
        case "failed":
          return;
        case "afterIend":
          this.#trailingBytes += chunk.length - i;
          return;
        case "header": {
          const take = Math.min(PNG_HEADER_BYTES - this.#headerFilled, chunk.length - i);
          this.#header.set(chunk.subarray(i, i + take), this.#headerFilled);
          this.#headerFilled += take;
          i += take;
          if (this.#headerFilled === PNG_HEADER_BYTES) {
            this.#headerResult = parsePngHeader(this.#header);
            if (this.#headerResult.ok) this.#state = "chunkHeader";
            else this.#fail(this.#headerResult.message);
          }
          break;
        }
        case "chunkHeader": {
          const take = Math.min(8 - this.#chunkHeaderFilled, chunk.length - i);
          this.#chunkHeader.set(chunk.subarray(i, i + take), this.#chunkHeaderFilled);
          this.#chunkHeaderFilled += take;
          i += take;
          if (this.#chunkHeaderFilled === 8) this.#readChunkHeader();
          break;
        }
        case "chunkBody": {
          const take = Math.min(this.#remaining, chunk.length - i);
          i += take;
          this.#remaining -= take;
          if (this.#remaining === 0) this.#state = this.#inIend ? "afterIend" : "chunkHeader";
          break;
        }
      }
    }
  }

  #readChunkHeader(): void {
    this.#chunkHeaderFilled = 0;
    const view = new DataView(this.#chunkHeader.buffer);
    const length = view.getUint32(0);
    const typeBytes = this.#chunkHeader.subarray(4, 8);
    const type = String.fromCharCode(...typeBytes);
    if (length > 0x7fffffff) {
      this.#fail("A chunk length above 2^31 - 1");
    } else if (!isChunkType(typeBytes)) {
      this.#fail("A chunk type that is not four ASCII letters");
    } else if (type === "IHDR") {
      this.#fail("A second IHDR chunk");
    } else if (type === "IEND" && length !== 0) {
      this.#fail("An IEND chunk with data");
    } else if (type === "IEND" && !this.#sawIdat) {
      this.#fail("No IDAT chunk before IEND");
    } else {
      if (type === "IDAT") this.#sawIdat = true;
      this.#inIend = type === "IEND";
      this.#remaining = length + 4; // the data and the CRC
      this.#state = "chunkBody";
    }
  }

  /** The result once all the data has been pushed. */
  end(): HeaderResult<PngInfo> {
    if (this.#failure !== null) return { ok: false, message: this.#failure };
    if (this.#headerResult === null || !this.#headerResult.ok) {
      return { ok: false, message: "Too short for a PNG signature and IHDR chunk" };
    }
    if (this.#state !== "afterIend") {
      const before = this.#sawIdat ? "its IEND chunk" : "an IDAT chunk";
      return { ok: false, message: `The PNG ends before ${before}` };
    }
    return { ok: true, value: { ...this.#headerResult.value, trailingBytes: this.#trailingBytes } };
  }
}
