// The Map tab's level bands and camera, and the shared style as the map builds it, against the
// snapshot builder's golden indoor.json (City Hall cluster coordinates).

import { readFileSync } from "node:fs";
import type { IndoorSnapshot } from "@usg/contracts";
import {
  createMapStyle,
  mapAttribution,
  ONEMAP_BOUNDS,
  SOURCES,
  STREET_BAND,
} from "@usg/map-style";
import { describe, expect, test } from "vitest";
import { bandToShow, levelBands } from "../src/map/bands.ts";
import { CITY_HALL, MAP_VIEW } from "../src/map/camera.ts";
import { glyphsTemplate } from "../src/map/published.ts";

const INDOOR = JSON.parse(
  readFileSync(
    new URL("../../../services/api/test/fixtures/snapshot/indoor.json", import.meta.url),
    "utf8",
  ),
) as IndoorSnapshot;

describe("levelBands", () => {
  test("one band per ordinal, top to bottom, labelled with the levels' signed names", () => {
    expect(levelBands(INDOOR)).toEqual([
      { ordinal: 0, label: "Street", title: "Street level" },
      { ordinal: -1, label: "B1", title: "Funan B1 · Raffles City B1" },
      { ordinal: -2, label: "B2 · Concourse", title: "City Hall MRT Concourse · Funan B2" },
    ]);
  });

  test("only the street band before a map is loaded", () => {
    expect(levelBands(undefined)).toEqual([
      { ordinal: STREET_BAND, label: "Street", title: "Street level" },
    ]);
  });

  test("long bands are counted, and a band without names is numbered", () => {
    const venue = "10000000-0000-0000-0000-000000000009";
    const level = (id: number, name: string, ordinal: number, sortKey = 0) => ({
      type: "Feature" as const,
      id: `20000000-0000-0000-0000-00000000010${id}`,
      properties: {
        feature_type: "level" as const,
        id: `20000000-0000-0000-0000-00000000010${id}`,
        venue_id: venue,
        name,
        ordinal,
        sort_key: sortKey,
        elevation_m: null,
      },
      geometry: null,
    });
    const indoor = {
      type: "FeatureCollection",
      schema_version: 1,
      features: [
        level(1, "B3", -3, 1),
        level(2, "B10", -3, 1),
        level(3, "Platform", -3, 0),
        level(4, " ", -4),
      ],
    } as unknown as IndoorSnapshot;
    const bands = levelBands(indoor);
    expect(bands.map((band) => band.label)).toEqual(["Street", "Platform · B3 +1", "Band -4"]);
  });

  test("bandToShow keeps a band the version has, else the street band", () => {
    const bands = levelBands(INDOOR);
    expect(bandToShow(-2, bands)).toBe(-2);
    expect(bandToShow(-5, bands)).toBe(STREET_BAND);
    expect(bandToShow(-1, levelBands(undefined))).toBe(STREET_BAND);
  });
});

describe("the map", () => {
  test("opens on the City Hall cluster, inside OneMap's coverage", () => {
    const [west, south, east, north] = ONEMAP_BOUNDS;
    expect(MAP_VIEW.center).toBe(CITY_HALL);
    expect(CITY_HALL[0]).toBeGreaterThan(west);
    expect(CITY_HALL[0]).toBeLessThan(east);
    expect(CITY_HALL[1]).toBeGreaterThan(south);
    expect(CITY_HALL[1]).toBeLessThan(north);
    expect(MAP_VIEW.maxBounds).toEqual([
      [west, south],
      [east, north],
    ]);
    expect(MAP_VIEW.minZoom).toBe(11);
    expect(MAP_VIEW.maxZoom).toBe(21);
  });

  test("the shared style with the API's glyphs, empty sources, and all three attributions", () => {
    const style = createMapStyle({ glyphs: glyphsTemplate("https://usg.example.ngrok.app") });
    expect(style.glyphs).toBe("https://usg.example.ngrok.app/glyphs/{fontstack}/{range}.pbf");
    expect(style.sources[SOURCES.basemap]).toMatchObject({ attribution: mapAttribution() });
    expect(mapAttribution()).toMatch(/OneMap.*OpenStreetMap.*LTA/s);
    expect(style.sources[SOURCES.indoor]).toMatchObject({
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      promoteId: "id",
    });
    // Without an API the style still builds (no data, so no labels and no glyph requests).
    expect(() => createMapStyle({ glyphs: glyphsTemplate(null) })).not.toThrow();
  });
});
