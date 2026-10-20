// The walk flow reducer (src/walk/flow.ts): the steps of a lean walk to the summary, the record-off
// desk path, and what refusals, stops and early closes do.

import { describe, expect, test } from "vitest";
import {
  HOLD_STILL_S,
  initialWalkState,
  isWalkActive,
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
const PERMISSIONS = { location: "whenInUse", preciseLocation: true, motion: "authorized" } as const;

function run(state: WalkState, ...actions: WalkAction[]): WalkState {
  return actions.reduce(walkReducer, state);
}

const ticks = (n: number): WalkAction[] => Array.from({ length: n }, () => ({ type: "tick" }));
const holdTicks = (n: number): WalkAction[] =>
  Array.from({ length: n }, () => ({ type: "holdTick" }));
/** n seconds of a hold: the session's tick and the hold's own tick each second. */
const heldSeconds = (n: number): WalkAction[] =>
  Array.from({ length: n }, (): WalkAction[] => [{ type: "tick" }, { type: "holdTick" }]).flat();

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
    state = run(state, ...heldSeconds(HOLD_STILL_S - 1));
    expect(state.step).toBe("holding");
    expect(state.holdRemainingS).toBe(1);
    state = run(state, { type: "tick" }, { type: "holdTick" });
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
      windowOpened: true,
    });

    state = run(state, { type: "newSession" });
    expect(state.windowOpened).toBe(false);
    expect(state.step).toBe("ready");
    expect(state.venues).toEqual([SOUTH_BEACH]);
    expect(state.record).toBe("lean");
    expect(walkSummary(state).tags).toBe(0);
  });

  test("the countdown can be cancelled, and Stop during it stops", () => {
    const holding = run(walking(), { type: "holdStill" }, { type: "holdTick" });
    const cancelled = run(holding, { type: "cancelHold" });
    expect(cancelled.step).toBe("walking");
    expect(cancelled.endMarks).toBe(0);
    expect(run(holding, { type: "stop" }).step).toBe("stopping");
  });

  test("the hold lasts HOLD_STILL_S of its own ticks from the tap; session ticks never end it", () => {
    let state = run(walking(), ...ticks(1), { type: "holdStill" }, ...ticks(HOLD_STILL_S * 2));
    expect(state.step).toBe("holding");
    expect(state.holdRemainingS).toBe(HOLD_STILL_S);
    expect(state.sessionS).toBe(1 + HOLD_STILL_S * 2);
    state = run(state, ...holdTicks(HOLD_STILL_S - 1));
    expect(state.step).toBe("holding");
    state = run(state, { type: "holdTick" });
    expect(state.step).toBe("marking");
    expect(walkMarkOptions(state)).toMatchObject({ role: "end", endSessionHere: true });
    expect(run(walking(), { type: "holdTick" }).step).toBe("walking");
  });

  test("closed before the session stops waits in Saving", () => {
    const state = run(
      walking(),
      { type: "holdStill" },
      ...holdTicks(HOLD_STILL_S),
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
      ...holdTicks(HOLD_STILL_S),
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
    const end = run(walking(), { type: "holdStill" }, ...holdTicks(HOLD_STILL_S), {
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

  test("Stop while open: the recording's finalizing and close wait in Saving for the stop", () => {
    const stopping = run(
      walking(),
      { type: "markEnd" },
      { type: "marked", window: "open" },
      { type: "stop" },
    );
    expect(stopping.step).toBe("stopping");
    const closed = run(
      stopping,
      { type: "recording", phase: "finalizing" },
      { type: "recording", phase: "closed", ended: "stop", trimmed: true, closed: true },
    );
    expect(closed.step).toBe("saving");
    // Nothing the walker could do while walking is taken: no second stop, mark, hold or tag.
    for (const action of [
      { type: "stop" },
      { type: "markEnd" },
      { type: "holdStill" },
      { type: "addTag", kind: "door" },
    ] as const) {
      expect(run(closed, action)).toEqual(closed);
    }
    const done = run(closed, {
      type: "stopped",
      recording: {
        id: "0f7d0e65-6f2e-4b43-9a55-5d7f4f0c5b0e",
        ended: "stop",
        trimmed: true,
        closed: true,
      },
    });
    expect(done.step).toBe("summary");
    expect(walkSummary(done).endMarks).toBe(1);
  });

  test("a close the walker didn't ask for, landing after Stop, also waits for the stop", () => {
    const state = run(
      walking(),
      { type: "stop" },
      { type: "recording", phase: "closed", ended: "background", trimmed: false, closed: true },
    );
    expect(state.step).toBe("saving");
    expect(run(state, { type: "stopped", recording: null }).step).toBe("summary");
  });

  test("a mark still in flight at Stop is counted when it resolves", () => {
    const start = run(
      armed(),
      { type: "markStart" },
      { type: "stop" },
      { type: "marked", window: "opened" },
    );
    expect(start.step).toBe("stopping");
    expect(run(start, { type: "stopped", recording: null }).startMarks).toBe(1);

    // The end mark's result can come after stop's, too.
    const end = run(
      walking(),
      { type: "markEnd" },
      { type: "stop" },
      {
        type: "stopped",
        recording: {
          id: "0f7d0e65-6f2e-4b43-9a55-5d7f4f0c5b0e",
          ended: "stop",
          trimmed: false,
          closed: true,
        },
      },
      { type: "marked", window: "open" },
    );
    expect(end.step).toBe("summary");
    expect(walkSummary(end).endMarks).toBe(1);
    expect(run(end, { type: "marked", window: "open" }).endMarks).toBe(1);
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

  test("a recording dropped while armed is shown, and a start mark then stays armed", () => {
    // Backgrounded or too hot on the way to the start door: the module discards the armed
    // recording while the session keeps running.
    const dropped = run(armed(), { type: "recording", phase: "discarded" });
    expect(dropped.step).toBe("armed");
    expect(dropped.sessionRunning).toBe(true);
    expect(dropped.error).toEqual({ source: "recorder", code: null, dropped: "beforeStart" });

    // The walker dismisses it (or never saw it) and marks the start: the anchor is made, but the
    // window is "not_open", so the flow stays armed and says so again rather than walking.
    const marked = run(
      dropped,
      { type: "dismissError" },
      { type: "markStart" },
      { type: "marked", window: "not_open" },
    );
    expect(marked.step).toBe("armed");
    expect(marked.startMarks).toBe(1);
    expect(marked.error).toEqual({ source: "recorder", code: null, dropped: "beforeStart" });
    expect(run(marked, { type: "markEnd" }).step).toBe("armed");

    const done = run(marked, { type: "stop" }, { type: "stopped", recording: null });
    expect(done.step).toBe("summary");
    expect(walkSummary(done)).toMatchObject({
      windowOpened: false,
      recordingS: 0,
      recording: { phase: "discarded" },
    });
  });

  test("a start mark's not_open with no discard event yet still stays armed", () => {
    const state = run(armed(), { type: "markStart" }, { type: "marked", window: "not_open" });
    expect(state.step).toBe("armed");
    expect(state.error).toEqual({ source: "recorder", code: null, dropped: "beforeStart" });
  });

  test("record off: a start mark's not_open is expected and walks on", () => {
    const state = run(
      initialWalkState(false),
      { type: "toggleVenue", id: SOUTH_BEACH },
      { type: "confirmVenues" },
      { type: "confirmRecord" },
      { type: "start" },
      { type: "started" },
      { type: "markStart" },
      { type: "marked", window: "not_open" },
    );
    expect(state.step).toBe("walking");
    expect(state.error).toBe(null);
  });

  test("a recording dropped after it opened, without Stop, is shown too", () => {
    const state = run(walking(), { type: "recording", phase: "discarded" });
    expect(state.step).toBe("walking");
    expect(state.error).toEqual({ source: "recorder", code: null, dropped: "beforeEnd" });
    expect(walkSummary(state).windowOpened).toBe(true);
  });

  test("Stop before the start mark discards quietly", () => {
    const state = run(
      armed(),
      { type: "stop" },
      { type: "recording", phase: "discarded" },
      { type: "stopped", recording: null },
    );
    expect(state.step).toBe("summary");
    expect(state.error).toBe(null);
    expect(walkSummary(state)).toMatchObject({
      windowOpened: false,
      recording: { phase: "discarded" },
    });
    const stopOpen = run(walking(), { type: "stop" }, { type: "recording", phase: "discarded" });
    expect(stopOpen.error).toBe(null);
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

describe("isWalkActive (the tab bar is hidden and tab presses refused while true)", () => {
  /** Ready to start a record-off desk check. */
  function ready(): WalkState {
    return run(
      initialWalkState(false),
      { type: "toggleVenue", id: SOUTH_BEACH },
      { type: "confirmVenues" },
      { type: "confirmRecord" },
    );
  }

  test("is off before Start", () => {
    expect(isWalkActive(initialWalkState(true))).toBe(false);
    expect(ready().step).toBe("ready");
    expect(isWalkActive(ready())).toBe(false);
  });

  test("is on from the Start tap, before the session has started", () => {
    const starting = run(ready(), { type: "start" });
    expect(starting.step).toBe("starting");
    expect(starting.sessionRunning).toBe(false);
    expect(isWalkActive(starting)).toBe(true);
  });

  test("is off again when start fails", () => {
    const refused = run(
      ready(),
      { type: "start" },
      { type: "callFailed", call: "start", code: "ERR_RECORD_REFUSED" },
    );
    expect(refused.step).toBe("ready");
    expect(isWalkActive(refused)).toBe(false);
  });

  test("stays on through every session step and Saving, and goes off at the summary", () => {
    const steps: string[] = [];
    let state = armed();
    const check = (next: WalkState) => {
      steps.push(next.step);
      expect(isWalkActive(next)).toBe(true);
      state = next;
    };
    check(state);
    check(walking());
    check(run(state, { type: "holdStill" }));
    check(run(state, ...heldSeconds(HOLD_STILL_S)));
    check(run(state, { type: "marked", window: "open" }, { type: "recording", phase: "closing" }));
    check(run(state, { type: "recording", phase: "finalizing" }));
    check(run(state, { type: "stopped", recording: null }));
    expect(state.sessionRunning).toBe(false);
    expect(state.step).toBe("saving");
    const done = run(state, {
      type: "recording",
      phase: "closed",
      ended: "end_anchor",
      trimmed: false,
      closed: true,
    });
    expect(done.step).toBe("summary");
    expect(isWalkActive(done)).toBe(false);
    expect(steps).toEqual(
      expect.arrayContaining(["armed", "walking", "holding", "marking", "closing", "saving"]),
    );

    const stopping = run(walking(), { type: "stop" });
    expect(stopping.step).toBe("stopping");
    expect(isWalkActive(stopping)).toBe(true);
    expect(isWalkActive(run(stopping, { type: "stopped", recording: null }))).toBe(true);
  });
});
