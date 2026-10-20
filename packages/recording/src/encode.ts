// Text and number helpers for writing recording files without Node's Buffer or TextEncoder, which
// the ES2024 library the neutral typecheck uses doesn't declare.

/** `text` as UTF-8 bytes. */
export function utf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

/** One JSON value per line, each ending in a newline. */
export function jsonLines(values: readonly unknown[]): Uint8Array {
  return utf8(values.map((value) => `${JSON.stringify(value)}\n`).join(""));
}

/** A JSON document, two-space indented, ending in a newline. */
export function jsonDocument(value: unknown): Uint8Array {
  return utf8(`${JSON.stringify(value, null, 2)}\n`);
}

/** `value` rounded to `decimals` places, so the text stays short and the same everywhere. */
export function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  const rounded = Math.round(value * scale) / scale;
  return rounded === 0 ? 0 : rounded; // never -0
}

/** Joins byte arrays. */
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Little-endian float32 values. */
export function float32Bytes(values: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(4 * values.length);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) view.setFloat32(4 * i, values[i] as number, true);
  return out;
}
