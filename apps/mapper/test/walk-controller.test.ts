// The walk screen's wiring (src/walk/controller.ts): which call each change of the flow's state
// asks for, how the session's events become flow actions, and a whole lean walk through the port's
// adapter over a fake module, from the venues to the summary, with the timers driven by hand.
// Synthetic values only.

import { describe, expect, test } from "vitest";
import type {
  Capabilities,
  CaptureNativeModule,
  NativeMarkAnchorResult,
} from "../modules/capture-native/src/types.ts";
import { moduleCaptureNative } from "../src/capture/native.ts";
import { redact } from "../src/capture/redacted.ts";
import {
  recordingAction,
  WalkController,
  type WalkTimers,
  walkCalls,
} from "../src/walk/controller.ts";
import {
  initialWalkState,
  type WalkAction,
  type WalkState,
  walkReducer,
} from "../src/walk/flow.ts";
import { CORRIDOR_VENUES } from "../src/walk/venues.ts";
import { type FakeSession, fakeModule, SYNTHETIC_CAPABILITIES } from "./fake-capture-native.ts";

const SOUTH_BEACH = CORRIDOR_VENUES[0]?.id ?? "";
const PERMISSIONS = { location: "authorizedWhenInUse", motion: "authorized" };

const WALK_CAPABILITIES: Capabilities = {
  ...SYNTHETIC_CAPABILITIES,
  recorder: { compiled: true, canRecord: true, refusal: null, buildProfile: "walk" },
};

const DEV_CAPABILITIES: Capabilities = {
  ...SYNTHETIC_CAPABILITIES,
  recorder: {
    compiled: true,
    canRecord: false,
    refusal: "debugBuild",
    buildProfile: "development",
  },
};

/** A synthetic mark result: made-up numbers in an arbitrary session frame. */
function markResult(window: NativeMarkAnchorResult["window"]): NativeMarkAnchorResult {
  return {
    t: 12.5,
    frame: 750,
    anchorId: "6a1c4d9e-3f0b-4c55-9d2a-0b7e8f1a2c3d",
    hit: {
      point: [0.5, -1.4, -2],
      normal: [0, 1, 0],
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, -1.4, -2, 1],
    },
    facing: [0, 0, -1],
    camera: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    window,
  };
}

class ManualTimers implements WalkTimers {
  private next = 1;
  readonly active = new Map<number, () => void>();

  setInterval(callback: () => void): unknown {
    const handle = this.next++;
    this.active.set(handle, callback);
    return handle;
  }

  clearInterval(handle: unknown): void {
    this.active.delete(handle as number);
  }

  /** Fires every active timer once (one second passes). */
  second(): void {
    for (const callback of [...this.active.values()]) callback();
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function setUp(
  capabilities: Capabilities,
  extra: Partial<CaptureNativeModule> = {},
  withSession = true,
) {
  const { module, sessions } = fakeModule({ withSession, capabilities });
  Object.assign(module, extra);
  const port = moduleCaptureNative(module);
  if (!port) throw new Error("no port");
  const timers = new ManualTimers();
  const controller = new WalkController(port, { timers });
  const session = (): FakeSession => {
    const made = sessions.at(-1);
    if (!made) throw new Error("no session opened");
    return made;
  };
  return { controller, sessions, session, timers };
}

function run(state: WalkState, ...actions: WalkAction[]): WalkState {
  return actions.reduce(walkReducer, state);
}

describe("walkCalls", () => {
  const ready = run(
    initialWalkState(true),
    { type: "toggleVenue", id: SOUTH_BEACH },
    { type: "confirmVenues" },
    { type: "confirmRecord" },
  );

  test("start, with the flow's options, on entering starting", () => {
    const starting = run(ready, { type: "start" });
    expect(walkCalls(ready, starting)).toEqual([
      { call: "start", options: { record: "off", venues: [SOUTH_BEACH] } },
    ]);
    expect(walkCalls(starting, starting)).toEqual([]);
  });

  test("a mark once per pending mark, a tag once per tap, stop once", () => {
    const armed = run(ready, { type: "start" }, { type: "started" });
    const marking = run(
      armed,
      { type: "setStreetFacing", streetFacing: true },
      { type: "markStart" },
    );
    expect(walkCalls(armed, marking)).toEqual([
      {
        call: "markAnchor",
        options: {
          role: "start",
          kind: "floor_point",
          streetFacing: true,
          endSessionHere: false,
          name: null,
        },
      },
    ]);
    const walking = run(marking, { type: "marked", window: "opened" });
    expect(walkCalls(marking, walking)).toEqual([]);
    const tagging = run(walking, { type: "addTag", kind: "escalator" });
    expect(walkCalls(walking, tagging)).toEqual([{ call: "addTag", kind: "escalator" }]);
    const stopping = run(walking, { type: "stop" });
    expect(walkCalls(walking, stopping)).toEqual([{ call: "stop" }]);
  });

  test("the hold-still countdown asks for the end mark only when it reaches 0", () => {
    let state = run(
      ready,
      { type: "start" },
      { type: "started" },
      { type: "markStart" },
      { type: "marked", window: "opened" },
      { type: "holdStill" },
    );
    for (let second = 1; second < 5; second++) {
      const next = run(state, { type: "holdTick" });
      expect(walkCalls(state, next)).toEqual([]);
      state = next;
    }
    const next = run(state, { type: "holdTick" });
    expect(walkCalls(state, next)).toEqual([
      {
        call: "markAnchor",
        options: {
          role: "end",
          kind: "floor_point",
          streetFacing: false,
          endSessionHere: true,
          name: null,
        },
      },
    ]);
  });

  test("permissions when asked", () => {
    const record = run(
      initialWalkState(true),
      { type: "toggleVenue", id: SOUTH_BEACH },
      { type: "confirmVenues" },
      { type: "chooseRecord", record: "lean" },
      { type: "confirmRecord" },
    );
    const asking = run(record, { type: "requestPermissions" });
    expect(walkCalls(record, asking)).toEqual([{ call: "permissions" }]);
  });
});

describe("recordingAction", () => {
  test("carries the state and, for closed and failed, their fields", () => {
    expect(recordingAction({ t: redact(1), state: "open", startT: redact(1) })).toEqual({
      type: "recording",
      phase: "open",
    });
    expect(
      recordingAction({
        t: redact(2),
        state: "closed",
        ended: "end_anchor",
        trimmed: false,
        closed: true,
      }),
    ).toEqual({
      type: "recording",
      phase: "closed",
      ended: "end_anchor",
      trimmed: false,
      closed: true,
    });
    expect(recordingAction({ t: redact(3), state: "failed", code: "ERR_IO" })).toEqual({
      type: "recording",
      phase: "failed",
      code: "ERR_IO",
    });
  });
});

describe("a lean walk through the controller", () => {
  test("from the venues to the summary, ending with End the session here", async () => {
    const permissionCalls: string[] = [];
    const { controller, sessions, session, timers } = setUp(WALK_CAPABILITIES, {
      requestRecorderPermissions: async () => {
        permissionCalls.push("asked");
        return PERMISSIONS;
      },
    });
    const { dispatch } = controller;
    let published = 0;
    controller.subscribe(() => published++);

    dispatch({ type: "toggleVenue", id: SOUTH_BEACH });
    dispatch({ type: "confirmVenues" });
    dispatch({ type: "chooseRecord", record: "lean" });
    dispatch({ type: "confirmRecord" });
    expect(controller.getSnapshot().state.step).toBe("permissions");
    expect(sessions).toHaveLength(0);

    dispatch({ type: "requestPermissions" });
    await flush();
    expect(permissionCalls).toEqual(["asked"]);
    let snapshot = controller.getSnapshot();
    expect(snapshot.state.step).toBe("ready");
    expect(snapshot.state.permissions).toEqual(PERMISSIONS);
    // The session is opened at Ready, so the view has it before Start.
    expect(sessions).toHaveLength(1);
    expect(snapshot.session?.native).toBe(session());
    expect(snapshot.sessionAvailable).toBe(true);

    dispatch({ type: "start" });
    await flush();
    expect(session().startOptions).toEqual([{ record: "lean", venues: [SOUTH_BEACH] }]);
    expect(controller.getSnapshot().state.step).toBe("armed");
    expect(timers.active.size).toBe(1);
    session().emit("recording", { t: 0.1, state: "armed" });

    // Status at 5 Hz: kept for the badge and the debug card, its time still redacted.
    session().emit("status", {
      t: 1,
      running: true,
      covered: false,
      tracking: "normal",
      mapping: "extending",
      fps: 60,
      candidateHz: 0,
      meshAnchors: 12,
      thermal: "nominal",
      recorder: { state: "armed", degradation: null, closingInS: null },
      debug: { fps: 60, delegateUsP95: 210 },
    });
    snapshot = controller.getSnapshot();
    expect(String(snapshot.status?.t)).toBe("[redacted]");
    expect(snapshot.debug).toEqual({ fps: 60, delegateUsP95: 210 });

    session().markResult = markResult("opened");
    dispatch({ type: "setStreetFacing", streetFacing: true });
    dispatch({ type: "markStart" });
    await flush();
    expect(session().markOptions).toEqual([
      { role: "start", kind: "floor_point", streetFacing: true, endSessionHere: false, name: null },
    ]);
    expect(controller.getSnapshot().state.step).toBe("walking");
    session().emit("recording", { t: 12.5, state: "open", startT: 12.5 });
    expect(controller.getSnapshot().state.recording.phase).toBe("open");

    session().tagResult = { t: 20, frame: 1200, position: [1, -1.4, -6], camera: [] };
    dispatch({ type: "addTag", kind: "escalator" });
    await flush();
    expect(session().tagOptions).toEqual([{ type: "node", kind: "escalator", name: null }]);
    expect(controller.getSnapshot().state.tags).toEqual({ escalator: 1 });

    timers.second();
    timers.second();
    expect(controller.getSnapshot().state.recordingS).toBe(2);

    // Mark end and end the session here: 5 s held still, then the end mark.
    session().markResult = markResult("open");
    dispatch({ type: "holdStill" });
    expect(timers.active.size).toBe(2);
    for (let second = 0; second < 5; second++) timers.second();
    await flush();
    expect(session().markOptions.at(-1)).toEqual({
      role: "end",
      kind: "floor_point",
      streetFacing: false,
      endSessionHere: true,
      name: null,
    });
    expect(controller.getSnapshot().state.step).toBe("closing");
    expect(timers.active.size).toBe(1);

    session().emit("recording", { t: 40, state: "closing" });
    session().emit("recording", { t: 45, state: "finalizing" });
    expect(controller.getSnapshot().state.step).toBe("saving");
    session().emit("stopped", { t: 45 });
    expect(controller.getSnapshot().state.step).toBe("saving");
    expect(timers.active.size).toBe(0);
    const fake = session();
    fake.emit("recording", {
      t: 45,
      state: "closed",
      ended: "end_anchor",
      trimmed: false,
      closed: true,
    });

    snapshot = controller.getSnapshot();
    expect(snapshot.state.step).toBe("summary");
    expect(snapshot.state.recording).toEqual({
      phase: "closed",
      ended: "end_anchor",
      trimmed: false,
      closed: true,
    });
    expect(snapshot.state.startMarks).toBe(1);
    expect(snapshot.state.endMarks).toBe(1);
    // The summary releases the session; the next session opens a new one.
    expect(snapshot.session).toBe(null);
    expect(fake.released).toBe(true);
    expect(published).toBeGreaterThan(10);

    dispatch({ type: "newSession" });
    expect(sessions).toHaveLength(2);
    expect(controller.getSnapshot().state.step).toBe("ready");
    controller.dispose();
    expect(session().released).toBe(true);
  });

  test("Stop from a record-off desk check calls stop and ends at the summary", async () => {
    const { controller, session, timers } = setUp(DEV_CAPABILITIES);
    const { dispatch } = controller;
    dispatch({ type: "toggleVenue", id: SOUTH_BEACH });
    dispatch({ type: "confirmVenues" });
    dispatch({ type: "chooseRecord", record: "lean" });
    expect(controller.getSnapshot().state.record).toBe("off");
    dispatch({ type: "confirmRecord" });
    dispatch({ type: "start" });
    await flush();
    expect(session().startOptions).toEqual([{ record: "off", venues: [SOUTH_BEACH] }]);
    dispatch({ type: "stop" });
    await flush();
    expect(session().calls).toEqual(["start", "stop"]);
    expect(controller.getSnapshot().state.step).toBe("summary");
    expect(timers.active.size).toBe(0);
    expect(session().released).toBe(true);
  });
});

describe("refusals and older builds", () => {
  test("a refused start goes back to Ready with the code and the refusal", async () => {
    const { controller, session } = setUp(WALK_CAPABILITIES, {
      requestRecorderPermissions: async () => PERMISSIONS,
    });
    const { dispatch } = controller;
    dispatch({ type: "toggleVenue", id: SOUTH_BEACH });
    dispatch({ type: "confirmVenues" });
    dispatch({ type: "confirmRecord" });
    session().startError = Object.assign(
      new Error("Calling the 'start' function has failed\n→ Caused by: lowDisk"),
      { code: "ERR_RECORD_REFUSED" },
    );
    dispatch({ type: "start" });
    await flush();
    const snapshot = controller.getSnapshot();
    expect(snapshot.state.step).toBe("ready");
    expect(snapshot.state.error).toEqual({ source: "start", code: "ERR_RECORD_REFUSED" });
    expect(snapshot.refusal).toBe("lowDisk");
    expect(snapshot.state.sessionRunning).toBe(false);
  });

  test("a build without the CaptureSession class says so at Ready, and Start fails safely", async () => {
    const { controller, sessions } = setUp(DEV_CAPABILITIES, {}, false);
    const { dispatch } = controller;
    dispatch({ type: "toggleVenue", id: SOUTH_BEACH });
    dispatch({ type: "confirmVenues" });
    dispatch({ type: "confirmRecord" });
    expect(sessions).toHaveLength(0);
    expect(controller.getSnapshot().sessionAvailable).toBe(false);
    dispatch({ type: "start" });
    await flush();
    expect(controller.getSnapshot().state.step).toBe("ready");
    expect(controller.getSnapshot().state.error).toEqual({ source: "start", code: "ERR_NO_VIEW" });
  });

  test("a screenshot warning is kept until acknowledged; other warnings are kept as the latest", () => {
    const { controller, session } = setUp(DEV_CAPABILITIES);
    controller.dispatch({ type: "toggleVenue", id: SOUTH_BEACH });
    controller.dispatch({ type: "confirmVenues" });
    controller.dispatch({ type: "confirmRecord" });
    session().emit("warning", { t: 3, kind: "screenshot" });
    session().emit("warning", { t: 4, kind: "interrupted" });
    expect(controller.getSnapshot().screenshot).toBe(true);
    expect(controller.getSnapshot().warning?.kind).toBe("interrupted");
    controller.acknowledgeScreenshot();
    expect(controller.getSnapshot().screenshot).toBe(false);
  });

  test("dispose releases the session, clears the timers and ignores later results", async () => {
    const { controller, session, timers } = setUp(DEV_CAPABILITIES);
    const { dispatch } = controller;
    dispatch({ type: "toggleVenue", id: SOUTH_BEACH });
    dispatch({ type: "confirmVenues" });
    dispatch({ type: "confirmRecord" });
    dispatch({ type: "start" });
    await flush();
    expect(timers.active.size).toBe(1);
    const before = controller.getSnapshot();
    controller.dispose();
    expect(timers.active.size).toBe(0);
    expect(session().released).toBe(true);
    dispatch({ type: "stop" });
    expect(controller.getSnapshot()).toBe(before);
  });
});
