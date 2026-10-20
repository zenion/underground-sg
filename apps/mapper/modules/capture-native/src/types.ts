// What the capture-native module hands JavaScript (ADR 0007, "The native boundary"): its
// capabilities, status events at about 5 Hz and warnings. Counts, rates and states only: nothing
// per frame, and never a pose, a transform or a time.

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
  /** Whether the session recorder is compiled into this build (ADR 0010). */
  readonly recorder: boolean;
}

export type Tracking = "normal" | "limited" | "notAvailable";
export type TrackingReason =
  | "initializing"
  | "excessiveMotion"
  | "insufficientFeatures"
  | "relocalizing"
  | "unknown";
export type WorldMapping = "notAvailable" | "limited" | "extending" | "mapped" | "unknown";

/** `onStatus`, about 5 times a second while the session runs, and once when it stops. */
export interface CaptureStatus {
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
  readonly frames: number;
  readonly candidates: number;
  readonly meshAnchors: number;
  readonly thermal: ThermalState;
}

export type CaptureWarning =
  /** A screenshot was taken while the camera ran: the owner deletes it (ADR 0010). */
  | { readonly kind: "screenshot" }
  /** The ARSession failed, with ARKit's error code; the session has stopped. */
  | { readonly kind: "sessionFailed"; readonly code: number }
  | { readonly kind: "interrupted" }
  | { readonly kind: "interruptionEnded" };

/** The view's functions, called through its ref. */
export interface CaptureViewHandle {
  /** Starts the ARSession. Rejects when ARKit can't track, or there is no way to keep the camera out of screenshots. */
  start(): Promise<void>;
  stop(): Promise<void>;
}
