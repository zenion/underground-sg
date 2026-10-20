// How the Capture screen words what the capture module reports: its capabilities, the session's
// 5 Hz status and the warnings. Pure, so Vitest covers it in Node.

import type {
  Capabilities,
  CaptureErrorCode,
  CaptureWarning,
  ThermalState,
  Tracking,
  TrackingReason,
  VideoFormat,
} from "../../modules/capture-native/src/types.ts";
import type { Tone } from "../ui.tsx";

/** The part of a session's status that says how tracking is going. */
export interface TrackingStatus {
  readonly running: boolean;
  readonly tracking: Tracking;
  readonly trackingReason?: TrackingReason;
}

/** The largest format ARKit offers (most pixels, then the higher frame rate), or null. */
export function bestVideoFormat(formats: readonly VideoFormat[]): VideoFormat | null {
  let best: VideoFormat | null = null;
  for (const format of formats) {
    const pixels = format.width * format.height;
    const bestPixels = best ? best.width * best.height : -1;
    if (!best || pixels > bestPixels || (pixels === bestPixels && format.fps > best.fps)) {
      best = format;
    }
  }
  return best;
}

export function describeVideoFormat(format: VideoFormat | null): string {
  return format ? `${format.width} × ${format.height} at ${format.fps} fps` : "None";
}

/** Whether this phone can capture: world tracking and LiDAR scene reconstruction. */
export function captureReady(capabilities: Capabilities): boolean {
  return capabilities.worldTracking && capabilities.sceneReconstruction;
}

const reasonText = {
  initializing: "starting up",
  excessiveMotion: "moving too fast",
  insufficientFeatures: "too little detail",
  relocalizing: "relocalizing",
  unknown: "unknown reason",
} as const;

export function describeTracking(status: TrackingStatus): { text: string; tone: Tone } {
  if (!status.running) return { text: "Stopped", tone: "muted" };
  switch (status.tracking) {
    case "normal":
      return { text: "Normal", tone: "good" };
    case "limited":
      return {
        text: `Limited (${reasonText[status.trackingReason ?? "unknown"]})`,
        tone: "warn",
      };
    case "notAvailable":
      return { text: "Not available", tone: "bad" };
  }
}

export function thermalTone(thermal: ThermalState): Tone {
  switch (thermal) {
    case "nominal":
      return "good";
    case "fair":
      return "normal";
    case "serious":
      return "warn";
    case "critical":
      return "bad";
    case "unknown":
      return "muted";
  }
}

export function describeRate(perSecond: number): string {
  return `${perSecond.toFixed(perSecond < 10 ? 1 : 0)}/s`;
}

/** What the screen says about a warning, or null for one it only needs to note in the status. */
export function describeWarning(warning: CaptureWarning): string | null {
  switch (warning.kind) {
    case "screenshot":
      return "A screenshot was taken while the camera was running. Delete it in Photos now, then again from Recently Deleted. Screenshots of the capture view are never shared, with Claude Code or anyone.";
    case "sessionFailed":
      return `The AR session failed (ARKit error ${warning.code}) and has stopped.`;
    case "interrupted":
      return "The AR session was interrupted; it resumes when the camera is back.";
    case "interruptionEnded":
      return null;
  }
}

/** What the camera check says when a call is refused, from the module's code (never a value). */
export function describeCaptureError(code: CaptureErrorCode | null): string {
  switch (code) {
    case "ERR_NO_VIEW":
      return "This iOS offers no way to keep the camera out of screenshots, so the camera stays off.";
    case "ERR_TRACKING":
      return "ARKit world tracking isn't available on this device.";
    case "ERR_NOT_RUNNING":
      return "The camera isn't running.";
    case null:
      return "The call failed.";
    default:
      return `The capture module refused (${code}).`;
  }
}
