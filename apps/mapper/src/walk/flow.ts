// The walk flow (the lean recorder design, section 10) as a pure reducer, so Vitest covers it and
// the walk screen only renders the state and makes the calls a step asks for:
//   venues → record (Off, or Lean when the build can record) → permissions (Lean only) → Start →
//   Mark start (street-facing toggle) → tags → Mark end, or "Mark end and end the session here"
//   after a 5 s hold-still countdown → Saving… → a summary of counts and durations.
// The screen dispatches what the user did, what each call returned (`started`, `marked`,
// `tagAdded`, `stopped`, `callFailed`), the session's `recording` events and a `tick` each second.
// The hold-still countdown has its own `holdTick`, each second from a timer the screen starts when
// it sends `holdStill`: the session's ticks run freely, so the first one after the tap could come
// at once and cut the hold short.
// The state holds no pose and no session time; durations are counted from the ticks.

import type {
  CaptureErrorCode,
  MarkAnchorOptions,
  MarkWindow,
  RecorderPermissions,
  RecordingEnded,
  RecordingOutcome,
  StartOptions,
} from "../../modules/capture-native/src/types.ts";
import { isNodeTagKind } from "./tags.ts";
import { isCorridorVenue, MAX_SESSION_VENUES } from "./venues.ts";

/** "Mark end and end the session here" waits this long, the phone held still, before marking. */
export const HOLD_STILL_S = 5;

export type RecordChoice = "off" | "lean";

export type WalkStep =
  | "venues"
  | "record"
  | "permissions"
  | "ready"
  | "starting"
  /** The session runs; the recorder waits for the start mark. */
  | "armed"
  /** After the start mark: tags and end marks. */
  | "walking"
  /** A mark is being made (`mark` says which); the screen calls markAnchor. */
  | "marking"
  /** The hold-still countdown before "Mark end and end the session here". */
  | "holding"
  /** End the session here was marked: the recording closes a margin later, then the session stops. */
  | "closing"
  /** Stop was tapped; the screen calls stop. */
  | "stopping"
  /** The recording is being finalized. */
  | "saving"
  | "summary";

export type RecordingPhase =
  | "none"
  | "armed"
  | "open"
  | "closing"
  | "finalizing"
  | "closed"
  | "discarded"
  | "failed";

export interface PendingMark {
  readonly role: "start" | "end";
  readonly endSessionHere: boolean;
  readonly streetFacing: boolean;
}

export interface RecordingProgress {
  readonly phase: RecordingPhase;
  readonly ended: RecordingEnded | null;
  readonly trimmed: boolean | null;
  readonly closed: boolean | null;
}

export type SessionCall = "start" | "markAnchor" | "addTag" | "stop" | "permissions";

/** Where an error came from: a call, or the recorder's own `failed` or `discarded` state. */
export type ErrorSource = SessionCall | "recorder";

/**
 * A Lean recording the module let go of while the session still runs, so nothing more is
 * recorded: before the window opened (the app went to the background, or the phone got hot,
 * while armed), or after it opened but before an end mark.
 */
export type RecordingDropped = "beforeStart" | "beforeEnd";

export interface WalkError {
  readonly source: ErrorSource;
  /** Null for a rejection without a code, and for a dropped recording. */
  readonly code: CaptureErrorCode | null;
  /** Set when the recording was dropped while the session runs: the walker should Stop. */
  readonly dropped?: RecordingDropped;
}

export interface WalkState {
  readonly step: WalkStep;
  /** Whether this build may record now (`recorder.canRecord`). */
  readonly canRecord: boolean;
  readonly venues: readonly string[];
  readonly record: RecordChoice;
  readonly permissions: RecorderPermissions | null;
  readonly requestingPermissions: boolean;
  /** Applies to the next mark, then goes back to off. */
  readonly streetFacing: boolean;
  /**
   * The mark being made: set in `marking`, and kept until its call returns, even after Stop, since
   * the module still makes the anchor and the summary counts it.
   */
  readonly mark: PendingMark | null;
  readonly holdRemainingS: number | null;
  /** The tag kind being added, if any. */
  readonly tagging: string | null;
  readonly sessionRunning: boolean;
  /** Stop was asked for: a recording that closes now waits in Saving for the session to stop. */
  readonly stopRequested: boolean;
  readonly startMarks: number;
  readonly endMarks: number;
  readonly tags: Readonly<Record<string, number>>;
  readonly recording: RecordingProgress;
  /** Whole seconds the session ran, and the recording window was open, counted from ticks. */
  readonly sessionS: number;
  readonly recordingS: number;
  /**
   * Whether this session's recording window ever opened (a start mark's `opened`, or the
   * recording's `open` event): tells a recording dropped before the start mark from one dropped
   * before an end mark.
   */
  readonly windowOpened: boolean;
  /** The last error (a call's code, null for a rejection without one), until dismissed. */
  readonly error: WalkError | null;
}

export type WalkAction =
  | { readonly type: "toggleVenue"; readonly id: string }
  | { readonly type: "confirmVenues" }
  | { readonly type: "chooseRecord"; readonly record: RecordChoice }
  | { readonly type: "confirmRecord" }
  | { readonly type: "back" }
  | { readonly type: "requestPermissions" }
  | { readonly type: "permissionsResult"; readonly permissions: RecorderPermissions }
  | { readonly type: "start" }
  | { readonly type: "started" }
  | { readonly type: "setStreetFacing"; readonly streetFacing: boolean }
  | { readonly type: "markStart" }
  | { readonly type: "markEnd" }
  | { readonly type: "holdStill" }
  | { readonly type: "cancelHold" }
  | { readonly type: "tick" }
  /** Each second of the hold-still countdown, from the screen's own timer (see the header). */
  | { readonly type: "holdTick" }
  | { readonly type: "marked"; readonly window: MarkWindow }
  | { readonly type: "addTag"; readonly kind: string }
  | { readonly type: "tagAdded" }
  | { readonly type: "stop" }
  /** The session stopped: stop's result, or the `stopped` event (recording null). */
  | { readonly type: "stopped"; readonly recording: RecordingOutcome | null }
  /** A `recording` event's state. */
  | {
      readonly type: "recording";
      readonly phase: Exclude<RecordingPhase, "none">;
      readonly ended?: RecordingEnded;
      readonly trimmed?: boolean;
      readonly closed?: boolean;
      readonly code?: CaptureErrorCode;
    }
  | {
      readonly type: "callFailed";
      readonly call: SessionCall;
      readonly code: CaptureErrorCode | null;
    }
  | { readonly type: "dismissError" }
  /** From the summary: another session with the same venues and choice. */
  | { readonly type: "newSession" };

const NO_RECORDING: RecordingProgress = { phase: "none", ended: null, trimmed: null, closed: null };

export function initialWalkState(canRecord: boolean): WalkState {
  return {
    step: "venues",
    canRecord,
    venues: [],
    record: "off",
    permissions: null,
    requestingPermissions: false,
    streetFacing: false,
    mark: null,
    holdRemainingS: null,
    tagging: null,
    sessionRunning: false,
    stopRequested: false,
    startMarks: 0,
    endMarks: 0,
    tags: {},
    recording: NO_RECORDING,
    sessionS: 0,
    recordingS: 0,
    windowOpened: false,
    error: null,
  };
}

/** The error for a Lean recording dropped while the session runs. */
function droppedError(state: WalkState): WalkError {
  return {
    source: "recorder",
    code: null,
    dropped: state.windowOpened ? "beforeEnd" : "beforeStart",
  };
}

/** The steps in which the session is running and Stop is offered. */
const STOPPABLE: ReadonlySet<WalkStep> = new Set([
  "armed",
  "walking",
  "marking",
  "holding",
  "closing",
]);

/** The steps from the Start tap until the summary: the session is starting, running or saving. */
const ACTIVE_STEPS: ReadonlySet<WalkStep> = new Set([
  "starting",
  "armed",
  "walking",
  "marking",
  "holding",
  "closing",
  "stopping",
  "saving",
]);

/**
 * Whether the walk holds the screen: from the Start tap (before the session has started, since
 * start can take a while) until the summary, and whenever the session runs. Meanwhile the layout
 * hides the tab bar and refuses tab presses, so the walker can't leave the walk screen and the map
 * can't mount next to ARKit (ADR 0007).
 */
export function isWalkActive(state: WalkState): boolean {
  return state.sessionRunning || ACTIVE_STEPS.has(state.step);
}

export function walkReducer(state: WalkState, action: WalkAction): WalkState {
  switch (action.type) {
    case "toggleVenue": {
      if (state.step !== "venues" || !isCorridorVenue(action.id)) return state;
      const venues = state.venues.includes(action.id)
        ? state.venues.filter((id) => id !== action.id)
        : [...state.venues, action.id];
      return venues.length > MAX_SESSION_VENUES ? state : { ...state, venues };
    }
    case "confirmVenues":
      return state.step === "venues" && state.venues.length > 0
        ? { ...state, step: "record" }
        : state;
    case "chooseRecord":
      if (state.step !== "record" || (action.record === "lean" && !state.canRecord)) return state;
      return { ...state, record: action.record };
    case "confirmRecord":
      if (state.step !== "record") return state;
      return {
        ...state,
        step: state.record === "lean" && !state.permissions ? "permissions" : "ready",
      };
    case "back":
      if (state.step === "record") return { ...state, step: "venues" };
      if (state.step === "permissions" || state.step === "ready")
        return { ...state, step: "record" };
      return state;
    case "requestPermissions":
      return state.step === "permissions" ? { ...state, requestingPermissions: true } : state;
    case "permissionsResult":
      if (state.step !== "permissions") return state;
      return {
        ...state,
        step: "ready",
        permissions: action.permissions,
        requestingPermissions: false,
      };
    case "start":
      return state.step === "ready" ? { ...state, step: "starting", error: null } : state;
    case "started":
      if (state.step !== "starting") return state;
      return { ...state, step: "armed", sessionRunning: true };
    case "setStreetFacing":
      if (!STOPPABLE.has(state.step) || state.step === "marking") return state;
      return { ...state, streetFacing: action.streetFacing };
    case "markStart":
      if (state.step !== "armed" || state.mark) return state;
      return { ...state, step: "marking", mark: pendingMark(state, "start", false), error: null };
    case "markEnd":
      if (state.step !== "walking" || state.tagging || state.mark) return state;
      return { ...state, step: "marking", mark: pendingMark(state, "end", false), error: null };
    case "holdStill":
      if (state.step !== "walking" || state.tagging || state.mark) return state;
      return { ...state, step: "holding", holdRemainingS: HOLD_STILL_S, error: null };
    case "cancelHold":
      return state.step === "holding" ? { ...state, step: "walking", holdRemainingS: null } : state;
    case "tick":
      return tick(state);
    case "holdTick":
      return holdTick(state);
    case "marked":
      return marked(state, action.window);
    case "addTag":
      if (state.step !== "walking" || state.tagging || !isNodeTagKind(action.kind)) return state;
      return { ...state, tagging: action.kind, error: null };
    case "tagAdded": {
      if (!state.tagging) return state;
      const kind = state.tagging;
      return {
        ...state,
        tagging: null,
        tags: { ...state.tags, [kind]: (state.tags[kind] ?? 0) + 1 },
      };
    }
    case "stop":
      if (!STOPPABLE.has(state.step)) return state;
      return { ...state, step: "stopping", stopRequested: true, holdRemainingS: null };
    case "stopped":
      return stopped(state, action.recording);
    case "recording":
      return recordingChanged(state, action);
    case "callFailed":
      return callFailed(state, action.call, action.code);
    case "dismissError":
      return { ...state, error: null };
    case "newSession":
      if (state.step !== "summary") return state;
      return {
        ...initialWalkState(state.canRecord),
        step: "ready",
        venues: state.venues,
        record: state.record,
        permissions: state.permissions,
      };
  }
}

function pendingMark(
  state: WalkState,
  role: "start" | "end",
  endSessionHere: boolean,
): PendingMark {
  return { role, endSessionHere, streetFacing: state.streetFacing };
}

function tick(state: WalkState): WalkState {
  if (!state.sessionRunning) return state;
  const windowOpen = state.recording.phase === "open" || state.recording.phase === "closing";
  return {
    ...state,
    sessionS: state.sessionS + 1,
    recordingS: state.recordingS + (windowOpen ? 1 : 0),
  };
}

function holdTick(state: WalkState): WalkState {
  if (state.step !== "holding" || state.holdRemainingS === null) return state;
  const remaining = state.holdRemainingS - 1;
  if (remaining > 0) return { ...state, holdRemainingS: remaining };
  return { ...state, step: "marking", holdRemainingS: null, mark: pendingMark(state, "end", true) };
}

function marked(state: WalkState, window: MarkWindow): WalkState {
  const mark = state.mark;
  if (!mark) return state;
  const recording = window === "opened" || window === "open" || window === "closing";
  const counted: WalkState = {
    ...state,
    mark: null,
    streetFacing: false,
    startMarks: state.startMarks + (mark.role === "start" ? 1 : 0),
    endMarks: state.endMarks + (mark.role === "end" ? 1 : 0),
    windowOpened: state.windowOpened || recording,
  };
  // Stop, or a close, came while the call was in flight: the anchor was still made, so count it
  // and leave the step where that put it.
  if (state.step !== "marking") return counted;
  if (mark.role === "start" && state.record === "lean" && window === "not_open") {
    // The module let go of the recording while it was armed (background, heat): the anchor was
    // made, but nothing is recorded. Stay armed and say so, so the walker stops and starts again
    // instead of walking the corridor for nothing.
    return { ...counted, step: "armed", error: droppedError(state) };
  }
  if (mark.role === "start" || !mark.endSessionHere) return { ...counted, step: "walking" };
  // With a recording window the module closes it a margin later and stops the session itself;
  // without one (record off) the screen stops the session.
  return recording
    ? { ...counted, step: "closing" }
    : { ...counted, step: "stopping", stopRequested: true };
}

function stopped(state: WalkState, outcome: RecordingOutcome | null): WalkState {
  if (!state.sessionRunning && state.step !== "stopping") return state;
  const recording: RecordingProgress = outcome
    ? { phase: "closed", ended: outcome.ended, trimmed: outcome.trimmed, closed: outcome.closed }
    : state.recording;
  const finishing =
    recording.phase === "open" || recording.phase === "closing" || recording.phase === "finalizing";
  return {
    ...state,
    sessionRunning: false,
    stopRequested: false,
    holdRemainingS: null,
    tagging: null,
    recording,
    windowOpened: state.windowOpened || outcome !== null,
    step: finishing ? "saving" : "summary",
  };
}

function recordingChanged(
  state: WalkState,
  event: Extract<WalkAction, { type: "recording" }>,
): WalkState {
  switch (event.phase) {
    case "armed":
      return { ...state, recording: { ...state.recording, phase: event.phase } };
    case "open":
    case "closing":
      return {
        ...state,
        recording: { ...state.recording, phase: event.phase },
        windowOpened: true,
      };
    case "finalizing":
      return {
        ...state,
        windowOpened: true,
        recording: { ...state.recording, phase: "finalizing" },
        step: state.step === "summary" ? state.step : "saving",
        holdRemainingS: null,
      };
    case "closed": {
      const recording: RecordingProgress = {
        phase: "closed",
        ended: event.ended ?? null,
        trimmed: event.trimmed ?? null,
        closed: event.closed ?? null,
      };
      const next: WalkState = { ...state, recording, windowOpened: true };
      // End the session here stops the session too, and so does Stop, whatever closed the
      // recording: wait for it. Any other close while the session runs (idle, background, heat,
      // disk, limit) leaves the walker to tap Stop.
      if (!state.sessionRunning) return { ...next, step: "summary" };
      if (event.ended === "end_anchor" || state.stopRequested) return { ...next, step: "saving" };
      const step = state.step === "saving" || state.step === "closing" ? "walking" : state.step;
      return { ...next, step };
    }
    case "discarded": {
      const recording: RecordingProgress = { ...NO_RECORDING, phase: "discarded" };
      if (!state.sessionRunning) return { ...state, recording, step: "summary" };
      // Stop discards a recording with no end mark: expected. Anything else (the app went to the
      // background, the phone got hot) drops it while the session keeps running, and nothing more
      // is recorded: say so, so the walker stops and starts a new session.
      if (state.stopRequested) return { ...state, recording };
      return { ...state, recording, error: droppedError(state) };
    }
    case "failed":
      return {
        ...state,
        recording: { ...state.recording, phase: "failed" },
        error: { source: "recorder", code: event.code ?? null },
        step: state.sessionRunning || state.step !== "saving" ? state.step : "summary",
      };
  }
}

function callFailed(state: WalkState, call: SessionCall, code: CaptureErrorCode | null): WalkState {
  const error: WalkError = { source: call, code };
  switch (call) {
    case "permissions":
      return { ...state, requestingPermissions: false, error };
    case "start":
      return state.step === "starting" ? { ...state, step: "ready", error } : { ...state, error };
    case "markAnchor": {
      if (state.step !== "marking" || !state.mark) return { ...state, mark: null, error };
      // The mark is made again by hand: a refused end mark never ends the session.
      return {
        ...state,
        step: state.mark.role === "start" ? "armed" : "walking",
        mark: null,
        error,
      };
    }
    case "addTag":
      return { ...state, tagging: null, error };
    case "stop":
      return { ...state, sessionRunning: false, stopRequested: false, step: "summary", error };
  }
}

/** What the screen passes to `start` in the `starting` step. */
export function walkStartOptions(state: WalkState): StartOptions {
  return { record: state.record, venues: state.venues };
}

/** What the screen passes to `markAnchor` in the `marking` step, or null in any other. */
export function walkMarkOptions(state: WalkState): MarkAnchorOptions | null {
  if (state.step !== "marking" || !state.mark) return null;
  return {
    role: state.mark.role,
    kind: "floor_point",
    streetFacing: state.mark.streetFacing,
    endSessionHere: state.mark.endSessionHere,
    name: null,
  };
}

export interface WalkSummary {
  readonly startMarks: number;
  readonly endMarks: number;
  readonly tags: number;
  readonly tagsByKind: Readonly<Record<string, number>>;
  readonly sessionS: number;
  readonly recordingS: number;
  readonly recording: RecordingProgress;
  /** Whether the recording window ever opened (see `WalkState.windowOpened`). */
  readonly windowOpened: boolean;
}

export function walkSummary(state: WalkState): WalkSummary {
  return {
    startMarks: state.startMarks,
    endMarks: state.endMarks,
    tags: Object.values(state.tags).reduce((sum, count) => sum + count, 0),
    tagsByKind: state.tags,
    sessionS: state.sessionS,
    recordingS: state.recordingS,
    recording: state.recording,
    windowOpened: state.windowOpened,
  };
}
