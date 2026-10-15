// Reading and writing the publish's objects: brotli for the version files and the private exports,
// and reading a stored object back as decoded bytes (to check an immutable file before reusing it,
// or to rebuild latest.json). Everything stays in memory: these are small map files, never images.

import { promisify } from "node:util";
import { brotliCompress, brotliDecompress, constants, gunzip } from "node:zlib";
import type { StoredObject } from "../storage.ts";

const compress = promisify(brotliCompress);
const decompressBrotli = promisify(brotliDecompress);
const decompressGzip = promisify(gunzip);

/** The most bytes read from one stored object: far above any map file, so a bad object can't fill memory. */
export const MAX_OBJECT_BYTES = 256 * 1024 * 1024;

/** Brotli at its highest quality, tuned for text: what the version files are stored as. */
export async function brotli(bytes: Uint8Array): Promise<Uint8Array> {
  return compress(bytes, {
    params: {
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
    },
  });
}

/** A stored object's bytes as stored (still encoded), refusing more than MAX_OBJECT_BYTES. */
export async function storedBytes(object: StoredObject): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of object.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > MAX_OBJECT_BYTES) {
      object.body.destroy();
      throw new Error(`The object is larger than ${MAX_OBJECT_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** A stored object's bytes with its content coding (br, gzip or none) removed. */
export async function decodedBytes(object: StoredObject): Promise<Uint8Array> {
  const bytes = await storedBytes(object);
  switch (object.contentEncoding) {
    case undefined:
      return bytes;
    case "br":
      return decompressBrotli(bytes, { maxOutputLength: MAX_OBJECT_BYTES });
    case "gzip":
      return decompressGzip(bytes, { maxOutputLength: MAX_OBJECT_BYTES });
    default:
      throw new Error(`Unknown Content-Encoding ${object.contentEncoding}`);
  }
}
