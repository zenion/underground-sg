// The map's camera limits, the glyph URL and the text about the loaded version.

import { createMapStyle, ONEMAP_BOUNDS, oneMapMaxZoom, SOURCES } from "@usg/map-style";
import { describe, expect, test } from "vitest";
import { demoPublicFiles } from "../fixtures/demo-snapshot.ts";
import { formatPublishedAt, versionLine } from "../src/data/format.ts";
import { parseLatest } from "../src/data/shapes.ts";
import {
  CITY_HALL,
  glyphsUrl,
  INITIAL_ZOOM,
  MAX_BOUNDS,
  MAX_ZOOM,
  MIN_ZOOM,
} from "../src/map/camera.ts";

/** Intl may put a narrow no-break space before "am"; compare with plain spaces. */
const plain = (text: string) => text.replace(/\s/g, " ");

describe("the camera", () => {
  test("indoor zooms go past OneMap's last tile zoom, so the basemap overzooms", () => {
    expect(MAX_ZOOM).toBeGreaterThan(oneMapMaxZoom(true));
    expect(MAX_ZOOM).toBeGreaterThan(oneMapMaxZoom(false));
    const style = createMapStyle({ glyphs: glyphsUrl("/", "http://localhost:5173/") });
    expect(style.sources[SOURCES.basemap]).toMatchObject({ maxzoom: 20 });
  });

  test("it opens on City Hall, inside OneMap's bounds, with the indoor layers drawn", () => {
    const [west, south, east, north] = ONEMAP_BOUNDS;
    const [lon, lat] = CITY_HALL;
    expect(lon > west && lon < east && lat > south && lat < north).toBe(true);
    expect(MAX_BOUNDS).toEqual([...ONEMAP_BOUNDS]);
    expect(INITIAL_ZOOM).toBeGreaterThanOrEqual(16);
    expect(MIN_ZOOM).toBe(11);
  });
});

describe("glyphsUrl", () => {
  test.each([
    [
      "/",
      "http://localhost:5173/#map=17/1.29/103.85",
      "http://localhost:5173/glyphs/{fontstack}/{range}.pbf",
    ],
    ["/", "http://192.168.1.20:5173/", "http://192.168.1.20:5173/glyphs/{fontstack}/{range}.pbf"],
    [
      "/app/",
      "https://underground.sg/app/",
      "https://underground.sg/app/glyphs/{fontstack}/{range}.pbf",
    ],
  ])("base %s on %s", (base, page, expected) => {
    expect(glyphsUrl(base, page)).toBe(expected);
  });

  test("the template keeps its placeholders, which createMapStyle requires", () => {
    expect(() => createMapStyle({ glyphs: glyphsUrl("/", "http://localhost/") })).not.toThrow();
  });
});

describe("the version line", () => {
  test("published times are shown in Singapore time", () => {
    expect(plain(formatPublishedAt("2026-11-02T14:05:11+08:00"))).toBe("2 Nov 2026, 2:05 pm");
    expect(plain(formatPublishedAt("2026-11-02T06:05:11Z"))).toBe("2 Nov 2026, 2:05 pm");
    expect(formatPublishedAt("not a time")).toBe("not a time");
  });

  test("the demo's", () => {
    const latest = parseLatest(
      JSON.parse(demoPublicFiles(new Date()).get("latest.json")?.body ?? ""),
    );
    expect(plain(versionLine(latest))).toBe("Map version 1 · 15 Oct 2026, 9:00 am");
  });
});
