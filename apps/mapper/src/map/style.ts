// The map's base style: OneMap raster tiles around City Hall, with the attribution OneMap's terms
// require. Kept in this one module so @usg/map-style (being built on another branch) can replace
// it without touching the map component.
//
// Tile URL, zoom range, bounds and attribution are from OneMap's basemap documentation,
// https://www.onemap.gov.sg/docs/maps/ (checked 2026-10-15): "you MUST include the OneMap logo and
// attribution". The attribution HTML is OneMap's own snippet
// (https://www.onemap.gov.sg/docs/maps/resources/code-attr.txt), except that the logo's
// style="height:20px;width:20px;" becomes height and width attributes: MapLibre v6 sanitises
// attribution HTML and drops style attributes, which would leave the logo at its full size.

import type { LngLatBoundsLike, MapOptions } from "maplibre-gl";

type StyleSpecification = Exclude<NonNullable<MapOptions["style"]>, string>;

/** OneMap's Default basemap as XYZ tiles, 256 px, EPSG:3857. */
export const ONEMAP_TILE_URL = "https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png";

export const ONEMAP_ATTRIBUTION =
  '<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" height="20" width="20"/>&nbsp;<a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener noreferrer">OneMap</a>&nbsp;&copy;&nbsp;contributors&nbsp;&#124;&nbsp;<a href="https://www.sla.gov.sg/" target="_blank" rel="noopener noreferrer">Singapore Land Authority</a>';

/**
 * CLAUDE.md: OneMap, OpenStreetMap and LTA attribution stay visible on every map view. The
 * wording follows the repo README; the LTA line is still to be confirmed against the dataset page.
 */
export const EXTRA_ATTRIBUTION = [
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
  "Contains information from MRT Station Exit (LTA) accessed via data.gov.sg, made available under the Singapore Open Data Licence",
];

/** City Hall MRT, the middle of the MVP cluster. */
export const CITY_HALL: [number, number] = [103.852, 1.2931];

export const MAP_VIEW = {
  center: CITY_HALL,
  zoom: 17,
  /** OneMap serves zoom 11 to 19; beyond 19 MapLibre enlarges the zoom-19 tiles. */
  minZoom: 11,
  maxZoom: 20,
  /** OneMap's example bounds for Singapore. */
  maxBounds: [
    [103.535, 1.144],
    [104.502, 1.494],
  ] satisfies LngLatBoundsLike,
};

export function oneMapRasterStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      onemap: {
        type: "raster",
        tiles: [ONEMAP_TILE_URL],
        tileSize: 256,
        minzoom: 11,
        maxzoom: 19,
        // The extent OneMap's own MapLibre style declares.
        bounds: [103.596, 1.1443, 104.4309, 1.4835],
        attribution: ONEMAP_ATTRIBUTION,
      },
    },
    layers: [{ id: "onemap-basemap", type: "raster", source: "onemap" }],
  };
}
