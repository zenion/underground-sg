// What the capture-native module hands JavaScript (ADR 0007, "The native boundary"): its
// capabilities, the CaptureSession shared object with its events, the view that renders a session,
// and the recorder's plumbing (the lean recorder design,
// docs/reviews/2026-10-21-lean-recorder-design.md, 3.3 and 3.4). These types follow
// ios/CaptureNativeModule.swift and ios/CaptureSession.swift. Nothing per frame. The session's
// status carries counts, rates and states; its events and results carry session times and, for
// marks and tags, poses: these are the raw shapes, which only src/capture/native.ts sees; it
// traces them, then wraps every pose and time in Redacted.

import type { RecordingEnded } from "@usg/contracts";
import type { SharedObject } from "expo";

export type { RecordingEnded };

export type ThermalState = "nominal" | "fair" | "serious" | "critical" | "unknown";

export interface VideoFormat {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
}

/** ARKit's own checks on this phone, from `getCapabilities()`. */
export interface Capabilities {
  readonly worldTracking: boolean;
  /** LiDAR: scene reconstruction with per-face classification. */
  readonly sceneReconstruction: boolean;
  readonly sceneDepth: boolean;
  readonly smoothedSceneDepth: boolean;
  readonly videoFormats: readonly VideoFormat[];
  /** The hardware identifier, for example iPhone18,2. */
  readonly deviceModel: string;
  readonly osVersion: string;
  readonly thermal: ThermalState;
  /**
   * The session recorder (ADR 0010). A boolean (whether it is compiled in) from builds before the
   * CaptureSession glue, which can still load this JavaScript through Metro; src/capture/native.ts
   * reads both shapes.
   */
  readonly recorder: boolean | RecorderCapabilities;
}

export type Tracking = "normal" | "limited" | "notAvailable";
export type TrackingReason =
  | "initializing"
  | "excessiveMotion"
  | "insufficientFeatures"
  | "relocalizing"
  | "unknown";
export type WorldMapping = "notAvailable" | "limited" | "extending" | "mapped" | "unknown";

/** A session warning's kinds; the session's `warning` event adds its time. */
export type CaptureWarning =
  /** A screenshot was taken while the camera ran: the owner deletes it (ADR 0010). */
  | { readonly kind: "screenshot" }
  /** The ARSession failed, with ARKit's error code; the session has stopped. */
  | { readonly kind: "sessionFailed"; readonly code: number }
  | { readonly kind: "interrupted" }
  | { readonly kind: "interruptionEnded" };

// The session recorder and the CaptureSession object (lean recorder design, 3.3). None of this
// exists in builds before the native glue (B1), which can still load this JavaScript through
// Metro: the module then has no CaptureSession class and no recorder functions, which is why
// CaptureNativeModule marks them optional.

/** `start({ record })`: the recording profile. Only the walk build accepts anything but `off`. */
export type RecordProfile = "off" | "lean" | "standard" | "dense";

export type BuildProfile = "development" | "walk";

/** Why the module won't record in this build or right now (`ERR_RECORD_REFUSED`'s reason). */
export type RecordRefusal =
  | "notCompiled"
  | "notWalkBuild"
  | "debugBuild"
  | "notEmbedded"
  | "devClient"
  | "profileUnavailable"
  | "invalidVenues"
  | "lowDisk";

export interface RecorderCapabilities {
  /** Whether the recorder is compiled into this build (`USG_RECORDER`). */
  readonly compiled: boolean;
  /** Whether `start({ record: "lean" })` would be granted now. */
  readonly canRecord: boolean;
  readonly refusal: RecordRefusal | null;
  /** Info.plist `USGBuildProfile`, or null in a build without the recorder. */
  readonly buildProfile: BuildProfile | null;
}

/** The error codes the module rejects with. The message is constant; no value is ever in it. */
export type CaptureErrorCode =
  | "ERR_RECORDER_NOT_COMPILED"
  | "ERR_RECORD_REFUSED"
  | "ERR_PROFILE_UNAVAILABLE"
  | "ERR_INVALID_VENUES"
  | "ERR_NO_SPACE"
  | "ERR_RECOVERY_PENDING"
  | "ERR_NO_VIEW"
  | "ERR_NOT_RUNNING"
  | "ERR_TRACKING"
  | "ERR_NO_FLOOR_HIT"
  | "ERR_EXPORT_REFUSED"
  | "ERR_EXPORT_TOO_LARGE"
  | "ERR_RECORDING_CORRUPT"
  | "ERR_RECORDING_BUSY"
  | "ERR_IO";

/** [x, y, z] in metres in the session's ARKit world. */
export type Vec3 = readonly [number, number, number];

/** A 4×4 transform: 16 numbers, column-major, as ARKit's simd_float4x4. */
export type Mat4 = readonly number[];

export interface StartOptions {
  readonly record: RecordProfile;
  /** The venues the session covers: 1 to 50 lowercase UUIDs, the seed's ids. */
  readonly venues: readonly string[];
}

export interface MarkAnchorOptions {
  readonly role: "start" | "end";
  readonly kind: "floor_point";
  /** Opens a GNSS window at this anchor (ADR 0010). */
  readonly streetFacing: boolean;
  /** "Mark end and end the session here": the recording closes a margin later, then the session stops. */
  readonly endSessionHere: boolean;
  readonly name: string | null;
}

export interface AddTagOptions {
  readonly type: "node" | "poi";
  readonly kind: string;
  readonly name: string | null;
}

/** What the recording window was when the mark was handled. */
export type MarkWindow = "opened" | "open" | "closing" | "not_open";

/** The raw `start` result. */
export interface NativeStartResult {
  /** Null with `record: off`, and until the window opens at the first start mark. */
  readonly recordingId: string | null;
}

/** The raw `markAnchor` result, resolved on the frame after the call. Pose-bearing. */
export interface NativeMarkAnchorResult {
  readonly t: number;
  readonly frame: number;
  readonly anchorId: string;
  readonly hit: { readonly point: Vec3; readonly normal: Vec3; readonly transform: Mat4 };
  /** The camera's horizontal facing, or null when it looks straight up or down. */
  readonly facing: Vec3 | null;
  readonly camera: Mat4;
  readonly window: MarkWindow;
}

/** The raw `addTag` result. Pose-bearing. */
export interface NativeAddTagResult {
  readonly t: number;
  readonly frame: number;
  readonly position: Vec3;
  readonly camera: Mat4;
}

export interface RecordingOutcome {
  readonly id: string;
  readonly ended: RecordingEnded;
  readonly trimmed: boolean;
  /** False only for a recording recovery cut back. */
  readonly closed: boolean;
}

/** The raw `stop` result. */
export interface NativeStopResult {
  readonly t: number;
  /** Null when no recording opened (record off, or stopped before the start mark). */
  readonly recording: RecordingOutcome | null;
}

export type RecorderState =
  | "off"
  | "armed"
  | "open"
  | "closing"
  | "finalizing"
  | "closed"
  | "discarded"
  | "failed";

export type DegradationStep = "fewer_candidates" | "no_mesh_history" | "no_recording";

/** Counts, durations and timings for the debug card (design section 13). Never a pose or a time. */
export type DebugFigures = Readonly<Record<string, number | string | boolean | null>>;

// Session events. Every one carries `t`, the session time the module stamped on it, because the
// boundary trace records each with its time.

/** `status`, at 5 Hz while the session runs, and once when it stops. */
export interface NativeSessionStatus {
  readonly t: number;
  readonly running: boolean;
  /** Whether the opaque cover is over the camera (scene inactive, or the screen captured). */
  readonly covered: boolean;
  readonly tracking: Tracking;
  readonly trackingReason?: TrackingReason;
  readonly mapping: WorldMapping;
  /** ARFrames a second over the last second. */
  readonly fps: number;
  /** Candidates a second over the last second (ADR 0010's candidate gate). */
  readonly candidateHz: number;
  /** ARFrames since the start. */
  readonly frames: number;
  /** Candidates since the start, forced ones included. */
  readonly candidates: number;
  readonly meshAnchors: number;
  readonly thermal: ThermalState;
  readonly recorder: {
    readonly state: RecorderState;
    readonly degradation: DegradationStep | null;
    /** Seconds until End the session here closes the recording, while closing. A duration. */
    readonly closingInS: number | null;
  };
  /** Every fifth status: the debug figures. */
  readonly debug?: DebugFigures;
}

/** `warning`: as the view's warnings, with the session time. */
export type NativeSessionWarning = CaptureWarning & { readonly t: number };

/** `recording`, on each change of the recorder's state. */
export type NativeRecordingEvent =
  | { readonly t: number; readonly state: "armed" | "closing" | "finalizing" | "discarded" }
  /** The window opened at the first start mark; `startT` is its start. */
  | { readonly t: number; readonly state: "open"; readonly startT: number }
  | {
      readonly t: number;
      readonly state: "closed";
      readonly ended: RecordingEnded;
      readonly trimmed: boolean;
      readonly closed: boolean;
    }
  | { readonly t: number; readonly state: "failed"; readonly code: CaptureErrorCode };

/** `stopped`: the ARSession stopped (Stop, End the session here, a failure). */
export interface NativeStoppedEvent {
  readonly t: number;
}

/** The events a CaptureSession emits (through `emit(event:payload:)`, design D20). */
export type CaptureSessionEvents = {
  status: (event: NativeSessionStatus) => void;
  warning: (event: NativeSessionWarning) => void;
  recording: (event: NativeRecordingEvent) => void;
  stopped: (event: NativeStoppedEvent) => void;
};

/**
 * The CaptureSession shared object (design 3.3): the ARSession of one capture, attached to a
 * `<CaptureView>` through its `session` prop. Keep it in a ref for the whole capture, so a
 * collected JS object can't drop its events.
 */
export declare class CaptureSession extends SharedObject<CaptureSessionEvents> {
  /** Starts the ARSession. Rejects with `ERR_NO_VIEW` until a view with a secure canvas has it. */
  start(options: StartOptions): Promise<NativeStartResult>;
  markAnchor(options: MarkAnchorOptions): Promise<NativeMarkAnchorResult>;
  addTag(options: AddTagOptions): Promise<NativeAddTagResult>;
  stop(): Promise<NativeStopResult>;
  /** Stops and deletes the recording, if any. */
  discard(): Promise<void>;
  /** The boundary trace's lines (session-recording.md, boundary.jsonl). Plumbing: never traced. */
  appendBoundary(lines: string[], final: boolean): Promise<void>;
}

export type RecordingListState = "open" | "needs_recovery" | "closed" | "recovered" | "exported";

/** One recording on the phone, from `listRecordings`: counts, sizes and ages, never dates. */
export interface RecordingSummary {
  readonly id: string;
  readonly origin: "device" | "synthetic";
  readonly profile: RecordProfile;
  readonly state: RecordingListState;
  readonly ended: RecordingEnded | null;
  readonly trimmed: boolean;
  readonly durationS: number | null;
  readonly bytes: number;
  readonly files: number;
  readonly ageDays: number;
  readonly venues: readonly string[];
  readonly exportParts: number | null;
}

export interface ExportResult {
  readonly parts: number;
  readonly tarBytes: number;
}

/** `exportProgress`, at most 5 Hz while an export runs. */
export interface ExportProgress {
  readonly id: string;
  readonly bytesDone: number;
  readonly bytesTotal: number;
}

/** What recovery did at launch: counts only. */
export interface RecoveryReport {
  /** False until it has run: it waits for protected data (an unlocked phone). */
  readonly done: boolean;
  /** Cut off and cut back: `interrupted`, `closed: false`. */
  readonly recovered: number;
  /** Closed by the recorder but not finished: completed with `closed: true`. */
  readonly finished: number;
  readonly discarded: number;
  /** Already final: only the protection upgrade, and the journal removed. */
  readonly swept: number;
  /** Exports left complete before their raw files went: verified, the raw files deleted. */
  readonly exportsCompleted: number;
  /** Exports that failed that check: removed, the raw files kept. */
  readonly exportsRemoved: number;
  /** Recordings whose repair failed on an I/O error; tried again at the next launch. */
  readonly failed: number;
}

/** A Data Protection class, read back from a file. */
export type FileProtection = "complete" | "completeUnlessOpen";

/** The on-device synthetic self-test (design D18): results and timings, never recorded data. */
export interface SelfTestReport {
  readonly passed: boolean;
  /** The synthetic recording closed and its recording.json was written. */
  readonly recordingFinished: boolean;
  /** frames.jsonl's class while written (completeUnlessOpen) and after the close (complete). */
  readonly protectionWhileWriting: FileProtection | null;
  readonly protectionAfterClose: FileProtection | null;
  readonly excludedFromBackup: boolean;
  readonly compressionMatches: boolean;
  readonly sha256Matches: boolean;
  readonly encodeMBps: number;
  readonly deflateMBps: number;
  readonly sha256MBps: number;
  /** The top-level names in Documents: `exports` or nothing. */
  readonly documentsNames: readonly string[];
  /** The kept synthetic recording's id (walk build, `keep`), else null. */
  readonly keptId: string | null;
}

export type LocationPermission =
  | "notDetermined"
  | "restricted"
  | "denied"
  | "whenInUse"
  | "always"
  | "unknown";

export type MotionPermission = "notDetermined" | "restricted" | "denied" | "authorized" | "unknown";

/** `requestRecorderPermissions()`, in the walk build only. */
export interface RecorderPermissions {
  readonly location: LocationPermission;
  /** Precise location, not the reduced accuracy the owner can choose instead. */
  readonly preciseLocation: boolean;
  readonly motion: MotionPermission;
}

/**
 * The module's functions and classes. Every member but `getCapabilities` is missing in builds
 * before the native glue; from the glue on, the recorder's functions exist in every build and
 * reject with ERR_RECORDER_NOT_COMPILED without the recorder.
 */
export interface CaptureNativeModule {
  getCapabilities(): Capabilities;
  getLogTail?(): string[];
  CaptureSession?: new () => CaptureSession;
  listRecordings?(): Promise<RecordingSummary[]>;
  exportRecording?(id: string): Promise<ExportResult>;
  deleteRecording?(id: string): Promise<void>;
  recoveryStatus?(): Promise<RecoveryReport>;
  recorderSelfTest?(keep: boolean): Promise<SelfTestReport>;
  requestRecorderPermissions?(): Promise<RecorderPermissions>;
  addListener?(
    event: "exportProgress",
    listener: (event: ExportProgress) => void,
  ): { remove(): void };
}
