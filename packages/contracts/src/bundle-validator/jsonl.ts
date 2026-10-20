// Splits a streamed JSONL file into lines on \n bytes (which never occur inside a multi-byte
// UTF-8 sequence), holding at most one line of `maxLineBytes` in memory; and parses JSON bytes.

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type ParsedJson =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

/**
 * UTF-8 JSON without a byte order mark, parsed; or why it isn't, in words that never quote the
 * data (the parser's own message can, and the data may be personal). A JSONL line (`isLine`)
 * must not be blank.
 */
export function parseJsonBytes(bytes: Uint8Array, isLine: boolean): ParsedJson {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return { ok: false, message: "Not valid UTF-8" };
  }
  if (text.charCodeAt(0) === 0xfeff) {
    return { ok: false, message: "Starts with a byte order mark (BOM)" };
  }
  if (isLine && text.trim() === "") return { ok: false, message: "A blank line" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, message: "Not valid JSON" };
  }
}

export class LineSplitter {
  readonly #maxLineBytes: number;
  readonly #onLine: (bytes: Uint8Array, line: number) => void;
  readonly #onTooLong: (line: number) => void;
  #pieces: Uint8Array[] = [];
  #pieceBytes = 0;
  #tooLong = false;
  #line = 0;
  #stopped = false;

  /**
   * `onLine` gets each line's bytes without the \n (a view that is only valid during the call)
   * and its 1-based number; `onTooLong` gets the number of a line longer than `maxLineBytes`.
   */
  constructor(
    maxLineBytes: number,
    onLine: (bytes: Uint8Array, line: number) => void,
    onTooLong: (line: number) => void,
  ) {
    this.#maxLineBytes = maxLineBytes;
    this.#onLine = onLine;
    this.#onTooLong = onTooLong;
  }

  /** Lines seen so far. */
  get lines(): number {
    return this.#line;
  }

  /**
   * Stops splitting: later chunks are ignored, as is the rest of the current one, and no more
   * lines are passed on. For a file that is already unusable, so a hostile file of many short
   * bad lines costs no more than hashing it.
   */
  stop(): void {
    this.#stopped = true;
    this.#pieces = [];
    this.#pieceBytes = 0;
  }

  push(chunk: Uint8Array): void {
    let start = 0;
    while (start < chunk.length && !this.#stopped) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      const piece = chunk.subarray(start, end);
      if (newline !== -1 && this.#pieceBytes === 0 && !this.#tooLong) {
        // The whole line is in this chunk: no copy.
        if (piece.length > this.#maxLineBytes) {
          this.#tooLong = true;
        } else {
          this.#line++;
          this.#onLine(piece, this.#line);
          start = newline + 1;
          continue;
        }
      } else if (!this.#tooLong) {
        if (this.#pieceBytes + piece.length > this.#maxLineBytes) {
          this.#tooLong = true;
          this.#pieces = [];
          this.#pieceBytes = 0;
        } else if (piece.length > 0) {
          this.#pieces.push(piece.slice());
          this.#pieceBytes += piece.length;
        }
      }
      if (newline === -1) return;
      this.#finishLine();
      start = newline + 1;
    }
  }

  #finishLine(): void {
    this.#line++;
    if (this.#tooLong) {
      this.#onTooLong(this.#line);
    } else {
      const bytes = new Uint8Array(this.#pieceBytes);
      let at = 0;
      for (const piece of this.#pieces) {
        bytes.set(piece, at);
        at += piece.length;
      }
      this.#onLine(bytes, this.#line);
    }
    this.#pieces = [];
    this.#pieceBytes = 0;
    this.#tooLong = false;
  }

  /** Call after the last chunk: a last line without a final \n still counts. */
  end(): void {
    if (this.#stopped) return;
    if (this.#pieceBytes > 0 || this.#tooLong) this.#finishLine();
  }
}
