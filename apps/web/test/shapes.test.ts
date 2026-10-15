import { describe, expect, test } from "vitest";
import { demoIndoor, demoPublicFiles, demoStatus, demoStreet } from "../fixtures/demo-snapshot.ts";
import {
  DataShapeError,
  parseIndoor,
  parseLatest,
  parseStatus,
  parseStreet,
  UnsupportedFormatError,
} from "../src/data/shapes.ts";

/** A deep copy to break. */
function copy<T>(value: T): T {
  return structuredClone(value);
}

const latestJson = JSON.parse(demoPublicFiles(new Date()).get("latest.json")?.body ?? "") as Record<
  string,
  unknown
>;

describe("valid files pass and come back unchanged", () => {
  test("the demo's four files", () => {
    expect(parseLatest(copy(latestJson))).toEqual(latestJson);
    expect(parseIndoor(copy(demoIndoor))).toEqual(demoIndoor);
    expect(parseStreet(copy(demoStreet))).toEqual(demoStreet);
    const status = demoStatus(new Date());
    expect(parseStatus(copy(status))).toEqual(status);
  });

  test("latest.json without demo, and a venue without a footprint", () => {
    const { demo: _, ...rest } = latestJson;
    expect(parseLatest(rest).demo).toBeUndefined();
    expect(
      demoIndoor.features.some((f) => f.properties.feature_type === "venue" && f.geometry === null),
    ).toBe(true);
  });
});

describe("latest.json", () => {
  test("a newer format is reported as such", () => {
    const error = (() => {
      try {
        parseLatest({ ...latestJson, schema_version: 2 });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(UnsupportedFormatError);
    expect(String(error)).toMatch(/latest\.json: schema_version 2 is newer than 1/);
  });

  test.each([
    ["not an object", [], /is not an object/],
    ["a missing version", { ...latestJson, version: undefined }, /version: is not an integer/],
    ["a bad hash", { ...latestJson, snapshot_sha256: "abc" }, /snapshot_sha256: is not a SHA-256/],
    [
      "an http attribution",
      { ...latestJson, attribution: [{ text: "x", url: "http://x" }] },
      /https/,
    ],
    ["demo that isn't a boolean", { ...latestJson, demo: "yes" }, /demo: is not a boolean/],
  ])("refuses %s", (_, value, message) => {
    expect(() => parseLatest(value)).toThrow(message);
  });

  test.each([
    "https://elsewhere.example/indoor.json",
    "../private/indoor.json",
    "snapshots/0000000000000000000000000000000000000000000000000000000000000000/indoor.json",
  ])("refuses a version file at %s", (path) => {
    const value = copy(latestJson) as { files: { indoor: { path: string } } };
    value.files.indoor.path = path;
    expect(() => parseLatest(value)).toThrow(/files\.indoor\.path: expected snapshots\//);
  });
});

describe("indoor.json", () => {
  const broken = (change: (features: Record<string, unknown>[]) => void) => {
    const value = copy(demoIndoor) as unknown as { features: Record<string, unknown>[] };
    change(value.features);
    return value;
  };
  const feature = (features: Record<string, unknown>[], type: string) => {
    const found = features.find(
      (f) => (f["properties"] as Record<string, unknown>)["feature_type"] === type,
    );
    if (found === undefined) throw new Error(type);
    return found as {
      properties: Record<string, unknown>;
      geometry: Record<string, unknown> | null;
    };
  };

  test.each([
    [
      "an unknown feature type",
      (fs: Record<string, unknown>[]) => {
        feature(fs, "poi").properties["feature_type"] = "shop";
      },
      /feature_type: is not one of/,
    ],
    [
      "a level without an ordinal",
      (fs: Record<string, unknown>[]) => {
        delete feature(fs, "level").properties["ordinal"];
      },
      /properties\.ordinal: is not an integer/,
    ],
    [
      "a fractional ordinal",
      (fs: Record<string, unknown>[]) => {
        feature(fs, "space").properties["ordinal"] = -1.5;
      },
      /ordinal: is not an integer/,
    ],
    [
      "an unknown space kind",
      (fs: Record<string, unknown>[]) => {
        feature(fs, "space").properties["kind"] = "car_park";
      },
      /kind: is not one of/,
    ],
    [
      "a node with a polygon",
      (fs: Record<string, unknown>[]) => {
        feature(fs, "node").geometry = feature(fs, "space").geometry;
      },
      /geometry\.type: is not "Point"/,
    ],
    [
      "an edge with one position",
      (fs: Record<string, unknown>[]) => {
        (feature(fs, "edge").geometry as { coordinates: unknown[] }).coordinates.splice(1);
      },
      /fewer than 2 positions/,
    ],
    [
      "a position off the globe",
      (fs: Record<string, unknown>[]) => {
        (feature(fs, "node").geometry as { coordinates: number[] }).coordinates = [103.85, 91];
      },
      /is not on the globe/,
    ],
    [
      "an id that differs from properties.id",
      (fs: Record<string, unknown>[]) => {
        feature(fs, "edge").properties["id"] = "something-else";
      },
      /differs from the feature's id/,
    ],
    [
      "a string for a boolean",
      (fs: Record<string, unknown>[]) => {
        feature(fs, "edge").properties["outdoor"] = "false";
      },
      /outdoor: is not a boolean/,
    ],
  ])("refuses %s", (_, change, message) => {
    expect(() => parseIndoor(broken(change))).toThrow(message);
  });

  test("errors name the file and the feature", () => {
    const value = broken((fs) => {
      feature(fs, "poi").properties["category"] = "bank";
    });
    expect(() => parseIndoor(value)).toThrow(DataShapeError);
    expect(() => parseIndoor(value)).toThrow(
      /^indoor\.json: features\[\d+\]\.properties\.category/,
    );
  });

  test("not a FeatureCollection, or a newer format", () => {
    expect(() => parseIndoor({ ...demoIndoor, type: "Feature" })).toThrow(/type: is not/);
    expect(() => parseIndoor({ ...demoIndoor, schema_version: 2 })).toThrow(UnsupportedFormatError);
  });
});

describe("street.json and status.json", () => {
  test("a street edge without its nodes, and a street node with a text id", () => {
    const street = copy(demoStreet) as unknown as { features: Record<string, unknown>[] };
    const edge = street.features.at(-1) as { properties: Record<string, unknown> };
    delete edge.properties["to_osm_node"];
    expect(() => parseStreet(street)).toThrow(/to_osm_node: is not an integer/);
    const nodes = copy(demoStreet) as unknown as { features: Record<string, unknown>[] };
    (nodes.features[0] as Record<string, unknown>)["id"] = "1001";
    expect(() => parseStreet(nodes)).toThrow(/features\[0\]\.id: is not an integer/);
  });

  test("a status entry for a space, or with a bad time", () => {
    const status = demoStatus(new Date());
    expect(() =>
      parseStatus({ ...status, entries: [{ ...status.entries[0], feature_type: "space" }] }),
    ).toThrow(/feature_type: is not one of node, edge/);
    expect(() =>
      parseStatus({ ...status, entries: [{ ...status.entries[0], valid_from: "yesterday" }] }),
    ).toThrow(/valid_from: is not a date-time/);
  });

  test("two entries for one feature: refused, as checkStatusOverlay refuses them", () => {
    const status = demoStatus(new Date());
    const [closure] = status.entries;
    if (closure === undefined) throw new Error("the demo status has no entries");
    const reopening = { ...closure, is_open: true, note: null };
    expect(() => parseStatus({ ...status, entries: [...status.entries, reopening] })).toThrow(
      new RegExp(`a second entry for edge ${closure.feature_id}`),
    );
  });

  test("an entry whose window doesn't cover generated_at: refused", () => {
    const status = demoStatus(new Date("2026-10-15T10:00:00+08:00"));
    const [closure] = status.entries;
    if (closure === undefined) throw new Error("the demo status has no entries");
    // From 09:00 (an hour before generated_at) to 09:30: over by the time the file was made.
    const ended = { ...closure, valid_until: "2026-10-15T09:30:00+08:00" };
    expect(() => parseStatus({ ...status, entries: [ended] })).toThrow(
      /does not cover generated_at/,
    );
  });
});

describe("schema_version", () => {
  const files = {
    "latest.json": (version: unknown) => parseLatest({ ...latestJson, schema_version: version }),
    "indoor.json": (version: unknown) => parseIndoor({ ...demoIndoor, schema_version: version }),
    "street.json": (version: unknown) => parseStreet({ ...demoStreet, schema_version: version }),
    "status.json": (version: unknown) =>
      parseStatus({ ...demoStatus(new Date()), schema_version: version }),
  };

  test.each(Object.keys(files))("%s: a higher integer is a newer format", (file) => {
    const parse = files[file as keyof typeof files];
    expect(() => parse(2)).toThrow(UnsupportedFormatError);
    expect(() => parse(2)).toThrow(`${file}: schema_version 2 is newer than 1`);
  });

  test.each([
    ["missing", undefined],
    ["text", "1"],
    ["lower", 0],
    ["negative", -1],
    ["not an integer", 1.5],
    ["null", null],
  ])("%s: a file the page can't read, not a newer format", (_, version) => {
    for (const [file, parse] of Object.entries(files)) {
      let error: unknown;
      try {
        parse(version);
      } catch (e) {
        error = e;
      }
      expect(error, file).toBeInstanceOf(DataShapeError);
      expect(error, file).not.toBeInstanceOf(UnsupportedFormatError);
      expect(String(error), file).toContain(`${file}: schema_version: is not 1`);
    }
  });
});
