// The walk flow reducer (src/walk/flow.ts): the steps of a lean walk to the summary, the record-off
// desk path, and what refusals, stops and early closes do.

import { describe, expect, test } from "vitest";
import {
  HOLD_STILL_S,
  initialWalkState,
  type WalkAction,
  type WalkState,
  walkMarkOptions,
  walkReducer,
  walkStartOptions,
  walkSummary,
} from "../src/walk/flow.ts";
import { CORRIDOR_VENUES } from "../src/walk/venues.ts";

const SOUTH_BEACH = CORRIDOR_VENUES[0]?.id ?? "";
const ESPLANADE = CORRIDOR_VENUES[1]?.id ?? "";
const PERMISSIONS = { location: "granted", motion: "granted" };

function run(state: WalkState, ...actions: WalkAction[]): WalkState {
  return actions.reduce(walkReducer, state);
}

const ticks = (n: number): WalkAction[] => Array.from({ length: n }, () => ({ type: "tick" }));

/** A lean session, started, with venues chosen and permissions granted. */
function armed(): WalkState {
  return run(
    initialWalkState(true),
    { type: "toggleVenue", id: SOUTH_BEACH },
    { type: "toggleVenue", id: ESPLANADE },
    { type: "confirmVenues" },
    { type: "chooseRecord", record: "lean" },
    { type: "confirmRecord" },
    { type: "requestPermissions" },
    { type: "permissionsResult", permissions: PERMISSIONS },
    { type: "start" },
    { type: "started" },
    { type: "recording", phase: "armed" },
  );
}

function walking(): WalkState {
  return run(
    armed(),
    { type: "setStreetFacing", streetFacing: true },
    { type: "markStart" },
    { type: "marked", window: "opened" },
    { type: "recording", phase: "open" },
  );
}

describe("a lean walk, ending with End the session here", () => {
  test("goes through every step to the summary", () => {
    let state = initialWalkState(true);
    expect(state.step).toBe("venues");
    state = run(state, { type: "confirmVenues" });
    expect(state.step).toBe("venues");

    state = run(state, { type: "toggleVenue", id: SOUTH_BEACH }, { type: "confirmVenues" });
    expect(state.step).toBe("record");
    state = run(state, { type: "chooseRecord", record: "lean" }, { type: "confirmRecord" });
    expect(state.step).toBe("permissions");
    state = run(state, { type: "requestPermissions" });
    expect(state.requestingPermissions).toBe(true);
    state = run(state, { type: "permissionsResult", permissions: PERMISSIONS });
    expect(state.step).toBe("ready");
    expect(walkStartOptions(state)).toEqual({ record: "lean", venues: [SOUTH_BEACH] });

    state = run(state, { type: "start" });
    expect(state.step).toBe("starting");
    state = run(state, { type: "started" }, { type: "recording", phase: "armed" });
    expect(state.step).toBe("armed");

    state = run(state, { type: "setStreetFacing", streetFacing: true }, { type: "markStart" });
    expect(state.step).toBe("marking");
    expect(walkMarkOptions(state)).toEqual({
      role: "start",
      kind: "floor_point",
      streetFacing: true,
      endSessionHere: false,
      name: null,
    });
    state = run(state, { type: "marked", window: "opened" }, { type: "recording", phase: "open" });
    expect(state.step).toBe("walking");
    expect(state.streetFacing).toBe(false);

    state = run(state, { type: "addTag", kind: "escalator" });
    expect(state.tagging).toBe("escalator");
    expect(run(state, { type: "markEnd" }).step).toBe("walking");
    state = run(
      state,
      { type: "tagAdded" },
      { type: "addTag", kind: "escalator" },
      { type: "tagAdded" },
      { type: "addTag", kind: "door" },
      { type: "tagAdded" },
      ...ticks(60),
    );

    state = run(state, { type: "holdStill" });
    expect(state.step).toBe("holding");
    expect(state.holdRemainingS).toBe(HOLD_STILL_S);
    state = run(state, ...ticks(HOLD_STILL_S - 1));
    expect(state.step).toBe("holding");
    expect(state.holdRemainingS).toBe(1);
    state = run(state, { type: "tick" });
    expect(state.step).toBe("marking");
    expect(walkMarkOptions(state)).toMatchObject({ role: "end", endSessionHere: true });

    state = run(state, { type: "marked", window: "open" }, { type: "recording", phase: "closing" });
    expect(state.step).toBe("closing");
    state = run(state, ...ticks(5), { type: "recording", phase: "finalizing" });
    expect(state.step).toBe("saving");
    state = run(state, { type: "stopped", recording: null });
    expect(state.step).toBe("saving");
    state = run(state, {
      type: "recording",
      phase: "closed",
      ended: "end_anchor",
      trimmed: false,
      closed: true,
    });
    expect(state.step).toBe("summary");
    expect(walkSummary(state)).toEqual({
      startMarks: 1,
      endMarks: 1,
      tags: 3,
      tagsByKind: { escalator: 2, door: 1 },
      sessionS: 60 + HOLD_STILL_S + 5,
      recordingS: 60 + HOLD_STILL_S + 5,
      recording: { phase: "closed", ended: "end_anchor", trimmed: false, closed: true },
    });

    state = run(state, { type: "newSession" });
    expect(state.step).toBe("ready");
    expect(state.venues).toEqual([SOUTH_BEACH]);
    expect(state.record).toBe("lean");
    expect(walkSummary(state).tags).toBe(0);
  });

  test("the countdown can be cancelled, and Stop during it stops", () => {
    const holding = run(walking(), { type: "holdStill" }, { type: "tick" });
    const cancelled = run(holding, { type: "cancelHold" });
    expect(cancelled.step).toBe("walking");
    expect(cancelled.endMarks).toBe(0);
    expect(run(holding, { type: "stop" }).step).toBe("stopping");
  });

  test("closed before the session stops waits in Saving", () => {
    const state = run(
      walking(),
      { type: "holdStill" },
      ...ticks(HOLD_STILL_S),
      { type: "marked", window: "open" },
      { type: "recording", phase: "finalizing" },
      { type: "recording", phase: "closed", ended: "end_anchor", trimmed: false, closed: true },
    );
    expect(state.step).toBe("saving");
    expect(run(state, { type: "stopped", recording: null }).step).toBe("summary");
  });
});

describe("record off (a desk check, or a build that can't record)", () => {
  test("Lean can't be chosen without canRecord; Off skips the permissions", () => {
    let state = run(
      initialWalkState(false),
      { type: "toggleVenue", id: SOUTH_BEACH },
      { type: "confirmVenues" },
      { type: "chooseRecord", record: "lean" },
    );
    expect(state.record).toBe("off");
    state = run(state, { type: "confirmRecord" });
    expect(state.step).toBe("ready");
    expect(walkStartOptions(state).record).toBe("off");
  });

  test("End the session here without a window stops the session from the screen", () => {
    const state = run(
      initialWalkState(false),
      { type: "toggleVenue", id: SOUTH_BEACH },
      { type: "confirmVenues" },
      { type: "confirmRecord" },
      { type: "start" },
      { type: "started" },
      { type: "markStart" },
      { type: "marked", window: "not_open" },
      { type: "holdStill" },
      ...ticks(HOLD_STILL_S),
      { type: "marked", window: "not_open" },
    );
    expect(state.step).toBe("stopping");
    const done = run(state, { type: "stopped", recording: null });
    expect(done.step).toBe("summary");
    expect(walkSummary(done).recordingS).toBe(0);
  });
});

describe("refusals and early ends", () => {
  test("a refused start goes back to Ready with the code", () => {
    const state = run(armed(), { type: "stop" }, { type: "stopped", recording: null });
    expect(state.step).toBe("summary");
    const refused = run(
      initialWalkState(true),
      { type: "toggleVenue", id: SOUTH_BEACH },
      { type: "confirmVenues" },
      { type: "confirmRecord" },
      { type: "start" },
      { type: "callFailed", call: "start", code: "ERR_RECORD_REFUSED" },
    );
    expect(refused.step).toBe("ready");
    expect(refused.error).toEqual({ source: "start", code: "ERR_RECORD_REFUSED" });
    expect(run(refused, { type: "dismissError" }).error).toBe(null);
  });

  test("a refused mark is made again by hand, and never ends the session", () => {
    const start = run(
      armed(),
      { type: "markStart" },
      {
        type: "callFailed",
        call: "markAnchor",
        code: "ERR_TRACKING",
      },
    );
    expect(start.step).toBe("armed");
    const end = run(walking(), { type: "holdStill" }, ...ticks(HOLD_STILL_S), {
      type: "callFailed",
      call: "markAnchor",
      code: "ERR_NO_FLOOR_HIT",
    });
    expect(end.step).toBe("walking");
    expect(end.endMarks).toBe(0);
  });

  test("a refused tag clears the button", () => {
    const state = run(
      walking(),
      { type: "addTag", kind: "lift" },
      {
        type: "callFailed",
        call: "addTag",
        code: "ERR_TRACKING",
      },
    );
    expect(state.tagging).toBe(null);
    expect(state.tags).toEqual({});
  });

  test("Stop while open: stop's result carries the cut-back recording", () => {
    const state = run(
      walking(),
      { type: "markEnd" },
      { type: "marked", window: "open" },
      { type: "stop" },
      {
        type: "stopped",
        recording: {
          id: "0f7d0e65-6f2e-4b43-9a55-5d7f4f0c5b0e",
          ended: "stop",
          trimmed: true,
          closed: true,
        },
      },
    );
    expect(state.step).toBe("summary");
    expect(state.recording).toEqual({
      phase: "closed",
      ended: "stop",
      trimmed: true,
      closed: true,
    });
  });

  test("an idle close while walking leaves the walker to stop", () => {
    const state = run(
      walking(),
      { type: "recording", phase: "finalizing" },
      { type: "recording", phase: "closed", ended: "idle", trimmed: false, closed: true },
    );
    expect(state.step).toBe("walking");
    expect(state.sessionRunning).toBe(true);
    expect(run(state, ...ticks(3)).recordingS).toBe(0);
  });

  test("a recorder failure is shown; ticks stop counting the window", () => {
    const state = run(walking(), { type: "recording", phase: "failed", code: "ERR_IO" });
    expect(state.error).toEqual({ source: "recorder", code: "ERR_IO" });
    expect(run(state, ...ticks(2)).recordingS).toBe(0);
  });
});

describe("venues", () => {
  test("only corridor venues, toggled on and off", () => {
    let state = run(initialWalkState(true), { type: "toggleVenue", id: "not-a-venue" });
    expect(state.venues).toEqual([]);
    state = run(
      state,
      { type: "toggleVenue", id: ESPLANADE },
      { type: "toggleVenue", id: SOUTH_BEACH },
    );
    expect(state.venues).toEqual([ESPLANADE, SOUTH_BEACH]);
    state = run(state, { type: "toggleVenue", id: ESPLANADE });
    expect(state.venues).toEqual([SOUTH_BEACH]);
  });

  test("back goes one step back before the session starts, and nowhere after", () => {
    const ready = run(
      initialWalkState(true),
      { type: "toggleVenue", id: SOUTH_BEACH },
      { type: "confirmVenues" },
      { type: "confirmRecord" },
    );
    expect(run(ready, { type: "back" }).step).toBe("record");
    expect(run(ready, { type: "back" }, { type: "back" }).step).toBe("venues");
    expect(run(walking(), { type: "back" }).step).toBe("walking");
  });
});
