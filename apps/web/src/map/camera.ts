// The map's camera limits and the glyph URL. DOM-free, so the tests can check them.

import { ONEMAP_BOUNDS, ONEMAP_MIN_ZOOM } from "@usg/map-style";

/** Where the map opens: the City Hall cluster, between Funan, City Hall MRT and Raffles City. */
export const CITY_HALL: readonly [number, number] = [103.852, 1.2925];

/** The opening zoom: the whole cluster on a phone, with the indoor layers drawn (zoom 16 and up). */
export const INITIAL_ZOOM = 17;

/** The lowest zoom: OneMap serves no tiles below it. */
export const MIN_ZOOM = ONEMAP_MIN_ZOOM;

/**
 * The highest zoom: indoor detail (shop fronts, toilets, lift doors) needs more than OneMap's last
 * tile zoom (20 for HD tiles, 19 for standard ones), so MapLibre overzooms the basemap past it.
 */
export const MAX_ZOOM = 21;

/** The map can't be panned off OneMap's coverage: [west, south, east, north]. */
export const MAX_BOUNDS: [number, number, number, number] = [...ONEMAP_BOUNDS];

/**
 * The glyph URL template for createMapStyle: the app serves packages/map-style/glyphs at
 * `<base>glyphs/` (vite.config.ts), and MapLibre fills in {fontstack} and {range}. Absolute, so it
 * resolves the same from the page and from MapLibre's workers.
 */
export function glyphsUrl(baseUrl: string, pageUrl: string): string {
  return `${new URL(`${baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`}glyphs/`, pageUrl).href}{fontstack}/{range}.pbf`;
}
