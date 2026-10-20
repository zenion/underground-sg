// The capture-active store (src/capture/active.ts): the layout's tabPress listener reads it
// synchronously, so it must reflect the latest setCaptureActive at once.

import { afterEach, describe, expect, test } from "vitest";
import { isCaptureActive, setCaptureActive } from "../src/capture/active.ts";

afterEach(() => setCaptureActive(false));

describe("isCaptureActive", () => {
  test("starts off and follows setCaptureActive at once", () => {
    expect(isCaptureActive()).toBe(false);
    setCaptureActive(true);
    expect(isCaptureActive()).toBe(true);
    setCaptureActive(false);
    expect(isCaptureActive()).toBe(false);
  });
});
