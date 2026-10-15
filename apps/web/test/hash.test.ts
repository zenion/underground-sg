// The level band in the URL hash, next to MapLibre's camera (#map=zoom/lat/lon&level=-2).

import { describe, expect, test } from "vitest";
import { hashWithLevel, LEVEL_PARAM, levelFromHash, withHash } from "../src/map/hash.ts";

describe("levelFromHash", () => {
  test.each([
    ["#map=18.5/1.2925/103.852&level=-2", -2],
    ["#level=-1&map=18.5/1.2925/103.852", -1],
    ["#map=18.5%2F1.2925%2F103.852&level=-3", -3],
    ["#level=0", 0],
    ["level=-2", -2],
  ])("%s asks for band %d", (hash, band) => {
    expect(levelFromHash(hash)).toBe(band);
  });

  test.each([
    ["", "no hash"],
    ["#map=18.5/1.2925/103.852", "only the camera"],
    ["#level=", "an empty value"],
    ["#level=B2", "a level's name"],
    ["#level=-1.5", "not an integer"],
    ["#level=-99999", "far out of range"],
  ])("%s: no band (%s)", (hash) => {
    expect(levelFromHash(hash)).toBeUndefined();
  });
});

describe("hashWithLevel", () => {
  test("adds the band after MapLibre's camera, keeping its slashes", () => {
    expect(hashWithLevel("#map=18.5/1.2925/103.852", -2)).toBe("#map=18.5/1.2925/103.852&level=-2");
  });

  test("replaces the band, keeping other parameters where they were", () => {
    expect(hashWithLevel("#level=-1&map=17/1.29/103.85&x=y", -2)).toBe(
      "#level=-2&map=17/1.29/103.85&x=y",
    );
  });

  test("the street band leaves the parameter out", () => {
    expect(hashWithLevel("#map=17/1.29/103.85&level=-2", 0)).toBe("#map=17/1.29/103.85");
    expect(hashWithLevel("#level=-2", 0)).toBe("");
    expect(hashWithLevel("", 0)).toBe("");
  });

  test("reads back as the band it wrote", () => {
    for (const band of [-3, -2, -1, 0, 1]) {
      expect(levelFromHash(hashWithLevel("#map=17/1.29/103.85", band)) ?? 0).toBe(band);
    }
    expect(LEVEL_PARAM).toBe("level");
  });
});

describe("withHash", () => {
  test("replaces, adds or removes the hash", () => {
    expect(withHash("http://x:5173/#map=1/2/3", "#map=1/2/3&level=-2")).toBe(
      "http://x:5173/#map=1/2/3&level=-2",
    );
    expect(withHash("http://x:5173/", "#level=-2")).toBe("http://x:5173/#level=-2");
    expect(withHash("http://x:5173/?a=b#level=-2", "")).toBe("http://x:5173/?a=b");
  });
});
