// Raw DEFLATE (RFC 1951) in plain TypeScript, for the synthetic sets' mesh history. The output
// depends only on the input, never on the platform: Node's zlib is Chromium's fork, whose match
// finder can depend on the CPU's features, and CI regenerates the sets and fails on any byte that
// differs. Greedy LZ77 over a 32 KiB window, coded with the fixed Huffman codes (one BTYPE 01
// block), or stored blocks (BTYPE 00) when those come out smaller. Any inflater reads it, Node's
// inflateRawSync and Apple's COMPRESSION_ZLIB included. It compresses less than zlib; the sets
// are small.

const WINDOW = 32_768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
/** Candidates tried per position: enough for the sets, and keeps generation fast. */
const MAX_CHAIN = 32;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const MAX_STORED = 65_535;

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

/** Writes bits least significant first, as DEFLATE packs them. */
class BitWriter {
  private bytes: Uint8Array;
  private length = 0;
  private buffer = 0;
  private count = 0;

  constructor(capacity: number) {
    this.bytes = new Uint8Array(Math.max(64, capacity));
  }

  /** `value`'s low `bits` bits (at most 16). */
  write(value: number, bits: number): void {
    this.buffer |= value << this.count;
    this.count += bits;
    while (this.count >= 8) {
      this.push(this.buffer & 0xff);
      this.buffer >>>= 8;
      this.count -= 8;
    }
  }

  /** A Huffman code, which DEFLATE packs most significant bit first. */
  writeCode(code: number, bits: number): void {
    let reversed = 0;
    for (let i = 0; i < bits; i++) reversed |= ((code >>> i) & 1) << (bits - 1 - i);
    this.write(reversed, bits);
  }

  /** Pads to a byte boundary with zero bits. */
  align(): void {
    if (this.count > 0) this.write(0, 8 - this.count);
  }

  writeBytes(data: Uint8Array): void {
    for (const byte of data) this.push(byte);
  }

  finish(): Uint8Array {
    this.align();
    return this.bytes.slice(0, this.length);
  }

  private push(byte: number): void {
    if (this.length === this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.length++] = byte;
  }
}

/** A literal or end-of-block symbol (0-256) with the fixed codes. */
function writeLiteral(out: BitWriter, symbol: number): void {
  if (symbol < 144) out.writeCode(0x30 + symbol, 8);
  else if (symbol < 256) out.writeCode(0x190 + symbol - 144, 9);
  else out.writeCode(symbol - 256, 7);
}

/** A length/distance pair with the fixed codes. */
function writeMatch(out: BitWriter, length: number, distance: number): void {
  let code = LENGTH_BASE.length - 1;
  while ((LENGTH_BASE[code] as number) > length) code--;
  const symbol = 257 + code;
  if (symbol < 280) out.writeCode(symbol - 256, 7);
  else out.writeCode(0xc0 + symbol - 280, 8);
  out.write(length - (LENGTH_BASE[code] as number), LENGTH_EXTRA[code] as number);
  let dcode = DISTANCE_BASE.length - 1;
  while ((DISTANCE_BASE[dcode] as number) > distance) dcode--;
  out.writeCode(dcode, 5);
  out.write(distance - (DISTANCE_BASE[dcode] as number), DISTANCE_EXTRA[dcode] as number);
}

function hashAt(data: Uint8Array, at: number): number {
  return (
    (((data[at] as number) << 10) ^ ((data[at + 1] as number) << 5) ^ (data[at + 2] as number)) &
    (HASH_SIZE - 1)
  );
}

/** One fixed-Huffman block holding all of `data`. */
function fixedBlock(data: Uint8Array): Uint8Array {
  const out = new BitWriter(data.length + (data.length >>> 3) + 16);
  out.write(1, 1); // BFINAL
  out.write(1, 2); // BTYPE 01: fixed Huffman codes
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(WINDOW).fill(-1);
  const insert = (at: number): void => {
    if (at + MIN_MATCH > data.length) return;
    const hash = hashAt(data, at);
    prev[at & (WINDOW - 1)] = head[hash] as number;
    head[hash] = at;
  };
  let at = 0;
  while (at < data.length) {
    let bestLength = 0;
    let bestDistance = 0;
    if (at + MIN_MATCH <= data.length) {
      const limit = Math.min(MAX_MATCH, data.length - at);
      let candidate = head[hashAt(data, at)] as number;
      for (
        let chain = 0;
        candidate >= 0 && at - candidate <= WINDOW && chain < MAX_CHAIN;
        chain++
      ) {
        let length = 0;
        while (length < limit && data[candidate + length] === data[at + length]) length++;
        if (length > bestLength) {
          bestLength = length;
          bestDistance = at - candidate;
          if (length === limit) break;
        }
        const next = prev[candidate & (WINDOW - 1)] as number;
        // A slot reused by a later position ends the chain.
        if (next >= candidate) break;
        candidate = next;
      }
    }
    if (bestLength >= MIN_MATCH) {
      writeMatch(out, bestLength, bestDistance);
      for (let i = 0; i < bestLength; i++) insert(at + i);
      at += bestLength;
    } else {
      writeLiteral(out, data[at] as number);
      insert(at);
      at++;
    }
  }
  writeLiteral(out, 256);
  return out.finish();
}

/** Stored blocks (BTYPE 00) of at most 65,535 bytes each. */
function storedBlocks(data: Uint8Array): Uint8Array {
  const out = new BitWriter(data.length + 5 * Math.ceil(data.length / MAX_STORED) + 5);
  let at = 0;
  do {
    const length = Math.min(MAX_STORED, data.length - at);
    out.write(at + length >= data.length ? 1 : 0, 1); // BFINAL
    out.write(0, 2); // BTYPE 00: stored
    out.align();
    out.write(length & 0xffff, 16);
    out.write(~length & 0xffff, 16);
    out.writeBytes(data.subarray(at, at + length));
    at += length;
  } while (at < data.length);
  return out.finish();
}

/** `data` as raw DEFLATE: the same bytes for the same input, on every platform. */
export function deflateRaw(data: Uint8Array): Uint8Array {
  const fixed = fixedBlock(data);
  const storedSize = data.length + 5 * Math.max(1, Math.ceil(data.length / MAX_STORED));
  return fixed.length <= storedSize ? fixed : storedBlocks(data);
}
