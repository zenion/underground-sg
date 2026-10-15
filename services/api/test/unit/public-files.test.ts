import { CACHE_CONTROL } from "@usg/contracts";
import { describe, expect, test } from "vitest";
import { acceptsEncoding, publicFile } from "../../src/public-files.ts";
import { singaporeDateTime } from "../../src/time.ts";

const SHA = "3f8a2b6c4d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a";

describe("publicFile", () => {
  test.each([
    ["latest.json", "application/json", CACHE_CONTROL.latest],
    ["status.json", "application/json", CACHE_CONTROL.status],
    [`snapshots/${SHA}/indoor.json`, "application/geo+json", CACHE_CONTROL.version],
    [`snapshots/${SHA}/street.json`, "application/geo+json", CACHE_CONTROL.version],
  ])("serves %s as %s with %s", (path, contentType, cacheControl) => {
    expect(publicFile(path)).toMatchObject({ key: path, contentType, cacheControl });
  });

  test("version files are immutable; latest.json and status.json last a minute", () => {
    expect(publicFile(`snapshots/${SHA}/indoor.json`)?.cacheControl).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(publicFile("latest.json")?.cacheControl).toBe("public, max-age=60");
  });

  test.each([
    "",
    "/",
    "snapshots/",
    `snapshots/${SHA}/`,
    `snapshots/${SHA}`,
    `snapshots/${SHA}/routing.json`,
    `snapshots/${SHA.toUpperCase()}/indoor.json`,
    `snapshots/${SHA.slice(1)}/indoor.json`,
    `snapshots/${SHA}/indoor.json/`,
    `snapshots/${SHA}/indoor.jsonx`,
    `snapshots/${SHA}/../latest.json`,
    `snapshots/../latest.json`,
    "../latest.json",
    "./latest.json",
    "/latest.json",
    "latest.json?x=1",
    "LATEST.JSON",
    "latest%2Ejson",
    "snapshots%2F..%2Flatest.json",
    "snapshots\\x\\indoor.json",
    "exports/1.json",
    "anchor-photos/80000000-0000-0000-0000-000000000001.jpg",
  ])("refuses %j", (path) => {
    expect(publicFile(path)).toBeUndefined();
  });
});

describe("acceptsEncoding", () => {
  test.each([
    ["br", true],
    ["gzip, deflate, br, zstd", true],
    ["BR", true],
    ["br;q=0.5", true],
    ["*", true],
    ["gzip, *;q=0.1", true],
    [undefined, false],
    ["", false],
    ["gzip, deflate", false],
    ["br;q=0", false],
    ["br; q=0.0", false],
    ["*, br;q=0", false],
    ["*;q=0", false],
    ["identity", false],
  ])("Accept-Encoding %j accepts br: %s", (header, expected) => {
    expect(acceptsEncoding(header, "br")).toBe(expected);
  });
});

describe("singaporeDateTime", () => {
  test("writes Singapore time with its offset, to the second", () => {
    expect(singaporeDateTime(new Date("2026-11-02T06:05:11.987654Z"))).toBe(
      "2026-11-02T14:05:11+08:00",
    );
    expect(singaporeDateTime(new Date("2026-12-31T16:00:00Z"))).toBe("2027-01-01T00:00:00+08:00");
  });

  test("refuses an invalid date", () => {
    expect(() => singaporeDateTime(new Date(Number.NaN))).toThrow(RangeError);
  });
});
