// OneMap raster basemaps (Singapore Land Authority). Checked on 2026-10-15 against OneMap's own
// basemap documentation, https://www.onemap.gov.sg/docs/maps/ (the Default and Grey pages, their
// Leaflet examples and attribution snippet, the TileJSON
// https://www.onemap.gov.sg/maps/json/raster/tilejson/2.2.0/Grey.json and the Mapbox style
// https://www.onemap.gov.sg/maps/json/raster/mbstyle/Grey.json), and against the tile server:
//
// - XYZ tiles: https://www.onemap.gov.sg/maps/tiles/<Basemap>/{z}/{x}/{y}.png, 256 x 256 PNG,
//   served as image/png. The Leaflet examples use minZoom 11 and maxZoom 19.
// - HD tiles: .../maps/tiles/<Basemap>_HD/{z}/{x}/{y}.png, also 256 x 256 but drawn for 2x
//   screens: OneMap's TileJSON lists these (minzoom 11, maxzoom 19), and its Mapbox style uses
//   them with tileSize 128 and maxzoom 20. They are served as `Content-Type: image/undefined`.
// - The last zoom differs by tile type. Standard tiles stop at 19, the last zoom both the TileJSON
//   and the Leaflet examples declare: at zoom 20 they come back as empty 200 responses, which a
//   renderer can't decode. HD tiles answer at zoom 20 with real, sharper tiles (a 256 x 256 PNG
//   at City Hall, checked on 2026-10-15), as OneMap's Mapbox style declares, so the HD source
//   stops at 20. Beyond the last zoom the renderer overzooms, and at the indoor zooms the indoor
//   layers carry the detail.
// - No token is needed for tiles. Tiles may not be cached or packed for offline use without
//   SLA's written permission (docs/decisions/0009-hosting-and-budget.md).
// - The Terms of Use require the OneMap logo and attribution: ONEMAP_ATTRIBUTION in
//   attribution.ts is OneMap's snippet, verbatim.

/** The OneMap basemaps the style supports. */
export const ONEMAP_BASEMAPS = ["Default", "Grey"] as const;

export type OneMapBasemap = (typeof ONEMAP_BASEMAPS)[number];

/** Lowest zoom OneMap serves tiles for. */
export const ONEMAP_MIN_ZOOM = 11;

/** Highest zoom OneMap serves standard tiles for; the renderer overzooms beyond it. */
export const ONEMAP_MAX_ZOOM = 19;

/** Highest zoom OneMap serves HD tiles for, as its own Mapbox style declares. */
export const ONEMAP_HD_MAX_ZOOM = 20;

/** The highest zoom to request for HD or standard tiles. */
export function oneMapMaxZoom(hd: boolean): number {
  return hd ? ONEMAP_HD_MAX_ZOOM : ONEMAP_MAX_ZOOM;
}

/** The tiles' extent, [west, south, east, north], from OneMap's Mapbox style. */
export const ONEMAP_BOUNDS = [103.596, 1.1443, 104.4309, 1.4835] as const;

/**
 * The tile URL template of a basemap. HD tiles (the default, as in OneMap's own style) are drawn
 * for 2x screens and shown at a tile size of 128; standard tiles at 256.
 */
export function oneMapTiles(basemap: OneMapBasemap, hd: boolean): string {
  return `https://www.onemap.gov.sg/maps/tiles/${basemap}${hd ? "_HD" : ""}/{z}/{x}/{y}.png`;
}

/** The tile size to give the renderer for HD or standard tiles. */
export function oneMapTileSize(hd: boolean): number {
  return hd ? 128 : 256;
}
