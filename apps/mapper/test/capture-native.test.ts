// The CaptureNative port's adapter (src/capture/native.ts) over a fake module: null-safe without
// the module or without its CaptureSession class (Expo Go, the web, builds before the glue), and
// with it, every session time and pose wrapped before the app sees it. Synthetic values only.

import { describe, expect, test } from "vitest";
import {
  buildProfileOf,
  CaptureNativeError,
  captureErrorCode,
  moduleCaptureNative,
  type RecordingEvent,
  recorderCapabilities,
  type SessionStatus,
} from "../src/capture/native.ts";
import { isRedacted } from "../src/capture/redacted.ts";
import { fakeModule, SYNTHETIC_CAPABILITIES } from "./fake-capture-native.ts";

const WALK_RECORDER = {
  compiled: true,
  canRecord: true,
  refusal: null,
  buildProfile: "walk",
} as const;

describe("without the module (Expo Go, the web)", () => {
  test("there is no port", () => {
    expect(moduleCaptureNative(null)).toBe(null);
    expect(buildProfileOf(null)).toBe(null);
  });
});

describe("a module without the CaptureSession class (today's builds)", () => {
  const { module } = fakeModule({ withSession: false });
  const port = moduleCaptureNative(module);
  if (!port) throw new Error("no port");

  test("no session, no recordings, no recovery report, no log", async () => {
    expect(port.openSession()).toBe(null);
    await expect(port.listRecordings()).resolves.toEqual([]);
    await expect(port.recoveryStatus()).resolves.toBe(null);
    expect(port.logTail()).toEqual([]);
    expect(typeof port.onExportProgress(() => {})).toBe("function");
  });

  test.each([
    ["exportRecording", () => port.exportRecording("0f7d0e65-6f2e-4b43-9a55-5d7f4f0c5b0e")],
    ["deleteRecording", () => port.deleteRecording("0f7d0e65-6f2e-4b43-9a55-5d7f4f0c5b0e")],
    ["selfTest", () => port.selfTest(false)],
    ["requestPermissions", () => port.requestPermissions()],
  ])("%s rejects with ERR_RECORDER_NOT_COMPILED", async (_name, call) => {
    const error = await call().then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(CaptureNativeError);
    expect(captureErrorCode(error)).toBe("ERR_RECORDER_NOT_COMPILED");
    expect((error as Error).message).toBe("ERR_RECORDER_NOT_COMPILED");
  });

  test("the boolean recorder capability reads as not compiled", () => {
    expect(port.capabilities().recorder).toEqual({
      compiled: false,
      canRecord: false,
      refusal: "notCompiled",
      buildProfile: null,
    });
    expect(buildProfileOf(module)).toBe(null);
  });
});

describe("capabilities", () => {
  test("the recorder's object shape passes through", () => {
    const capabilities = { ...SYNTHETIC_CAPABILITIES, recorder: WALK_RECORDER };
    expect(recorderCapabilities(capabilities)).toBe(WALK_RECORDER);
    const { module } = fakeModule({ withSession: true, capabilities });
    expect(buildProfileOf(module)).toBe("walk");
    expect(moduleCaptureNative(module)?.capabilities().recorder).toEqual(WALK_RECORDER);
  });

  test("a getCapabilities that throws gives no build profile", () => {
    const { module } = fakeModule({ withSession: false });
    module.getCapabilities = () => {
      throw new Error("ARKit unavailable");
    };
    expect(buildProfileOf(module)).toBe(null);
  });

  test("error codes are read only from the module's codes", () => {
    expect(captureErrorCode({ code: "ERR_NO_FLOOR_HIT" })).toBe("ERR_NO_FLOOR_HIT");
    expect(captureErrorCode({ code: "E_SOMETHING_ELSE" })).toBe(null);
    expect(captureErrorCode("ERR_IO")).toBe(null);
    expect(captureErrorCode(null)).toBe(null);
  });
});

describe("a session", () => {
  function open() {
    const { module, sessions } = fakeModule({ withSession: true });
    const session = moduleCaptureNative(module)?.openSession();
    const fake = sessions[0];
    if (!session || !fake) throw new Error("no session");
    return { session, fake };
  }

  test("marks and tags come back with every pose and time wrapped", async () => {
    const { session, fake } = open();
    fake.markResult = {
      t: 3.5,
      frame: 210,
      anchorId: "4f1c2a52-8a43-4c1f-9d6e-0b7f8f3f2a10",
      hit: { point: [0.5, -1.4, -1.2], normal: [0, 1, 0], transform: Array(16).fill(0.5) },
      facing: null,
      camera: Array(16).fill(0.25),
      window: "opened",
    };
    const mark = await session.markAnchor({
      role: "start",
      kind: "floor_point",
      streetFacing: false,
      endSessionHere: false,
      name: null,
    });
    expect(isRedacted(mark.t) && isRedacted(mark.hit) && isRedacted(mark.camera)).toBe(true);
    expect(mark.facing).toBe(null);
    expect(mark.hit.unwrap().point).toEqual([0.5, -1.4, -1.2]);
    expect(mark.t.unwrap()).toBe(3.5);
    expect(JSON.stringify(mark)).toBe(
      '{"t":"[redacted]","frame":210,"anchorId":"4f1c2a52-8a43-4c1f-9d6e-0b7f8f3f2a10","hit":"[redacted]","facing":null,"camera":"[redacted]","window":"opened"}',
    );

    fake.tagResult = { t: 4, frame: 240, position: [1, 0, -4], camera: Array(16).fill(0.25) };
    const tag = await session.addTag({ type: "node", kind: "lift", name: null });
    expect(JSON.stringify(tag)).toBe(
      '{"t":"[redacted]","frame":240,"position":"[redacted]","camera":"[redacted]"}',
    );
  });

  test("a rejected call passes its code through", async () => {
    const { session } = open();
    const error = await session
      .markAnchor({
        role: "start",
        kind: "floor_point",
        streetFacing: false,
        endSessionHere: false,
        name: null,
      })
      .catch((reason: unknown) => reason);
    expect(captureErrorCode(error)).toBe("ERR_NO_FLOOR_HIT");
  });

  test("events reach listeners wrapped, and unsubscribing stops them", () => {
    const { session, fake } = open();
    const statuses: SessionStatus[] = [];
    const recordings: RecordingEvent[] = [];
    const off = session.on("status", (event) => statuses.push(event));
    session.on("recording", (event) => recordings.push(event));
    fake.emit("status", {
      t: 1.2,
      running: true,
      covered: false,
      tracking: "limited",
      trackingReason: "initializing",
      mapping: "limited",
      fps: 60,
      candidateHz: 0,
      frames: 72,
      candidates: 0,
      meshAnchors: 0,
      thermal: "nominal",
      recorder: { state: "armed", degradation: null, closingInS: null },
      debug: { delegateP95Us: 210 },
    });
    fake.emit("recording", { t: 2, state: "open", startT: 2 });
    off();
    fake.emit("status", {
      t: 1.4,
      running: true,
      covered: false,
      tracking: "normal",
      mapping: "extending",
      fps: 60,
      candidateHz: 0,
      frames: 84,
      candidates: 1,
      meshAnchors: 0,
      thermal: "nominal",
      recorder: { state: "open", degradation: null, closingInS: null },
    });
    expect(statuses).toHaveLength(1);
    expect(String(statuses[0]?.t)).toBe("[redacted]");
    expect(statuses[0]?.trackingReason).toBe("initializing");
    expect(statuses[0]?.debug).toEqual({ delegateP95Us: 210 });
    const opened = recordings[0];
    expect(opened?.state === "open" && isRedacted(opened.startT)).toBe(true);
  });

  test("discard sends the final batch first; release removes everything", async () => {
    const { session, fake } = open();
    fake.emit("recording", { t: 2, state: "open", startT: 2 });
    await session.discard();
    expect(fake.calls).toEqual(["appendBoundary(final)", "discard"]);
    session.release();
    expect(fake.listenerCount("status")).toBe(0);
    expect(fake.listenerCount("recording")).toBe(0);
    expect(fake.released).toBe(true);
  });
});
