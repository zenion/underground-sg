// Colours of the indoor and street layers, chosen to read clearly on OneMap's Grey basemap (and
// to stay legible on Default). Every kind has a colour: the `satisfies` clauses fail to compile
// when a kind is added to the database enums and the schemas. test/style.test.ts checks the
// contrasts: space fills against the Grey basemap's two greys, and CLOSED_COLOR against every
// node and edge colour.

import type { EdgeKind, NodeKind, PoiCategory, SpaceKind } from "@usg/contracts";

/**
 * Space fills: walkways warm, paid areas red, rooms by use. `other` is a warm grey, because the
 * Grey basemap draws buildings, which indoor spaces sit in, in a neutral grey (#e3e4e4).
 */
export const SPACE_COLORS = {
  walkway: "#fbe7a1",
  concourse: "#f4d26b",
  plaza: "#d6eac2",
  shop: "#e2dbf3",
  toilet: "#cbe3f6",
  fare_zone: "#f5c4c4",
  other: "#cfc6b8",
} as const satisfies Record<SpaceKind, string>;

export const SPACE_OUTLINE_COLOR = "#8c7b4f";

/** Edge lines: walking routes in slate, each kind of vertical connector its own colour. */
export const EDGE_COLORS = {
  walk: "#52606d",
  escalator: "#d9822b",
  stairs: "#9c5a1b",
  lift: "#2b6cb0",
  ramp: "#2f855a",
  travelator: "#6b46c1",
  street: "#52606d",
} as const satisfies Record<EdgeKind, string>;

/**
 * Node circles; connector landings take their connector's colour. Fare gates are a dark neutral,
 * kept well away from CLOSED_COLOR's red.
 */
export const NODE_COLORS = {
  junction: "#52606d",
  exit: "#15803d",
  entrance: "#15803d",
  escalator: EDGE_COLORS.escalator,
  lift: EDGE_COLORS.lift,
  stairs: EDGE_COLORS.stairs,
  fare_gate: "#1f2933",
  door: "#52606d",
  travelator: EDGE_COLORS.travelator,
  ramp: EDGE_COLORS.ramp,
} as const satisfies Record<NodeKind, string>;

export const POI_COLORS = {
  shop: "#7c5cbf",
  food: "#c2410c",
  toilet: "#1d6fb8",
  atm: "#0f766e",
  info: "#1d4ed8",
  nursing_room: "#be185d",
  other: "#52606d",
} as const satisfies Record<PoiCategory, string>;

/** The street graph: uncovered footpaths grey, covered ones teal, exit connectors green. */
export const STREET_COLORS = {
  footpath: "#7b8794",
  covered: "#2c7a7b",
  connector: "#15803d",
} as const;

/** Venue footprint outlines. */
export const VENUE_OUTLINE_COLOR = "#7b8794";

/**
 * Features closed in the status overlay (status.json). Colour is not the only cue, so the
 * closure also reads without colour vision: a closed node is a hollow ring in this colour, and a
 * closed edge a double line.
 */
export const CLOSED_COLOR = "#c53030";

export const CASING_COLOR = "#ffffff";

/**
 * The map's background, under the basemap: what the dimmed basemap below the street band blends
 * with, and what shows where there are no tiles, whatever the page or WebView behind the map.
 */
export const BACKGROUND_COLOR = "#ffffff";

export const LABEL_COLORS = {
  text: "#1f2933",
  exit: "#14532d",
  halo: "#ffffff",
} as const;
