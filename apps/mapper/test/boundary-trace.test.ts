// The boundary trace (src/capture/boundary-trace.ts): a synthetic session through the adapter gives
// lines that validate against the recording's boundary-line schema, numbered from 0 at the
// window's open, with the final batch where the module waits for it; and the buffer, cadence,
// bound and marker rules one by one. Every value here is synthetic.

import { SCHEMA_BASE_URL } from "@usg/contracts";
import { describe, expect, test } from "vitest";
import type {
  NativeMarkAnchorResult,
  NativeRecordingEvent,
  NativeSessionStatus,
} from "../modules/capture-native/src/types.ts";
import {
  BoundaryTrace,
  boundaryLine,
  codePointLength,
  FLUSH_LINES,
  JSON_TEXT_MAX_CODE_POINTS,
  jsonText,
  PRE_OPEN_LINES,
  utf8Length,
} from "../src/capture/boundary-trace.ts";
import { moduleCaptureNative } from "../src/capture/native.ts";
import { redact } from "../src/capture/redacted.ts";
import { type BoundaryBatch, fakeModule } from "./fake-capture-native.ts";

// @usg/contracts' Node validators (Ajv with every schema), imported at run time: they typecheck
// under Node's module settings, not under the app's (`module: preserve`), which this file shares.
const VALIDATORS = "@usg/contracts/validators";
const { createAjv } = (await import(VALIDATORS)) as {
  createAjv(): { getSchema(id: string): ((data: unknown) => boolean) | undefined };
};
const validateLine = (() => {
  const validate = createAjv().getSchema(`${SCHEMA_BASE_URL}recording/boundary-line.schema.json`);
  if (!validate) throw new Error("no boundary-line schema");
  return validate;
})();

interface ParsedLine {
  readonly t: number;
  readonly seq: number;
  readonly kind: string;
  readonly value: string | null;
  readonly binary: string | null;
}

function parsed(batches: readonly BoundaryBatch[]): ParsedLine[] {
  return batches.flatMap((batch) => batch.lines).map((line) => JSON.parse(line) as ParsedLine);
}

/** The checks validate-recording makes on boundary.jsonl, beyond the schema. */
function expectValidTrace(lines: readonly string[]): void {
  let lastT = -1;
  lines.forEach((text, index) => {
    const line = JSON.parse(text) as ParsedLine;
    expect(validateLine(line), `line ${index}`).toBe(true);
    expect(line.seq).toBe(index);
    expect(line.t).toBeGreaterThanOrEqual(lastT);
    lastT = line.t;
    expect((line.value === null) !== (line.binary === null)).toBe(true);
    expect(() => JSON.parse(line.value ?? "")).not.toThrow();
    expect(Object.keys(JSON.parse(text))).toEqual(["binary", "kind", "seq", "t", "value"]);
    expect(utf8Length(text)).toBeLessThanOrEqual(65_536);
  });
}

function status(t: number, state: NativeSessionStatus["recorder"]["state"]): NativeSessionStatus {
  return {
    t,
    running: true,
    covered: false,
    tracking: "normal",
    mapping: "extending",
    fps: 60,
    candidateHz: 5,
    meshAnchors: 12,
    thermal: "nominal",
    recorder: { state, degradation: null, closingInS: null },
  };
}

function collect(): { trace: BoundaryTrace; batches: BoundaryBatch[] } {
  const batches: BoundaryBatch[] = [];
  const trace = new BoundaryTrace({
    send: (lines, final) => {
      batches.push({ lines, final });
      return undefined;
    },
  });
  return { trace, batches };
}

describe("a synthetic lean session through the adapter", () => {
  test("gives a trace that validates, from 0 at the open, with the final batch at finalizing", async () => {
    const { module, sessions } = fakeModule({ withSession: true });
    const port = moduleCaptureNative(module);
    const session = port?.openSession();
    const fake = sessions[0];
    if (!session || !fake) throw new Error("no session");

    await session.start({ record: "lean", venues: ["72b16287-20ee-4bee-8086-ce623f24495c"] });
    const recording = (event: NativeRecordingEvent) => fake.emit("recording", event);
    recording({ t: 0.05, state: "armed" });
    // 6 s of status at 5 Hz before the start mark: only the last 2 s may survive the buffer, and
    // of those only what is at or after the window's start.
    for (let i = 0; i < 30; i++) fake.emit("status", status(0.1 + i * 0.2, "armed"));

    const startMark: NativeMarkAnchorResult = {
      t: 6.0,
      frame: 360,
      anchorId: "4f1c2a52-8a43-4c1f-9d6e-0b7f8f3f2a10",
      hit: {
        point: [0.5, -1.4, -1.2],
        normal: [0, 1, 0],
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, -1.4, -1.2, 1],
      },
      facing: [0, 0, -1],
      camera: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      window: "opened",
    };
    fake.markResult = startMark;
    const mark = await session.markAnchor({
      role: "start",
      kind: "floor_point",
      streetFacing: true,
      endSessionHere: false,
      name: null,
    });
    expect(String(mark.hit)).toBe("[redacted]");
    recording({ t: 6.0, state: "open", startT: 6.0 });
    expect(fake.batches).toEqual([]);

    // 10 s open: status at 5 Hz, a tag and a warning; a batch every second.
    fake.tagResult = { t: 8.5, frame: 510, position: [1, 0, -4], camera: startMark.camera };
    for (let i = 1; i <= 50; i++) {
      fake.emit("status", status(6.0 + i * 0.2, "open"));
      if (i === 12) await session.addTag({ type: "node", kind: "escalator", name: null });
      if (i === 30) fake.emit("warning", { t: 12.0, kind: "screenshot" });
    }
    expect(fake.batches.length).toBeGreaterThanOrEqual(9);
    expect(fake.batches.every((batch) => !batch.final)).toBe(true);

    fake.markResult = { ...startMark, t: 16.1, frame: 966, window: "open" };
    await session.markAnchor({
      role: "end",
      kind: "floor_point",
      streetFacing: false,
      endSessionHere: true,
      name: null,
    });
    recording({ t: 16.1, state: "closing" });
    fake.emit("status", status(16.2, "closing"));
    recording({ t: 21.1, state: "finalizing" });
    const finalAt = fake.batches.length;
    expect(fake.batches[finalAt - 1]?.final).toBe(true);
    fake.emit("stopped", { t: 21.1 });
    recording({ t: 21.2, state: "closed", ended: "end_anchor", trimmed: false, closed: true });
    fake.emit("status", status(21.3, "closed"));
    expect(fake.batches.length).toBe(finalAt);

    const lines = fake.batches.flatMap((batch) => batch.lines);
    expectValidTrace(lines);
    const trace = parsed(fake.batches);
    expect(trace[0]?.t).toBe(6.0);
    expect(trace.filter((line) => line.kind === "markAnchor")).toHaveLength(2);
    expect(trace.filter((line) => line.kind === "addTag")).toHaveLength(1);
    expect(trace.filter((line) => line.kind === "warning")).toHaveLength(1);
    expect(trace.at(-1)?.kind).toBe("recording");
    expect(JSON.parse(trace.at(-1)?.value ?? "")).toEqual({ state: "finalizing", t: 21.1 });
    // The mark's result is what native sent, keys sorted, not the redacted wrapper.
    const firstMark = trace.find((line) => line.kind === "markAnchor");
    expect(JSON.parse(firstMark?.value ?? "").hit.normal).toEqual([0, 1, 0]);
    expect(firstMark?.value).toBe(jsonText(startMark));
    expect(session.traceFigures().failedBatches).toBe(0);

    // Stop after the close sends nothing more: the trace ended with the session.
    fake.stopResult = {
      t: 21.3,
      recording: {
        id: "0f7d0e65-6f2e-4b43-9a55-5d7f4f0c5b0e",
        ended: "end_anchor",
        trimmed: false,
        closed: true,
      },
    };
    await session.stop();
    expect(fake.batches.length).toBe(finalAt);
    session.release();
    expect(fake.released).toBe(true);
  });

  test("stop sends the final batch before it calls native stop", async () => {
    const { module, sessions } = fakeModule({ withSession: true });
    const session = moduleCaptureNative(module)?.openSession();
    const fake = sessions[0];
    if (!session || !fake) throw new Error("no session");
    fake.emit("recording", { t: 1, state: "open", startT: 1 });
    fake.emit("status", status(1.2, "open"));
    await session.stop();
    expect(fake.calls).toEqual(["appendBoundary(final)", "stop"]);
    expect(fake.batches[0]?.lines).toHaveLength(2);
  });

  test("a failing appendBoundary is counted, never thrown or logged", async () => {
    const { module, sessions } = fakeModule({ withSession: true });
    const session = moduleCaptureNative(module)?.openSession();
    const fake = sessions[0];
    if (!session || !fake) throw new Error("no session");
    fake.appendFails = true;
    fake.emit("recording", { t: 1, state: "open", startT: 1 });
    fake.emit("status", status(2.5, "open"));
    await Promise.resolve();
    await Promise.resolve();
    expect(session.traceFigures().failedBatches).toBe(1);
  });
});

describe("numbering at the open (D21)", () => {
  test("lines before startT are dropped and the rest numbered from 0", () => {
    const { trace, batches } = collect();
    trace.record("status", 4.0, { n: 1 });
    trace.record("status", 4.9, { n: 2 });
    trace.record("markAnchor", 5.0, { n: 3 });
    trace.record("status", 5.1, { n: 4 });
    trace.windowOpened(5.0);
    trace.record("status", 4.95, { n: 5 });
    trace.flush(false);
    expect(parsed(batches).map((line) => [line.seq, JSON.parse(line.value ?? "").n])).toEqual([
      [0, 3],
      [1, 4],
    ]);
    expect(trace.figures.droppedBeforeOpen).toBe(3);
  });

  test("the pre-open buffer keeps the last 2 s", () => {
    const { trace, batches } = collect();
    for (let i = 0; i <= 50; i++) trace.record("status", i * 0.1, { i });
    expect(trace.figures.buffered).toBe(21);
    trace.windowOpened(0);
    trace.flush(false);
    expect(JSON.parse(parsed(batches)[0]?.value ?? "").i).toBe(30);
  });

  test("the pre-open buffer keeps at most 256 lines", () => {
    const { trace } = collect();
    for (let i = 0; i < 400; i++) trace.record("status", 1 + i * 0.001, {});
    expect(trace.figures.buffered).toBe(PRE_OPEN_LINES);
    expect(trace.figures.droppedBeforeOpen).toBe(400 - PRE_OPEN_LINES);
  });

  test("nothing is sent before the open, not even a final batch", () => {
    const { trace, batches } = collect();
    trace.record("status", 1, {});
    trace.tick(10);
    trace.flush(true);
    expect(batches).toEqual([]);
  });

  test("t never decreases: a late result takes the time of the line before", () => {
    const { trace, batches } = collect();
    trace.windowOpened(1);
    trace.record("status", 2.0, {});
    trace.record("markAnchor", 1.98, {});
    trace.flush(false);
    trace.record("addTag", 1.99, {});
    trace.flush(false);
    expect(parsed(batches).map((line) => line.t)).toEqual([2.0, 2.0, 2.0]);
    expect(trace.figures.clamped).toBe(2);
  });
});

describe("when lines are sent", () => {
  test("every second of status time", () => {
    const { trace, batches } = collect();
    trace.windowOpened(0);
    for (let i = 1; i <= 25; i++) {
      trace.record("status", i / 5, {});
      trace.tick(i / 5);
    }
    expect(batches.map((batch) => batch.lines.length)).toEqual([5, 5, 5, 5, 5]);
  });

  test("at 64 lines", () => {
    const { trace, batches } = collect();
    trace.windowOpened(0);
    for (let i = 0; i < FLUSH_LINES + 1; i++) trace.record("status", 0.001 * i, {});
    expect(batches.map((batch) => batch.lines.length)).toEqual([FLUSH_LINES]);
  });

  test("on an AppState change, through the adapter", () => {
    const appState: { listener: (() => void) | null } = { listener: null };
    const { module, sessions } = fakeModule({ withSession: true });
    const port = moduleCaptureNative(module, {
      onAppStateChange: (listener) => {
        appState.listener = listener;
        return () => {
          appState.listener = null;
        };
      },
    });
    const session = port?.openSession();
    const fake = sessions[0];
    if (!session || !fake) throw new Error("no session");
    fake.emit("recording", { t: 1, state: "open", startT: 1 });
    appState.listener?.();
    expect(fake.batches).toEqual([{ lines: [expect.any(String)], final: false }]);
    session.release();
    expect(appState.listener).toBe(null);
  });

  test("after the trace ends, nothing", () => {
    const { trace, batches } = collect();
    trace.windowOpened(0);
    trace.record("status", 0.5, {});
    trace.end();
    trace.record("status", 0.6, {});
    trace.flush(true);
    expect(batches).toEqual([]);
    expect(trace.figures.droppedAfterEnd).toBe(2);
  });
});

describe("what a line holds", () => {
  test("the recorder's plumbing is never traced", () => {
    const { trace, batches } = collect();
    trace.windowOpened(0);
    trace.record("appendBoundary", 1, ["a line"]);
    trace.record("listRecordings", 1, []);
    trace.record("exportProgress", 1, {});
    trace.flush(true);
    expect(batches).toEqual([{ lines: [], final: true }]);
    expect(trace.figures.refused).toBe(3);
  });

  test("a kind the schema refuses throws a constant message; a bad t is refused", () => {
    const { trace } = collect();
    expect(() => trace.record("1status", 1, {})).toThrow("BoundaryTrace: not a boundary kind");
    trace.record("status", Number.NaN, {});
    trace.record("status", -1, {});
    expect(trace.figures.refused).toBe(2);
  });

  test("values are JSON text with sorted keys; undefined is null; Redacted prints redacted", () => {
    expect(jsonText({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
    expect(jsonText(undefined)).toBe("null");
    expect(jsonText({ a: undefined, b: Number.NaN })).toBe('{"b":null}');
    expect(jsonText({ t: redact(1.5) })).toBe('{"t":"[redacted]"}');
  });

  test("a value over 16,384 code points becomes the too-large marker", () => {
    const { trace, batches } = collect();
    trace.windowOpened(0);
    const fits = "é".repeat(JSON_TEXT_MAX_CODE_POINTS - 2);
    const over = "😀".repeat(JSON_TEXT_MAX_CODE_POINTS - 1);
    trace.record("status", 1, fits);
    trace.record("status", 2, over);
    trace.flush(true);
    const [first, second] = parsed(batches);
    expect(codePointLength(first?.value ?? "")).toBe(JSON_TEXT_MAX_CODE_POINTS);
    expect(JSON.parse(second?.value ?? "")).toEqual({
      bytes: utf8Length(JSON.stringify(over)),
      omitted: "too_large",
    });
    expect(trace.figures.tooLarge).toBe(1);
    expectValidTrace(batches.flatMap((batch) => batch.lines));
  });

  test("a value whose line would pass 64 KiB becomes the marker too", () => {
    const { trace, batches } = collect();
    trace.windowOpened(0);
    // 12,000 code points, but each control character is escaped twice over in the line.
    trace.record("status", 1, "\u0001".repeat(12_000));
    trace.flush(true);
    const [line] = parsed(batches);
    expect(JSON.parse(line?.value ?? "").omitted).toBe("too_large");
    expectValidTrace(batches.flatMap((batch) => batch.lines));
  });

  test("a line, byte for byte, and the schema refuses a broken one", () => {
    const line = boundaryLine(1.25, 7, "status", '{"a":1}');
    expect(line).toBe('{"binary":null,"kind":"status","seq":7,"t":1.25,"value":"{\\"a\\":1}"}');
    expect(validateLine(JSON.parse(line))).toBe(true);
    expect(validateLine({ ...JSON.parse(line), seq: -1 })).toBe(false);
    expect(validateLine({ ...JSON.parse(line), extra: 1 })).toBe(false);
  });
});
