import { describe, expect, test } from "vitest";
import type { NativeSessionStatus } from "../modules/capture-native/src/types.ts";
import {
  bestVideoFormat,
  captureReady,
  describeCaptureError,
  describeRate,
  describeTracking,
  describeVideoFormat,
  describeWarning,
  thermalTone,
} from "../src/capture/status.ts";

// A session's raw status, as the module emits it: describeTracking takes any status with the
// tracking fields, the port's redacted one included.
const status = (overrides: Partial<NativeSessionStatus> = {}): NativeSessionStatus => ({
  t: 20,
  running: true,
  covered: false,
  tracking: "normal",
  mapping: "extending",
  fps: 59.8,
  candidateHz: 4.9,
  frames: 1200,
  candidates: 90,
  meshAnchors: 12,
  thermal: "nominal",
  recorder: { state: "off", degradation: null, closingInS: null },
  ...overrides,
});

describe("capabilities", () => {
  test("the best video format has the most pixels, then the higher frame rate", () => {
    expect(
      bestVideoFormat([
        { width: 1920, height: 1440, fps: 60 },
        { width: 3840, height: 2880, fps: 30 },
        { width: 1920, height: 1080, fps: 60 },
        { width: 3840, height: 2880, fps: 60 },
      ]),
    ).toEqual({ width: 3840, height: 2880, fps: 60 });
    expect(bestVideoFormat([])).toBeNull();
    expect(describeVideoFormat({ width: 1920, height: 1440, fps: 60 })).toBe(
      "1920 × 1440 at 60 fps",
    );
    expect(describeVideoFormat(null)).toBe("None");
  });

  test("capture needs world tracking and LiDAR scene reconstruction", () => {
    const base = {
      worldTracking: true,
      sceneReconstruction: true,
      sceneDepth: true,
      smoothedSceneDepth: true,
      videoFormats: [],
      deviceModel: "iPhone18,2",
      osVersion: "26.7.0",
      thermal: "nominal",
      recorder: false,
    } as const;
    expect(captureReady(base)).toBe(true);
    expect(captureReady({ ...base, sceneReconstruction: false })).toBe(false);
    expect(captureReady({ ...base, worldTracking: false })).toBe(false);
  });
});

describe("status", () => {
  test("tracking", () => {
    expect(describeTracking(status())).toEqual({ text: "Normal", tone: "good" });
    expect(
      describeTracking(status({ tracking: "limited", trackingReason: "excessiveMotion" })),
    ).toEqual({ text: "Limited (moving too fast)", tone: "warn" });
    expect(describeTracking(status({ tracking: "limited" })).text).toBe("Limited (unknown reason)");
    expect(describeTracking(status({ tracking: "notAvailable" })).tone).toBe("bad");
    expect(describeTracking(status({ running: false }))).toEqual({
      text: "Stopped",
      tone: "muted",
    });
  });

  test("rates and heat", () => {
    expect(describeRate(59.84)).toBe("60/s");
    expect(describeRate(4.92)).toBe("4.9/s");
    expect(describeRate(0)).toBe("0.0/s");
    expect(thermalTone("nominal")).toBe("good");
    expect(thermalTone("serious")).toBe("warn");
    expect(thermalTone("critical")).toBe("bad");
  });

  test("warnings", () => {
    expect(describeWarning({ kind: "screenshot" })).toMatch(/Delete it in Photos/);
    expect(describeWarning({ kind: "sessionFailed", code: 102 })).toMatch(/ARKit error 102/);
    expect(describeWarning({ kind: "interrupted" })).toMatch(/interrupted/);
    expect(describeWarning({ kind: "interruptionEnded" })).toBeNull();
  });

  test("refusals are worded from the code alone", () => {
    expect(describeCaptureError("ERR_NO_VIEW")).toMatch(/out of screenshots/);
    expect(describeCaptureError("ERR_TRACKING")).toMatch(/world tracking/);
    expect(describeCaptureError("ERR_NOT_RUNNING")).toMatch(/isn't running/);
    expect(describeCaptureError("ERR_RECORD_REFUSED")).toBe(
      "The capture module refused (ERR_RECORD_REFUSED).",
    );
    expect(describeCaptureError(null)).toBe("The call failed.");
  });
});
