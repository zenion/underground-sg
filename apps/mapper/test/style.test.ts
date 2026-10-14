import { describe, expect, test } from "vitest";
import {
  CITY_HALL,
  EXTRA_ATTRIBUTION,
  MAP_VIEW,
  ONEMAP_ATTRIBUTION,
  ONEMAP_TILE_URL,
  oneMapRasterStyle,
} from "../src/map/style.ts";

describe("OneMap base style", () => {
  test("uses OneMap's documented XYZ tiles with its attribution", () => {
    expect(ONEMAP_TILE_URL).toBe("https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png");
    const style = oneMapRasterStyle();
    expect(style.sources["onemap"]).toMatchObject({
      type: "raster",
      tiles: [ONEMAP_TILE_URL],
      tileSize: 256,
      minzoom: 11,
      maxzoom: 19,
      attribution: ONEMAP_ATTRIBUTION,
    });
    expect(style.layers).toEqual([{ id: "onemap-basemap", type: "raster", source: "onemap" }]);
  });

  test("keeps OneMap's attribution wording and logo, without style attributes", () => {
    // OneMap's snippet, with the logo's inline style as height and width attributes, because
    // MapLibre's attribution sanitiser removes style attributes.
    expect(ONEMAP_ATTRIBUTION).toBe(
      '<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" height="20" width="20"/>' +
        '&nbsp;<a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener noreferrer">OneMap</a>' +
        "&nbsp;&copy;&nbsp;contributors&nbsp;&#124;&nbsp;" +
        '<a href="https://www.sla.gov.sg/" target="_blank" rel="noopener noreferrer">Singapore Land Authority</a>',
    );
    for (const html of [ONEMAP_ATTRIBUTION, ...EXTRA_ATTRIBUTION]) {
      expect(html).not.toMatch(/\sstyle=/);
    }
    expect(EXTRA_ATTRIBUTION.join(" ")).toMatch(/OpenStreetMap.*LTA/);
  });

  test("opens on City Hall MRT, inside the bounds", () => {
    expect(CITY_HALL).toEqual([103.852, 1.2931]);
    expect(MAP_VIEW.zoom).toBe(17);
    const [[west, south], [east, north]] = MAP_VIEW.maxBounds;
    expect(CITY_HALL[0]).toBeGreaterThan(west);
    expect(CITY_HALL[0]).toBeLessThan(east);
    expect(CITY_HALL[1]).toBeGreaterThan(south);
    expect(CITY_HALL[1]).toBeLessThan(north);
  });
});
