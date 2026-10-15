// Where the Map tab's map opens and how far it goes. The style itself (OneMap tiles, the indoor and
// street layers, the attribution) is @usg/map-style's, shared with the webapp.

import { ONEMAP_BOUNDS, ONEMAP_MIN_ZOOM } from "@usg/map-style";

/** The City Hall cluster, between Funan, City Hall MRT and Raffles City (as the webapp opens). */
export const CITY_HALL: [number, number] = [103.852, 1.2925];

const [west, south, east, north] = ONEMAP_BOUNDS;

export const MAP_VIEW = {
  center: CITY_HALL,
  zoom: 17,
  /** OneMap serves no tiles below zoom 11. */
  minZoom: ONEMAP_MIN_ZOOM,
  /** Past OneMap's last tile zoom (20 for HD tiles) MapLibre overzooms, for indoor detail. */
  maxZoom: 21,
  /** The map can't be panned off OneMap's coverage. */
  maxBounds: [
    [west, south],
    [east, north],
  ] as [[number, number], [number, number]],
};
