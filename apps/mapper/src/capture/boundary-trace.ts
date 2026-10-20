// The boundary trace (docs/session-recording.md, boundary.jsonl; the lean recorder design, D21 and
// 3.4): one line for each event or result JavaScript received from the CaptureSession, which
// TypeScript writes and hands to the module (`appendBoundary`). The module checks each line and
// writes it into the recording; on the PC a fake plays the trace back.
//
// Lines hold what native code sent, poses included, so this file never logs or throws anything
// but constant messages: the lines go only to `send`.
//
// Numbering (D21): `seq` counts from 0 at the window's open. Until the module reports the open
// (`recording {state: "open", startT}`), lines wait in a buffer that keeps the last 2 s or 256
// lines; at the open those before `startT` are dropped and the rest numbered from 0. After the
// open, lines are sent every 1 s (`tick`, driven by the 5 Hz status), at 64 lines, on an AppState
// change, and with `final` when the recording finalizes and before stop or discard. `t` never
// decreases in the file: a result that arrives after a later event takes that event's `t`.

import { DEFAULT_RECORDING_LIMITS } from "@usg/contracts";

/** JSON text's bound in code points (recording defs.schema.json, `jsonText`). */
export const JSON_TEXT_MAX_CODE_POINTS = 16_384;
export const PRE_OPEN_SECONDS = 2;
export const PRE_OPEN_LINES = 256;
export const FLUSH_LINES = 64;
export const FLUSH_INTERVAL_S = 1;
/** `seq` is at most six digits, as `boundary/<seq>.f32` names. */
export const MAX_SEQ = 999_999;

const KIND = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

/**
 * The module's plumbing (session-recording.md, actions.jsonl): calls whose results are never
 * traced, because their lines are the trace itself or they run outside a session.
 */
export const PLUMBING_CALLS: ReadonlySet<string> = new Set([
  "appendBoundary",
  "getCapabilities",
  "getLogTail",
  "listRecordings",
  "exportRecording",
  "deleteRecording",
  "recoveryStatus",
  "recorderSelfTest",
  "requestRecorderPermissions",
  "exportProgress",
]);

/** Hands a batch of lines to the module. A rejection is counted, never logged. */
export type BoundarySend = (lines: string[], final: boolean) => Promise<void> | undefined;

/** What the trace did, as counts: safe to show on the debug card. */
export interface BoundaryTraceFigures {
  /** Lines handed to `send`. */
  readonly sent: number;
  readonly batches: number;
  readonly failedBatches: number;
  /** Lines waiting for the window to open. */
  readonly buffered: number;
  /** Lines from before the window opened, or pushed out of the pre-open buffer. */
  readonly droppedBeforeOpen: number;
  /** Lines recorded after the trace ended (the recording closed or was discarded). */
  readonly droppedAfterEnd: number;
  /** Lines past `MAX_SEQ`. */
  readonly droppedOverLimit: number;
  /** Values replaced by the too-large marker. */
  readonly tooLarge: number;
  /** Values JSON.stringify refused (written as null). */
  readonly unserializable: number;
  /** Lines whose `t` was raised to the line before's. */
  readonly clamped: number;
  /** Records without a usable `t`, and plumbing calls, which get no line. */
  readonly refused: number;
}

export interface BoundaryTraceOptions {
  readonly send: BoundarySend;
  /** One line's limit without its newline: `maxJsonlLineBytes`. */
  readonly maxLineBytes?: number;
}

interface PendingLine {
  readonly t: number;
  readonly kind: string;
  readonly value: string;
}

type Phase = "buffering" | "open" | "ended";

export class BoundaryTrace {
  private readonly send: BoundarySend;
  private readonly maxLineBytes: number;
  private phase: Phase = "buffering";
  private startT = 0;
  private latestT = 0;
  private lastLineT = 0;
  private lastFlushT = 0;
  private nextSeq = 0;
  private buffer: PendingLine[] = [];
  private pending: PendingLine[] = [];
  private counts = {
    sent: 0,
    batches: 0,
    failedBatches: 0,
    droppedBeforeOpen: 0,
    droppedAfterEnd: 0,
    droppedOverLimit: 0,
    tooLarge: 0,
    unserializable: 0,
    clamped: 0,
    refused: 0,
  };

  constructor(options: BoundaryTraceOptions) {
    this.send = options.send;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_RECORDING_LIMITS.maxJsonlLineBytes;
  }

  /**
   * Records what JavaScript received: an event's payload or a call's result, as native code sent
   * it (before anything is wrapped in Redacted), with the session time the module stamped on it.
   */
  record(kind: string, t: number, raw: unknown): void {
    if (!KIND.test(kind)) throw new Error("BoundaryTrace: not a boundary kind");
    if (this.phase === "ended") {
      this.counts.droppedAfterEnd++;
      return;
    }
    if (PLUMBING_CALLS.has(kind) || !isSessionTime(t)) {
      this.counts.refused++;
      return;
    }
    if (t > this.latestT) this.latestT = t;
    const line = { t, kind, value: this.valueText(kind, raw) };
    if (this.phase === "buffering") {
      this.buffer.push(line);
      this.trimBuffer();
      return;
    }
    if (t < this.startT) {
      this.counts.droppedBeforeOpen++;
      return;
    }
    this.pending.push(line);
    if (this.pending.length >= FLUSH_LINES) this.flush(false);
  }

  /** The module reported the window's open: number the buffered lines from `startT` on. */
  windowOpened(startT: number): void {
    if (this.phase !== "buffering") return;
    if (!isSessionTime(startT)) {
      this.counts.refused++;
      return;
    }
    this.phase = "open";
    this.startT = startT;
    this.lastLineT = startT;
    this.lastFlushT = Math.max(startT, this.latestT);
    const kept = this.buffer.filter((line) => line.t >= startT);
    this.counts.droppedBeforeOpen += this.buffer.length - kept.length;
    this.buffer = [];
    this.pending = kept;
    if (this.pending.length >= FLUSH_LINES) this.flush(false);
  }

  /** The 1 s cadence: called with each status's `t`; sends once a second has passed. */
  tick(t: number): void {
    if (this.phase !== "open" || !isSessionTime(t)) return;
    if (t > this.latestT) this.latestT = t;
    if (this.latestT - this.lastFlushT >= FLUSH_INTERVAL_S) this.flush(false);
  }

  /**
   * Sends what is pending. `final` tells the module the trace is complete up to now (it waits for
   * it when the recording finalizes), so a final batch goes out even when it is empty. Nothing is
   * sent before the window opens: there is nowhere to write it.
   */
  flush(final: boolean): void {
    if (this.phase !== "open") return;
    this.lastFlushT = this.latestT;
    if (this.pending.length === 0 && !final) return;
    const lines: string[] = [];
    for (const line of this.pending) {
      if (this.nextSeq > MAX_SEQ) {
        this.counts.droppedOverLimit++;
        continue;
      }
      let t = line.t;
      if (t < this.lastLineT) {
        t = this.lastLineT;
        this.counts.clamped++;
      }
      this.lastLineT = t;
      lines.push(boundaryLine(t, this.nextSeq, line.kind, line.value));
      this.nextSeq++;
    }
    this.pending = [];
    this.counts.batches++;
    this.counts.sent += lines.length;
    try {
      const sent: unknown = this.send(lines, final);
      if (isThenable(sent)) {
        sent.then(undefined, () => {
          this.counts.failedBatches++;
        });
      }
    } catch {
      this.counts.failedBatches++;
    }
  }

  /** The recording closed, was discarded or failed, or the session stopped: nothing more is traced. */
  end(): void {
    if (this.phase === "ended") return;
    this.counts.droppedAfterEnd += this.pending.length + this.buffer.length;
    this.pending = [];
    this.buffer = [];
    this.phase = "ended";
  }

  get open(): boolean {
    return this.phase === "open";
  }

  get figures(): BoundaryTraceFigures {
    return { ...this.counts, buffered: this.buffer.length };
  }

  private trimBuffer(): void {
    const oldest = this.latestT - PRE_OPEN_SECONDS;
    let drop = Math.max(0, this.buffer.length - PRE_OPEN_LINES);
    while (drop < this.buffer.length && (this.buffer[drop]?.t ?? 0) < oldest) drop++;
    if (drop > 0) {
      this.buffer.splice(0, drop);
      this.counts.droppedBeforeOpen += drop;
    }
  }

  private valueText(kind: string, raw: unknown): string {
    let text: string;
    try {
      text = jsonText(raw);
    } catch {
      this.counts.unserializable++;
      text = "null";
    }
    const tooLong = codePointLength(text) > JSON_TEXT_MAX_CODE_POINTS;
    if (
      tooLong ||
      utf8Length(boundaryLine(Number.MAX_VALUE, MAX_SEQ, kind, text)) > this.maxLineBytes
    ) {
      this.counts.tooLarge++;
      return tooLargeMarker(utf8Length(text));
    }
    return text;
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isSessionTime(t: unknown): t is number {
  return typeof t === "number" && Number.isFinite(t) && t >= 0;
}

/**
 * One boundary.jsonl line, without its newline, keys sorted: `binary` is always null here, since
 * the lean profile's calls return no binary results, so `value` is always the JSON text.
 */
export function boundaryLine(t: number, seq: number, kind: string, value: string): string {
  return `{"binary":null,"kind":${JSON.stringify(kind)},"seq":${seq},"t":${JSON.stringify(t)},"value":${JSON.stringify(value)}}`;
}

/** The marker that replaces a value over the bound (session-recording.md, "JSON text"). */
export function tooLargeMarker(bytes: number): string {
  return `{"bytes":${bytes},"omitted":"too_large"}`;
}

/**
 * JSON text of a received value with every object's keys sorted, so the same value always gives
 * the same text. JSON.stringify first, so toJSON (Redacted's included) and its dropping of
 * undefined and functions apply; nothing JSON can't hold becomes "null".
 */
export function jsonText(raw: unknown): string {
  const text = JSON.stringify(raw);
  return text === undefined ? "null" : sortedJson(JSON.parse(text));
}

function sortedJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  const members = Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${sortedJson(object[key])}`);
  return `{${members.join(",")}}`;
}

/** Unicode code points, as JSON Schema's maxLength counts them. */
export function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (isHighSurrogate(text.charCodeAt(i)) && isLowSurrogate(text.charCodeAt(i + 1))) i++;
    count++;
  }
  return count;
}

/** Bytes in UTF-8 (a lone surrogate counts as the 3 bytes of U+FFFD). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(i + 1))) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}
