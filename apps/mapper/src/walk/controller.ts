// The walk screen's wiring (the lean recorder design, section 10): the flow reducer
// (src/walk/flow.ts) joined to the CaptureNative port (src/capture/native.ts). The screen renders
// the snapshot and dispatches what the user did; the controller makes the call each step asks for
// and dispatches its result, turns the session's `recording` and `stopped` events into actions,
// keeps the latest status (for the REC badge and the debug card), runs the session's 1 s tick and
// the hold-still countdown's own tick, and opens and releases the CaptureSession.
//
// Which call a change of state asks for is a pure function (`walkCalls`), so Vitest checks it on
// its own and, with a fake module, the whole wiring. The controller holds no pose and no session
// time: results become flow actions, which carry none, and the status keeps its time Redacted.
// Environment-neutral: the timers are injected.

import type { NodeKind } from "@usg/contracts";
import type {
  CaptureErrorCode,
  DebugFigures,
  MarkAnchorOptions,
  RecordRefusal,
  StartOptions,
} from "../../modules/capture-native/src/types.ts";
import {
  type CaptureNative,
  type CaptureSessionPort,
  captureErrorCode,
  type RecordingEvent,
  recordRefusalOf,
  type SessionStatus,
  type SessionWarning,
} from "../capture/native.ts";
import {
  initialWalkState,
  type SessionCall,
  type WalkAction,
  type WalkState,
  walkMarkOptions,
  walkReducer,
  walkStartOptions,
} from "./flow.ts";
import { isNodeTagKind, nodeTagOptions } from "./tags.ts";

/** A call a change of state asks for. */
export type WalkCall =
  | { readonly call: "permissions" }
  | { readonly call: "start"; readonly options: StartOptions }
  | { readonly call: "markAnchor"; readonly options: MarkAnchorOptions }
  | { readonly call: "addTag"; readonly kind: NodeKind }
  | { readonly call: "stop" };

/** The calls the change from `prev` to `next` asks for, in the order to make them. */
export function walkCalls(prev: WalkState, next: WalkState): WalkCall[] {
  const calls: WalkCall[] = [];
  if (next.requestingPermissions && !prev.requestingPermissions) {
    calls.push({ call: "permissions" });
  }
  if (next.step === "starting" && prev.step !== "starting") {
    calls.push({ call: "start", options: walkStartOptions(next) });
  }
  if (next.step === "marking" && next.mark !== null && next.mark !== prev.mark) {
    const options = walkMarkOptions(next);
    if (options) calls.push({ call: "markAnchor", options });
  }
  if (next.tagging !== null && prev.tagging === null && isNodeTagKind(next.tagging)) {
    calls.push({ call: "addTag", kind: next.tagging });
  }
  if (next.step === "stopping" && prev.step !== "stopping") calls.push({ call: "stop" });
  return calls;
}

/** The flow action for one of the session's `recording` events. */
export function recordingAction(event: RecordingEvent): WalkAction {
  switch (event.state) {
    case "closed":
      return {
        type: "recording",
        phase: "closed",
        ended: event.ended,
        trimmed: event.trimmed,
        closed: event.closed,
      };
    case "failed":
      return { type: "recording", phase: "failed", code: event.code };
    case "armed":
    case "open":
    case "closing":
    case "finalizing":
    case "discarded":
      return { type: "recording", phase: event.state };
  }
}

export interface WalkTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const GLOBAL_TIMERS: WalkTimers = {
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) =>
    globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
};

export interface WalkSnapshot {
  readonly state: WalkState;
  /** The session the camera view shows, from Ready until the summary; null otherwise. */
  readonly session: CaptureSessionPort | null;
  /** False when this build has no CaptureSession class (a build from before the native glue). */
  readonly sessionAvailable: boolean;
  /** The latest 5 Hz status of the running session, else null. */
  readonly status: SessionStatus | null;
  /** The latest debug figures (every fifth status), kept until the next session. */
  readonly debug: DebugFigures | null;
  /** The latest warning other than a screenshot, until the next session. */
  readonly warning: SessionWarning | null;
  /** A screenshot was taken while the camera ran: the screen asks the owner to delete it. */
  readonly screenshot: boolean;
  /** Why the last start was refused (`ERR_RECORD_REFUSED`'s reason), until the next start. */
  readonly refusal: RecordRefusal | null;
}

export interface WalkControllerOptions {
  readonly timers?: WalkTimers;
}

export class WalkController {
  private readonly capture: CaptureNative;
  private readonly timers: WalkTimers;
  private readonly listeners = new Set<() => void>();
  private state: WalkState;
  private session: CaptureSessionPort | null = null;
  private sessionAvailable = true;
  private unsubscribe: (() => void)[] = [];
  private status: SessionStatus | null = null;
  private debug: DebugFigures | null = null;
  private warning: SessionWarning | null = null;
  private screenshot = false;
  private refusal: RecordRefusal | null = null;
  private tickTimer: unknown = null;
  private holdTimer: unknown = null;
  private disposed = false;
  private snapshot: WalkSnapshot;

  constructor(capture: CaptureNative, options: WalkControllerOptions = {}) {
    this.capture = capture;
    this.timers = options.timers ?? GLOBAL_TIMERS;
    this.state = initialWalkState(capture.capabilities().recorder.canRecord);
    this.snapshot = this.makeSnapshot();
  }

  getSnapshot = (): WalkSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  dispatch = (action: WalkAction): void => {
    if (this.disposed) return;
    const prev = this.state;
    const next = walkReducer(prev, action);
    if (next === prev) return;
    this.state = next;
    this.afterChange(prev, next);
    this.publish();
  };

  /** The owner deleted the screenshot. */
  acknowledgeScreenshot = (): void => {
    this.screenshot = false;
    this.publish();
  };

  /** Stops the timers and releases the session. The screen calls it when it unmounts. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTick();
    this.stopHold();
    this.releaseSession();
    this.listeners.clear();
  }

  private afterChange(prev: WalkState, next: WalkState): void {
    if (next.step === "ready" && !this.session) this.openSession();
    if (next.step === "summary" && prev.step !== "summary") this.releaseSession();

    if (next.sessionRunning && this.tickTimer === null) {
      this.tickTimer = this.timers.setInterval(() => this.dispatch({ type: "tick" }), 1000);
    } else if (!next.sessionRunning) {
      this.stopTick();
    }
    if (next.step === "holding" && prev.step !== "holding") {
      this.stopHold();
      this.holdTimer = this.timers.setInterval(() => this.dispatch({ type: "holdTick" }), 1000);
    } else if (next.step !== "holding") {
      this.stopHold();
    }

    for (const call of walkCalls(prev, next)) void this.run(call);
  }

  private async run(call: WalkCall): Promise<void> {
    const session = this.session;
    const failed = (name: SessionCall, error: unknown): void => {
      const code: CaptureErrorCode | null = captureErrorCode(error);
      if (name === "start") this.refusal = recordRefusalOf(error);
      this.dispatch({ type: "callFailed", call: name, code });
    };
    switch (call.call) {
      case "permissions":
        try {
          const permissions = await this.capture.requestPermissions();
          this.dispatch({ type: "permissionsResult", permissions });
        } catch (error) {
          failed("permissions", error);
        }
        return;
      case "start":
        this.refusal = null;
        if (!session) {
          this.dispatch({ type: "callFailed", call: "start", code: "ERR_NO_VIEW" });
          return;
        }
        try {
          await session.start(call.options);
          this.dispatch({ type: "started" });
        } catch (error) {
          failed("start", error);
        }
        return;
      case "markAnchor":
        if (!session) {
          this.dispatch({ type: "callFailed", call: "markAnchor", code: "ERR_NOT_RUNNING" });
          return;
        }
        try {
          // The result's pose stays in the port's trace; the flow needs only the window.
          const result = await session.markAnchor(call.options);
          this.dispatch({ type: "marked", window: result.window });
        } catch (error) {
          failed("markAnchor", error);
        }
        return;
      case "addTag":
        if (!session) {
          this.dispatch({ type: "callFailed", call: "addTag", code: "ERR_NOT_RUNNING" });
          return;
        }
        try {
          await session.addTag(nodeTagOptions(call.kind));
          this.dispatch({ type: "tagAdded" });
        } catch (error) {
          failed("addTag", error);
        }
        return;
      case "stop":
        if (!session) {
          this.dispatch({ type: "stopped", recording: null });
          return;
        }
        try {
          const result = await session.stop();
          this.dispatch({ type: "stopped", recording: result.recording });
        } catch (error) {
          failed("stop", error);
        }
        return;
    }
  }

  private openSession(): void {
    const session = this.capture.openSession();
    this.sessionAvailable = session !== null;
    if (!session) return;
    this.session = session;
    this.status = null;
    this.debug = null;
    this.warning = null;
    this.unsubscribe = [
      session.on("status", (status) => {
        this.status = status;
        if (status.debug) this.debug = status.debug;
        this.publish();
      }),
      session.on("warning", (warning) => {
        if (warning.kind === "screenshot") this.screenshot = true;
        else this.warning = warning;
        this.publish();
      }),
      session.on("recording", (event) => this.dispatch(recordingAction(event))),
      session.on("stopped", () => this.dispatch({ type: "stopped", recording: null })),
    ];
  }

  private releaseSession(): void {
    const session = this.session;
    if (!session) return;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.session = null;
    this.status = null;
    session.release();
  }

  private stopTick(): void {
    if (this.tickTimer === null) return;
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private stopHold(): void {
    if (this.holdTimer === null) return;
    this.timers.clearInterval(this.holdTimer);
    this.holdTimer = null;
  }

  private makeSnapshot(): WalkSnapshot {
    return {
      state: this.state,
      session: this.session,
      sessionAvailable: this.sessionAvailable,
      status: this.status,
      debug: this.debug,
      warning: this.warning,
      screenshot: this.screenshot,
      refusal: this.refusal,
    };
  }

  private publish(): void {
    if (this.disposed) return;
    this.snapshot = this.makeSnapshot();
    for (const listener of this.listeners) listener();
  }
}
