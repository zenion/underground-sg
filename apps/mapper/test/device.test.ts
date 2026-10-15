import { describe, expect, test } from "vitest";
import { jsEngine } from "../src/about/runtime.ts";
import { iosDriftWarning, lidarExpectation } from "../src/capture/device.ts";

describe("lidarExpectation", () => {
  test("expects LiDAR on iPhone Pro models from the 12 on", () => {
    for (const name of [
      "iPhone 17 Pro Max",
      "iPhone 17 Pro",
      "iPhone 12 Pro",
      "iPhone 15 Pro Max",
    ]) {
      expect(lidarExpectation(name), name).toBe("expected");
    }
  });

  test("doesn't on other iPhones", () => {
    for (const name of [
      "iPhone 11 Pro Max",
      "iPhone 17",
      "iPhone 16e",
      "iPhone Air",
      "iPhone SE (3rd generation)",
    ]) {
      expect(lidarExpectation(name), name).toBe("not expected");
    }
  });

  test("doesn't guess for iPad Pro, unknown names or none", () => {
    for (const name of ["iPad Pro (11-inch) (4th generation)", "iPhone18,2", "", null, undefined]) {
      expect(lidarExpectation(name), String(name)).toBe("unknown");
    }
  });
});

describe("iosDriftWarning", () => {
  test("warns for iOS 26.4 to 26.6.0", () => {
    for (const version of ["26.4", "26.4.1", "26.5", "26.6", "26.6.0"]) {
      expect(iosDriftWarning("iOS", version), version).toContain("LiDAR drift");
    }
  });

  test("is quiet for other versions and systems", () => {
    for (const version of ["26.3.1", "26.6.1", "26.7", "27.0", "18.6"]) {
      expect(iosDriftWarning("iOS", version), version).toBeNull();
    }
    expect(iosDriftWarning("Android", "26.5")).toBeNull();
    expect(iosDriftWarning(null, null)).toBeNull();
  });
});

describe("jsEngine", () => {
  test("finds Hermes and its version", () => {
    const hermes = {
      HermesInternal: { getRuntimeProperties: () => ({ "OSS Release Version": "0.86.3" }) },
    };
    expect(jsEngine(hermes)).toEqual({ name: "Hermes", version: "0.86.3" });
    expect(jsEngine({ HermesInternal: {} })).toEqual({ name: "Hermes", version: null });
  });

  test("reports anything else as not Hermes", () => {
    expect(jsEngine({})).toEqual({ name: "not Hermes", version: null });
    expect(jsEngine({ HermesInternal: null })).toEqual({ name: "not Hermes", version: null });
    // Vitest runs in Node: V8.
    expect(jsEngine().name).toBe("not Hermes");
  });
});
