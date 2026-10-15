// The level switcher's bands, from the demo snapshot (synthetic City Hall levels) and from levels
// made up to test the labels.

import type { IndoorSnapshot } from "@usg/contracts";
import { describe, expect, test } from "vitest";
import { demoIndoor, LEVEL, VENUE } from "../fixtures/demo-snapshot.ts";
import { bandToShow, levelBands, MAX_LABEL_NAMES } from "../src/data/bands.ts";

let counter = 0;

/** indoor.json with these venues and levels only. */
function indoor(
  venues: Record<string, string>,
  levels: { venue: string; name: string; ordinal: number; sortKey?: number }[],
): IndoorSnapshot {
  const id = () => `00000000-0000-0000-0000-${String(++counter).padStart(12, "0")}`;
  const venueIds = new Map(Object.keys(venues).map((key) => [key, id()]));
  return {
    type: "FeatureCollection",
    schema_version: 1,
    features: [
      ...Object.entries(venues).map(([key, name]) => {
        const venueId = venueIds.get(key) ?? "";
        return {
          type: "Feature" as const,
          id: venueId,
          properties: { feature_type: "venue" as const, id: venueId, name, kind: "mall" as const },
          geometry: null,
        };
      }),
      ...levels.map((level) => {
        const levelId = id();
        return {
          type: "Feature" as const,
          id: levelId,
          properties: {
            feature_type: "level" as const,
            id: levelId,
            venue_id: venueIds.get(level.venue) ?? "",
            name: level.name,
            ordinal: level.ordinal,
            sort_key: level.sortKey ?? 0,
            elevation_m: null,
          },
          geometry: null,
        };
      }),
    ],
  };
}

describe("levelBands", () => {
  test("the demo: street, B1, and B2 shared by Funan and City Hall MRT", () => {
    const bands = levelBands(demoIndoor);
    expect(
      bands.map(({ ordinal, label, description }) => ({ ordinal, label, description })),
    ).toEqual([
      { ordinal: 0, label: "Street", description: "Street level" },
      { ordinal: -1, label: "B1", description: "Funan B1" },
      { ordinal: -2, label: "B2 · Concourse", description: "City Hall MRT Concourse · Funan B2" },
    ]);
    expect(bands[2]?.levels.map((level) => level.id)).toEqual([
      LEVEL.cityHallConcourse,
      LEVEL.funanB2,
    ]);
    expect(VENUE.funan).toBeDefined();
  });

  test("no version yet: just the street band", () => {
    expect(levelBands(undefined).map((band) => band.label)).toEqual(["Street"]);
  });

  test("bands go top to bottom, link bridges above the street", () => {
    const bands = levelBands(
      indoor({ rc: "Raffles City" }, [
        { venue: "rc", name: "B1", ordinal: -1 },
        { venue: "rc", name: "L2", ordinal: 1 },
        { venue: "rc", name: "L1", ordinal: 0 },
      ]),
    );
    expect(bands.map((band) => [band.ordinal, band.label, band.description])).toEqual([
      [1, "L2", "Raffles City L2"],
      [0, "Street", "Street level · Raffles City L1"],
      [-1, "B1", "Raffles City B1"],
    ]);
  });

  test("a name several venues share appears once; names in a band follow sort_key", () => {
    const bands = levelBands(
      indoor({ a: "CityLink Mall", b: "Raffles City", c: "Esplanade MRT" }, [
        { venue: "a", name: "B1", ordinal: -1 },
        { venue: "b", name: "B1", ordinal: -1 },
        { venue: "b", name: "Mezzanine", ordinal: -1, sortKey: 2 },
        { venue: "b", name: "B1M", ordinal: -1, sortKey: 1 },
        { venue: "c", name: "Concourse", ordinal: -1 },
      ]),
    );
    const band = bands.find((item) => item.ordinal === -1);
    expect(band?.label).toBe("B1 · Concourse +2");
    expect(band?.description).toBe(
      "CityLink Mall B1 · Esplanade MRT Concourse · Raffles City B1, B1M, Mezzanine",
    );
  });

  test(`up to ${MAX_LABEL_NAMES} names are shown in full; names sort naturally`, () => {
    const bands = levelBands(
      indoor({ a: "A", b: "B", c: "C" }, [
        { venue: "a", name: "B10", ordinal: -2 },
        { venue: "b", name: "B2", ordinal: -2 },
        { venue: "c", name: "Concourse", ordinal: -2 },
      ]),
    );
    expect(bands.find((band) => band.ordinal === -2)?.label).toBe("B2 · B10 · Concourse");
  });

  test("a level whose venue isn't in the file is still listed", () => {
    const value = indoor({}, [{ venue: "missing", name: "B3", ordinal: -3 }]);
    expect(levelBands(value).at(-1)).toMatchObject({ label: "B3", description: "B3" });
  });
});

describe("bandToShow", () => {
  const bands = levelBands(demoIndoor);

  test("a band the version has is shown", () => {
    expect(bandToShow(-2, bands)).toBe(-2);
    expect(bandToShow(0, bands)).toBe(0);
  });

  test("a band it doesn't have, or any band before a version loads, falls back to the street", () => {
    expect(bandToShow(-5, bands)).toBe(0);
    expect(bandToShow(-2, levelBands(undefined))).toBe(0);
  });
});
