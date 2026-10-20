// The CaptureNative port (the lean recorder design, 3.4): how the app's screens reach the capture
// module's session and recorder. `moduleCaptureNative(module)` adapts the module object from
// modules/capture-native (pass its `CaptureNative` export); tests pass a fake.
//
// The adapter is the one place that sees the module's raw events and results. It feeds each to the
// session's BoundaryTrace first, then wraps every session time and pose in Redacted, so the rest of
// the app can't print one by accident. The raw values are declared with their Native… types, so
// the no-pose lint treats them as sensitive whatever they are named. Results JavaScript never gets
// a line for: `start` (it resolves before the window can open), `discard` (the recording is
// deleted), rejections (they carry a code, not a session time) and the recorder's plumbing.
//
// Builds before the native glue have the module but no CaptureSession class and no recorder
// functions: `openSession()` is then null, `listRecordings()` empty, `recoveryStatus()` null, and
// the rest reject with ERR_RECORDER_NOT_COMPILED, as the module itself does without the recorder.
// Expo Go and the web have no module at all: `moduleCaptureNative(null)` is null.
//
// Environment-neutral: no React Native or Expo imports, so Vitest runs it in Node.

import type {
  AddTagOptions,
  BuildProfile,
  Capabilities,
  CaptureErrorCode,
  CaptureNativeModule,
  CaptureSession,
  CaptureWarning,
  ExportProgress,
  ExportResult,
  MarkAnchorOptions,
  MarkWindow,
  Mat4,
  NativeAddTagResult,
  NativeMarkAnchorResult,
  NativeRecordingEvent,
  NativeSessionStatus,
  NativeSessionWarning,
  NativeStoppedEvent,
  NativeStopResult,
  RecorderCapabilities,
  RecorderPermissions,
  RecordingEnded,
  RecordingOutcome,
  RecordingSummary,
  RecordRefusal,
  RecoveryReport,
  SelfTestReport,
  StartOptions,
  Vec3,
} from "../../modules/capture-native/src/types.ts";
import { BoundaryTrace, type BoundaryTraceFigures } from "./boundary-trace.ts";
import { type Redacted, redact, type SessionTime } from "./redacted.ts";

/** Capabilities with the recorder's part in its current shape, whatever the build sent. */
export type CaptureCapabilities = Omit<Capabilities, "recorder"> & {
  readonly recorder: RecorderCapabilities;
};

export interface MarkAnchorResult {
  readonly t: SessionTime;
  readonly frame: number;
  readonly anchorId: string;
  readonly hit: Redacted<{ readonly point: Vec3; readonly normal: Vec3; readonly transform: Mat4 }>;
  readonly facing: Redacted<Vec3> | null;
  readonly camera: Redacted<Mat4>;
  readonly window: MarkWindow;
}

export interface AddTagResult {
  readonly t: SessionTime;
  readonly frame: number;
  readonly position: Redacted<Vec3>;
  readonly camera: Redacted<Mat4>;
}

export interface StopResult {
  readonly t: SessionTime;
  readonly recording: RecordingOutcome | null;
}

export type SessionStatus = Omit<NativeSessionStatus, "t"> & { readonly t: SessionTime };

export type SessionWarning = CaptureWarning & { readonly t: SessionTime };

export type RecordingEvent =
  | { readonly t: SessionTime; readonly state: "armed" | "closing" | "finalizing" | "discarded" }
  | { readonly t: SessionTime; readonly state: "open"; readonly startT: SessionTime }
  | {
      readonly t: SessionTime;
      readonly state: "closed";
      readonly ended: RecordingEnded;
      readonly trimmed: boolean;
      readonly closed: boolean;
    }
  | { readonly t: SessionTime; readonly state: "failed"; readonly code: CaptureErrorCode };

export interface StoppedEvent {
  readonly t: SessionTime;
}

export interface SessionEvents {
  readonly status: SessionStatus;
  readonly warning: SessionWarning;
  readonly recording: RecordingEvent;
  readonly stopped: StoppedEvent;
}

export type SessionEventName = keyof SessionEvents;

/** One capture's session. Keep it (and so `native`) in a ref for the whole capture. */
export interface CaptureSessionPort {
  /** For `<CaptureView session={…}>`. Call nothing on it directly: that would bypass the trace. */
  readonly native: CaptureSession;
  start(options: StartOptions): Promise<{ readonly recordingId: string | null }>;
  markAnchor(options: MarkAnchorOptions): Promise<MarkAnchorResult>;
  addTag(options: AddTagOptions): Promise<AddTagResult>;
  /** Sends the trace with `final` first, then stops; resolves once the recording is closed. */
  stop(): Promise<StopResult>;
  discard(): Promise<void>;
  /** Returns the unsubscribe function. */
  on<E extends SessionEventName>(event: E, listener: (event: SessionEvents[E]) => void): () => void;
  /** Sends the pending trace lines now (the screen calls it when the app's state changes). */
  flushTrace(): void;
  traceFigures(): BoundaryTraceFigures;
  /** Ends the trace, drops the listeners and releases the native object. */
  release(): void;
}

export interface CaptureNative {
  capabilities(): CaptureCapabilities;
  /** A new session, or null in a build without the CaptureSession class. */
  openSession(): CaptureSessionPort | null;
  listRecordings(): Promise<readonly RecordingSummary[]>;
  exportRecording(id: string): Promise<ExportResult>;
  deleteRecording(id: string): Promise<void>;
  /** Null in a build without the recorder. */
  recoveryStatus(): Promise<RecoveryReport | null>;
  selfTest(keep: boolean): Promise<SelfTestReport>;
  /** Location and motion, in the walk build only. */
  requestPermissions(): Promise<RecorderPermissions>;
  /** The module's log ring: value-free codes. */
  logTail(): readonly string[];
  onExportProgress(listener: (event: ExportProgress) => void): () => void;
}

export interface CaptureNativeDeps {
  /** Subscribes to the app's state changes (React Native's AppState); the trace sends on each. */
  readonly onAppStateChange?: (listener: () => void) => () => void;
}

/** A rejection the port makes itself. Its message is the code, never a value. */
export class CaptureNativeError extends Error {
  readonly code: CaptureErrorCode;

  constructor(code: CaptureErrorCode) {
    super(code);
    this.name = "CaptureNativeError";
    this.code = code;
  }
}

const ERROR_CODES: ReadonlySet<string> = new Set<CaptureErrorCode>([
  "ERR_RECORDER_NOT_COMPILED",
  "ERR_RECORD_REFUSED",
  "ERR_PROFILE_UNAVAILABLE",
  "ERR_INVALID_VENUES",
  "ERR_NO_SPACE",
  "ERR_RECOVERY_PENDING",
  "ERR_NO_VIEW",
  "ERR_NOT_RUNNING",
  "ERR_TRACKING",
  "ERR_NO_FLOOR_HIT",
  "ERR_EXPORT_REFUSED",
  "ERR_EXPORT_TOO_LARGE",
  "ERR_RECORDING_CORRUPT",
  "ERR_RECORDING_BUSY",
  "ERR_IO",
]);

/** The module's error code from a rejection, or null for anything else. */
export function captureErrorCode(error: unknown): CaptureErrorCode | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && ERROR_CODES.has(code) ? (code as CaptureErrorCode) : null;
}

const REFUSALS: ReadonlySet<string> = new Set<RecordRefusal>([
  "notCompiled",
  "notWalkBuild",
  "debugBuild",
  "notEmbedded",
  "devClient",
  "profileUnavailable",
  "invalidVenues",
  "lowDisk",
]);

/**
 * The refusal code of an `ERR_RECORD_REFUSED` rejection (its reason; Expo may put it after its
 * own "Calling the … function has failed" text), or null for anything else.
 */
export function recordRefusalOf(error: unknown): RecordRefusal | null {
  if (captureErrorCode(error) !== "ERR_RECORD_REFUSED") return null;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return null;
  const word = message.split(/[^A-Za-z]+/).find((part) => REFUSALS.has(part));
  return word === undefined ? null : (word as RecordRefusal);
}

/** The recorder's capabilities from either shape `getCapabilities()` has had. */
export function recorderCapabilities(capabilities: Capabilities): RecorderCapabilities {
  const recorder = capabilities.recorder;
  if (typeof recorder !== "boolean") return recorder;
  return {
    compiled: recorder,
    canRecord: false,
    refusal: recorder ? "notWalkBuild" : "notCompiled",
    buildProfile: null,
  };
}

/** The build profile the module reports, or null (no module, no recorder, or it failed). */
export function buildProfileOf(module: CaptureNativeModule | null): BuildProfile | null {
  if (!module) return null;
  try {
    return recorderCapabilities(module.getCapabilities()).buildProfile;
  } catch {
    return null;
  }
}

function notCompiled<T>(): Promise<T> {
  return Promise.reject(new CaptureNativeError("ERR_RECORDER_NOT_COMPILED"));
}

export function moduleCaptureNative(
  module: CaptureNativeModule | null,
  deps: CaptureNativeDeps = {},
): CaptureNative | null {
  if (!module) return null;
  return {
    capabilities() {
      const capabilities = module.getCapabilities();
      return { ...capabilities, recorder: recorderCapabilities(capabilities) };
    },
    openSession() {
      const Session = module.CaptureSession;
      return Session ? adaptSession(new Session(), deps) : null;
    },
    listRecordings: () => module.listRecordings?.() ?? Promise.resolve([]),
    exportRecording: (id) => module.exportRecording?.(id) ?? notCompiled(),
    deleteRecording: (id) => module.deleteRecording?.(id) ?? notCompiled(),
    recoveryStatus: () => module.recoveryStatus?.() ?? Promise.resolve(null),
    selfTest: (keep) => module.recorderSelfTest?.(keep) ?? notCompiled(),
    requestPermissions: () => module.requestRecorderPermissions?.() ?? notCompiled(),
    logTail: () => module.getLogTail?.() ?? [],
    onExportProgress(listener) {
      const subscription = module.addListener?.("exportProgress", listener);
      return () => subscription?.remove();
    },
  };
}

type Listeners = { [E in SessionEventName]: Set<(event: SessionEvents[E]) => void> };

function adaptSession(native: CaptureSession, deps: CaptureNativeDeps): CaptureSessionPort {
  // appendBoundary is plumbing: its lines are the trace, so it is never traced itself.
  const trace = new BoundaryTrace({ send: (lines, final) => native.appendBoundary(lines, final) });
  const listeners: Listeners = {
    status: new Set(),
    warning: new Set(),
    recording: new Set(),
    stopped: new Set(),
  };
  const emit = <E extends SessionEventName>(event: E, payload: SessionEvents[E]): void => {
    for (const listener of listeners[event]) listener(payload);
  };

  const subscriptions = [
    native.addListener("status", (raw: NativeSessionStatus) => {
      trace.record("status", raw.t, raw);
      trace.tick(raw.t);
      emit("status", wrapStatus(raw));
    }),
    native.addListener("warning", (raw: NativeSessionWarning) => {
      trace.record("warning", raw.t, raw);
      emit("warning", wrapWarning(raw));
    }),
    native.addListener("recording", (raw: NativeRecordingEvent) => {
      trace.record("recording", raw.t, raw);
      if (raw.state === "open") trace.windowOpened(raw.startT);
      else if (raw.state === "finalizing") trace.flush(true);
      else if (raw.state === "closed" || raw.state === "discarded" || raw.state === "failed") {
        trace.end();
      }
      emit("recording", wrapRecording(raw));
    }),
    native.addListener("stopped", (raw: NativeStoppedEvent) => {
      trace.record("stopped", raw.t, raw);
      trace.end();
      emit("stopped", { t: redact(raw.t) });
    }),
  ];
  const appState = deps.onAppStateChange?.(() => trace.flush(false));

  return {
    native,
    async start(options) {
      const result = await native.start(options);
      return { recordingId: result.recordingId };
    },
    async markAnchor(options) {
      const raw: NativeMarkAnchorResult = await native.markAnchor(options);
      trace.record("markAnchor", raw.t, raw);
      return wrapMark(raw);
    },
    async addTag(options) {
      const raw: NativeAddTagResult = await native.addTag(options);
      trace.record("addTag", raw.t, raw);
      return wrapTag(raw);
    },
    async stop() {
      trace.flush(true);
      const raw: NativeStopResult = await native.stop();
      trace.record("stop", raw.t, raw);
      return { t: redact(raw.t), recording: raw.recording };
    },
    async discard() {
      trace.flush(true);
      await native.discard();
      trace.end();
    },
    on(event, listener) {
      listeners[event].add(listener);
      return () => {
        listeners[event].delete(listener);
      };
    },
    flushTrace: () => trace.flush(false),
    traceFigures: () => trace.figures,
    release() {
      for (const subscription of subscriptions) subscription.remove();
      appState?.();
      for (const set of Object.values(listeners)) set.clear();
      trace.end();
      native.release();
    },
  };
}

function wrapStatus(raw: NativeSessionStatus): SessionStatus {
  return {
    t: redact(raw.t),
    running: raw.running,
    covered: raw.covered,
    tracking: raw.tracking,
    ...(raw.trackingReason === undefined ? {} : { trackingReason: raw.trackingReason }),
    mapping: raw.mapping,
    fps: raw.fps,
    candidateHz: raw.candidateHz,
    meshAnchors: raw.meshAnchors,
    thermal: raw.thermal,
    recorder: {
      state: raw.recorder.state,
      degradation: raw.recorder.degradation,
      closingInS: raw.recorder.closingInS,
    },
    ...(raw.debug === undefined ? {} : { debug: raw.debug }),
  };
}

function wrapWarning(raw: NativeSessionWarning): SessionWarning {
  const t = redact(raw.t);
  switch (raw.kind) {
    case "sessionFailed":
      return { t, kind: raw.kind, code: raw.code };
    case "screenshot":
    case "interrupted":
    case "interruptionEnded":
      return { t, kind: raw.kind };
  }
}

function wrapRecording(raw: NativeRecordingEvent): RecordingEvent {
  const t = redact(raw.t);
  switch (raw.state) {
    case "open":
      return { t, state: raw.state, startT: redact(raw.startT) };
    case "closed":
      return { t, state: raw.state, ended: raw.ended, trimmed: raw.trimmed, closed: raw.closed };
    case "failed":
      return { t, state: raw.state, code: raw.code };
    case "armed":
    case "closing":
    case "finalizing":
    case "discarded":
      return { t, state: raw.state };
  }
}

function wrapMark(raw: NativeMarkAnchorResult): MarkAnchorResult {
  return {
    t: redact(raw.t),
    frame: raw.frame,
    anchorId: raw.anchorId,
    hit: redact(raw.hit),
    facing: raw.facing === null ? null : redact(raw.facing),
    camera: redact(raw.camera),
    window: raw.window,
  };
}

function wrapTag(raw: NativeAddTagResult): AddTagResult {
  return {
    t: redact(raw.t),
    frame: raw.frame,
    position: redact(raw.position),
    camera: redact(raw.camera),
  };
}
