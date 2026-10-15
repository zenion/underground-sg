// A small demonstration snapshot for the fixture dev server (`pnpm --filter @usg/web dev:fixtures`),
// so the webapp can be developed and checked without the API. Synthetic, at real City Hall cluster
// coordinates (WGS84 lon/lat): it extends the examples in packages/contracts/test/map-examples.ts
// (same ids and positions for the features they share) with Funan's B1, a link from Funan's B2 to
// a City Hall MRT concourse, a paid area and an exit on Stamford Road. Exit B opens onto North
// Bridge Road at Funan's frontage, up about 24 m of stairs from B2. Shapes and names are made up,
// not surveyed, and latest.json says `demo: true`, so the app shows its banner. The OSM ids are
// made up too. Each length_m is within 3 m of its line as drawn, measured in SVY21 (plus the climb,
// for stairs and escalators). test/demo-snapshot.test.ts validates every file with
// @usg/contracts/validators and checks the lengths.
//
// Node only (node:crypto): the dev server builds the files; the browser bundle never imports this.

import { createHash } from "node:crypto";
import {
  type IndoorSnapshot,
  type LatestPointer,
  type LinearRing,
  type StatusOverlay,
  type StreetSnapshot,
  snapshotDigestInput,
  snapshotFilePath,
} from "@usg/contracts";

export const VENUE = {
  funan: "10000000-0000-0000-0000-000000000001",
  cityHallMrt: "10000000-0000-0000-0000-000000000002",
} as const;

export const LEVEL = {
  funanB2: "20000000-0000-0000-0000-000000000001",
  funanB1: "20000000-0000-0000-0000-000000000002",
  cityHallConcourse: "20000000-0000-0000-0000-000000000003",
} as const;

export const SPACE = {
  funanB2Walkway: "30000000-0000-0000-0000-000000000001",
  funanB2Toilet: "30000000-0000-0000-0000-000000000002",
  funanB1Walkway: "30000000-0000-0000-0000-000000000003",
  funanB1Shops: "30000000-0000-0000-0000-000000000004",
  cityHallLink: "30000000-0000-0000-0000-000000000005",
  cityHallConcourse: "30000000-0000-0000-0000-000000000006",
  cityHallPaidArea: "30000000-0000-0000-0000-000000000007",
} as const;

export const NODE = {
  funanB2Escalator: "40000000-0000-0000-0000-000000000001",
  funanB1Escalator: "40000000-0000-0000-0000-000000000002",
  funanB2Junction: "40000000-0000-0000-0000-000000000003",
  northBridgeRoadExit: "40000000-0000-0000-0000-000000000004",
  cityHallExitA: "40000000-0000-0000-0000-000000000005",
  linkWest: "40000000-0000-0000-0000-000000000006",
  concourseJunction: "40000000-0000-0000-0000-000000000007",
  fareGate: "40000000-0000-0000-0000-000000000008",
  concourseEscalator: "40000000-0000-0000-0000-000000000009",
  stamfordRoadExit: "40000000-0000-0000-0000-000000000010",
} as const;

export const EDGE = {
  escalator: "50000000-0000-0000-0000-000000000001",
  walk: "50000000-0000-0000-0000-000000000002",
  stairs: "50000000-0000-0000-0000-000000000003",
  street: "50000000-0000-0000-0000-000000000004",
  funanToLink: "50000000-0000-0000-0000-000000000005",
  link: "50000000-0000-0000-0000-000000000006",
  toFareGate: "50000000-0000-0000-0000-000000000007",
  toConcourseEscalator: "50000000-0000-0000-0000-000000000008",
  stamfordRoadEscalator: "50000000-0000-0000-0000-000000000009",
} as const;

export const POI = {
  funanB2Toilet: "60000000-0000-0000-0000-000000000001",
  concourseInfo: "60000000-0000-0000-0000-000000000002",
} as const;

/** Street connectors' ids: streetConnectorId(node id), checked by the test. */
export const CONNECTOR = {
  northBridgeRoad: "2f98748b-4853-530a-a94c-e8cda2047aed",
  stamfordRoad: "9daf89d0-4d0f-517c-86b1-0897824ab1ee",
} as const;

/** connector_id of each physical connector. */
export const PHYSICAL = {
  funanEscalator: "90000000-0000-0000-0000-000000000001",
  exitStairs: "90000000-0000-0000-0000-000000000002",
  stamfordRoadEscalator: "90000000-0000-0000-0000-000000000003",
} as const;

function rectangle(west: number, south: number, east: number, north: number): LinearRing {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

const WALKED = { oneway: false, access: "public", opening_hours: null } as const;
const INDOOR_WALK = { step_free: true, sheltered: true, outdoor: false } as const;

export const demoIndoor: IndoorSnapshot = {
  type: "FeatureCollection",
  schema_version: 1,
  features: [
    {
      type: "Feature",
      id: VENUE.funan,
      properties: { feature_type: "venue", id: VENUE.funan, name: "Funan", kind: "mall" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [[rectangle(103.8492, 1.2908, 103.8506, 1.2921)]],
      },
    },
    {
      type: "Feature",
      id: VENUE.cityHallMrt,
      properties: {
        feature_type: "venue",
        id: VENUE.cityHallMrt,
        name: "City Hall MRT",
        kind: "mrt_station",
      },
      geometry: null,
    },
    {
      type: "Feature",
      id: LEVEL.funanB2,
      properties: {
        feature_type: "level",
        id: LEVEL.funanB2,
        venue_id: VENUE.funan,
        name: "B2",
        ordinal: -2,
        sort_key: 0,
        elevation_m: -9.5,
      },
      geometry: null,
    },
    {
      type: "Feature",
      id: LEVEL.funanB1,
      properties: {
        feature_type: "level",
        id: LEVEL.funanB1,
        venue_id: VENUE.funan,
        name: "B1",
        ordinal: -1,
        sort_key: 0,
        elevation_m: -4.5,
      },
      geometry: null,
    },
    {
      type: "Feature",
      id: LEVEL.cityHallConcourse,
      properties: {
        feature_type: "level",
        id: LEVEL.cityHallConcourse,
        venue_id: VENUE.cityHallMrt,
        name: "Concourse",
        ordinal: -2,
        sort_key: 0,
        elevation_m: null,
      },
      geometry: null,
    },
    {
      type: "Feature",
      id: SPACE.funanB2Walkway,
      properties: {
        feature_type: "space",
        id: SPACE.funanB2Walkway,
        level_id: LEVEL.funanB2,
        ordinal: -2,
        kind: "walkway",
        name: null,
      },
      geometry: { type: "Polygon", coordinates: [rectangle(103.8497, 1.2911, 103.8504, 1.2916)] },
    },
    {
      type: "Feature",
      id: SPACE.funanB2Toilet,
      properties: {
        feature_type: "space",
        id: SPACE.funanB2Toilet,
        level_id: LEVEL.funanB2,
        ordinal: -2,
        kind: "toilet",
        name: "Toilets",
      },
      geometry: { type: "Polygon", coordinates: [rectangle(103.8495, 1.2911, 103.8497, 1.2913)] },
    },
    {
      type: "Feature",
      id: SPACE.funanB1Walkway,
      properties: {
        feature_type: "space",
        id: SPACE.funanB1Walkway,
        level_id: LEVEL.funanB1,
        ordinal: -1,
        kind: "walkway",
        name: null,
      },
      geometry: { type: "Polygon", coordinates: [rectangle(103.8496, 1.2911, 103.8504, 1.2917)] },
    },
    {
      type: "Feature",
      id: SPACE.funanB1Shops,
      properties: {
        feature_type: "space",
        id: SPACE.funanB1Shops,
        level_id: LEVEL.funanB1,
        ordinal: -1,
        kind: "shop",
        name: "Shops",
      },
      geometry: { type: "Polygon", coordinates: [rectangle(103.8493, 1.2913, 103.8496, 1.2916)] },
    },
    {
      type: "Feature",
      id: SPACE.cityHallLink,
      properties: {
        feature_type: "space",
        id: SPACE.cityHallLink,
        level_id: LEVEL.cityHallConcourse,
        ordinal: -2,
        kind: "walkway",
        // An en dash, from the glyph range 8192-8447.
        name: "Funan – City Hall link",
      },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [103.8503757, 1.2915176],
            [103.8511757, 1.2926176],
            [103.8512243, 1.2925824],
            [103.8504243, 1.2914824],
            [103.8503757, 1.2915176],
          ],
        ],
      },
    },
    {
      type: "Feature",
      id: SPACE.cityHallConcourse,
      properties: {
        feature_type: "space",
        id: SPACE.cityHallConcourse,
        level_id: LEVEL.cityHallConcourse,
        ordinal: -2,
        kind: "concourse",
        name: "Concourse",
      },
      geometry: { type: "Polygon", coordinates: [rectangle(103.8512, 1.2925, 103.852, 1.2934)] },
    },
    {
      type: "Feature",
      id: SPACE.cityHallPaidArea,
      properties: {
        feature_type: "space",
        id: SPACE.cityHallPaidArea,
        level_id: LEVEL.cityHallConcourse,
        ordinal: -2,
        kind: "fare_zone",
        name: "Paid area",
      },
      geometry: { type: "Polygon", coordinates: [rectangle(103.852, 1.2926, 103.8525, 1.2933)] },
    },
    {
      type: "Feature",
      id: NODE.funanB2Escalator,
      properties: {
        feature_type: "node",
        id: NODE.funanB2Escalator,
        level_id: LEVEL.funanB2,
        ordinal: -2,
        kind: "escalator",
        name: null,
        street_name: null,
        connector_id: PHYSICAL.funanEscalator,
      },
      geometry: { type: "Point", coordinates: [103.8499, 1.2913] },
    },
    {
      type: "Feature",
      id: NODE.funanB1Escalator,
      properties: {
        feature_type: "node",
        id: NODE.funanB1Escalator,
        level_id: LEVEL.funanB1,
        ordinal: -1,
        kind: "escalator",
        name: null,
        street_name: null,
        connector_id: PHYSICAL.funanEscalator,
      },
      geometry: { type: "Point", coordinates: [103.84995, 1.29135] },
    },
    {
      type: "Feature",
      id: NODE.funanB2Junction,
      properties: {
        feature_type: "node",
        id: NODE.funanB2Junction,
        level_id: LEVEL.funanB2,
        ordinal: -2,
        kind: "junction",
        name: null,
        street_name: null,
        connector_id: null,
      },
      geometry: { type: "Point", coordinates: [103.8504, 1.2916] },
    },
    {
      type: "Feature",
      id: NODE.northBridgeRoadExit,
      properties: {
        feature_type: "node",
        id: NODE.northBridgeRoadExit,
        level_id: null,
        ordinal: 0,
        kind: "exit",
        name: "Exit B",
        street_name: "North Bridge Road",
        connector_id: PHYSICAL.exitStairs,
      },
      geometry: { type: "Point", coordinates: [103.8506, 1.2916] },
    },
    {
      type: "Feature",
      id: NODE.cityHallExitA,
      properties: {
        feature_type: "node",
        id: NODE.cityHallExitA,
        level_id: null,
        ordinal: 0,
        kind: "exit",
        name: "Exit A",
        street_name: "St Andrew's Road",
        connector_id: null,
      },
      geometry: { type: "Point", coordinates: [103.8523, 1.2931] },
    },
    {
      type: "Feature",
      id: NODE.linkWest,
      properties: {
        feature_type: "node",
        id: NODE.linkWest,
        level_id: LEVEL.funanB2,
        ordinal: -2,
        kind: "door",
        name: null,
        street_name: null,
        connector_id: null,
      },
      geometry: { type: "Point", coordinates: [103.8504, 1.2915] },
    },
    {
      type: "Feature",
      id: NODE.concourseJunction,
      properties: {
        feature_type: "node",
        id: NODE.concourseJunction,
        level_id: LEVEL.cityHallConcourse,
        ordinal: -2,
        kind: "junction",
        name: null,
        street_name: null,
        connector_id: null,
      },
      geometry: { type: "Point", coordinates: [103.8512, 1.2926] },
    },
    {
      type: "Feature",
      id: NODE.fareGate,
      properties: {
        feature_type: "node",
        id: NODE.fareGate,
        level_id: LEVEL.cityHallConcourse,
        ordinal: -2,
        kind: "fare_gate",
        name: null,
        street_name: null,
        connector_id: null,
      },
      geometry: { type: "Point", coordinates: [103.852, 1.2929] },
    },
    {
      type: "Feature",
      id: NODE.concourseEscalator,
      properties: {
        feature_type: "node",
        id: NODE.concourseEscalator,
        level_id: LEVEL.cityHallConcourse,
        ordinal: -2,
        kind: "escalator",
        name: null,
        street_name: null,
        connector_id: PHYSICAL.stamfordRoadEscalator,
      },
      geometry: { type: "Point", coordinates: [103.8516, 1.2932] },
    },
    {
      type: "Feature",
      id: NODE.stamfordRoadExit,
      properties: {
        feature_type: "node",
        id: NODE.stamfordRoadExit,
        level_id: null,
        ordinal: 0,
        kind: "exit",
        name: "Exit C",
        street_name: "Stamford Road",
        connector_id: PHYSICAL.stamfordRoadEscalator,
      },
      geometry: { type: "Point", coordinates: [103.8516, 1.2935] },
    },
    {
      type: "Feature",
      id: EDGE.escalator,
      properties: {
        feature_type: "edge",
        id: EDGE.escalator,
        from_node: NODE.funanB2Escalator,
        to_node: NODE.funanB1Escalator,
        from_ordinal: -2,
        to_ordinal: -1,
        level_id: null,
        kind: "escalator",
        connector_id: PHYSICAL.funanEscalator,
        oneway: true,
        access: "public",
        opening_hours: "Mo-Su 10:00-22:00",
        length_m: 9.8,
        step_free: false,
        sheltered: true,
        outdoor: false,
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [103.8499, 1.2913],
          [103.84995, 1.29135],
        ],
      },
    },
    {
      type: "Feature",
      id: EDGE.walk,
      properties: {
        feature_type: "edge",
        id: EDGE.walk,
        from_node: NODE.funanB2Escalator,
        to_node: NODE.funanB2Junction,
        from_ordinal: -2,
        to_ordinal: -2,
        level_id: LEVEL.funanB2,
        kind: "walk",
        connector_id: null,
        ...WALKED,
        length_m: 65.4,
        ...INDOOR_WALK,
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [103.8499, 1.2913],
          [103.8501, 1.2914],
          [103.8502, 1.2915],
          [103.8504, 1.2916],
        ],
      },
    },
    {
      type: "Feature",
      id: EDGE.stairs,
      properties: {
        feature_type: "edge",
        id: EDGE.stairs,
        from_node: NODE.funanB2Junction,
        to_node: NODE.northBridgeRoadExit,
        from_ordinal: -2,
        to_ordinal: 0,
        level_id: null,
        kind: "stairs",
        connector_id: PHYSICAL.exitStairs,
        oneway: false,
        access: "public",
        opening_hours: "Mo-Su 06:00-24:00",
        length_m: 24.2,
        step_free: false,
        sheltered: true,
        outdoor: false,
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [103.8504, 1.2916],
          [103.8506, 1.2916],
        ],
      },
    },
    {
      type: "Feature",
      id: EDGE.street,
      properties: {
        feature_type: "edge",
        id: EDGE.street,
        from_node: NODE.northBridgeRoadExit,
        to_node: NODE.cityHallExitA,
        from_ordinal: 0,
        to_ordinal: 0,
        level_id: null,
        kind: "street",
        connector_id: null,
        ...WALKED,
        length_m: 251.61,
        step_free: true,
        sheltered: false,
        outdoor: true,
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [103.8506, 1.2916],
          [103.8523, 1.2931],
        ],
      },
    },
    {
      type: "Feature",
      id: EDGE.funanToLink,
      properties: {
        feature_type: "edge",
        id: EDGE.funanToLink,
        from_node: NODE.funanB2Junction,
        to_node: NODE.linkWest,
        from_ordinal: -2,
        to_ordinal: -2,
        level_id: LEVEL.funanB2,
        kind: "walk",
        connector_id: null,
        ...WALKED,
        length_m: 11.06,
        ...INDOOR_WALK,
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [103.8504, 1.2916],
          [103.8504, 1.2915],
        ],
      },
    },
    {
      type: "Feature",
      id: EDGE.link,
      properties: {
        feature_type: "edge",
        id: EDGE.link,
        from_node: NODE.linkWest,
        to_node: NODE.concourseJunction,
        from_ordinal: -2,
        to_ordinal: -2,
        // Between two venues' levels on one band: not a single-level edge.
        level_id: null,
        kind: "walk",
        connector_id: null,
        ...WALKED,
        length_m: 151.36,
        ...INDOOR_WALK,
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [103.8504, 1.2915],
          [103.8512, 1.2926],
        ],
      },
    },
    {
      type: "Feature",
      id: EDGE.toFareGate,
      properties: {
        feature_type: "edge",
        id: EDGE.toFareGate,
        from_node: NODE.concourseJunction,
        to_node: NODE.fareGate,
        from_ordinal: -2,
        to_ordinal: -2,
        level_id: LEVEL.cityHallConcourse,
        kind: "walk",
        connector_id: null,
        ...WALKED,
        length_m: 95.06,
        ...INDOOR_WALK,
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [103.8512, 1.2926],
          [103.852, 1.2929],
        ],
      },
    },
    {
      type: "Feature",
      id: EDGE.toConcourseEscalator,
      properties: {
        feature_type: "edge",
        id: EDGE.toConcourseEscalator,
        from_node: NODE.concourseJunction,
        to_node: NODE.concourseEscalator,
        from_ordinal: -2,
        to_ordinal: -2,
        level_id: LEVEL.cityHallConcourse,
        kind: "walk",
        connector_id: null,
        ...WALKED,
        length_m: 80.26,
        ...INDOOR_WALK,
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [103.8512, 1.2926],
          [103.8516, 1.2932],
        ],
      },
    },
    {
      type: "Feature",
      id: EDGE.stamfordRoadEscalator,
      properties: {
        feature_type: "edge",
        id: EDGE.stamfordRoadEscalator,
        from_node: NODE.concourseEscalator,
        to_node: NODE.stamfordRoadExit,
        from_ordinal: -2,
        to_ordinal: 0,
        level_id: null,
        kind: "escalator",
        connector_id: PHYSICAL.stamfordRoadEscalator,
        oneway: true,
        access: "public",
        opening_hours: null,
        length_m: 33.4,
        step_free: false,
        sheltered: true,
        outdoor: false,
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [103.8516, 1.2932],
          [103.8516, 1.2935],
        ],
      },
    },
    {
      type: "Feature",
      id: POI.funanB2Toilet,
      properties: {
        feature_type: "poi",
        id: POI.funanB2Toilet,
        level_id: LEVEL.funanB2,
        ordinal: -2,
        space_id: SPACE.funanB2Toilet,
        name: "Toilets",
        category: "toilet",
      },
      geometry: { type: "Point", coordinates: [103.8496, 1.2912] },
    },
    {
      type: "Feature",
      id: POI.concourseInfo,
      properties: {
        feature_type: "poi",
        id: POI.concourseInfo,
        level_id: LEVEL.cityHallConcourse,
        ordinal: -2,
        space_id: SPACE.cityHallConcourse,
        // CJK: MapLibre draws it with a local font and requests no glyph range for it.
        name: "Information · 询问处",
        category: "info",
      },
      geometry: { type: "Point", coordinates: [103.8514, 1.293] },
    },
    {
      type: "Feature",
      id: CONNECTOR.northBridgeRoad,
      properties: {
        feature_type: "street_connector",
        id: CONNECTOR.northBridgeRoad,
        node_id: NODE.northBridgeRoadExit,
        osm_node_id: 1001,
        ordinal: 0,
        length_m: 11.13,
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [103.8506, 1.2916],
          [103.8507, 1.2916],
        ],
      },
    },
    {
      type: "Feature",
      id: CONNECTOR.stamfordRoad,
      properties: {
        feature_type: "street_connector",
        id: CONNECTOR.stamfordRoad,
        node_id: NODE.stamfordRoadExit,
        osm_node_id: 1004,
        ordinal: 0,
        length_m: 11.13,
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [103.8516, 1.2935],
          [103.8517, 1.2935],
        ],
      },
    },
  ],
};

export const demoStreet: StreetSnapshot = {
  type: "FeatureCollection",
  schema_version: 1,
  source: {
    name: "OpenStreetMap",
    licence: "ODbL-1.0",
    licence_url: "https://opendatacommons.org/licenses/odbl/1-0/",
    attribution: "© OpenStreetMap contributors",
    attribution_url: "https://www.openstreetmap.org/copyright",
  },
  features: [
    {
      type: "Feature",
      id: 1001,
      properties: { feature_type: "street_node" },
      geometry: { type: "Point", coordinates: [103.8507, 1.2916] },
    },
    {
      type: "Feature",
      id: 1002,
      properties: { feature_type: "street_node" },
      geometry: { type: "Point", coordinates: [103.8515, 1.293] },
    },
    {
      type: "Feature",
      id: 1003,
      properties: { feature_type: "street_node" },
      geometry: { type: "Point", coordinates: [103.8523, 1.2932] },
    },
    {
      type: "Feature",
      id: 1004,
      properties: { feature_type: "street_node" },
      geometry: { type: "Point", coordinates: [103.8517, 1.2935] },
    },
    {
      type: "Feature",
      properties: {
        feature_type: "street_edge",
        osm_way_id: 2001,
        from_osm_node: 1001,
        to_osm_node: 1002,
        highway: "footway",
        footway: "sidewalk",
        covered: false,
        length_m: 178.58,
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [103.8507, 1.2916],
          [103.8515, 1.293],
        ],
      },
    },
    {
      type: "Feature",
      properties: {
        feature_type: "street_edge",
        osm_way_id: 2001,
        from_osm_node: 1002,
        to_osm_node: 1003,
        highway: "footway",
        footway: null,
        covered: true,
        length_m: 89.6,
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [103.8515, 1.293],
          [103.8523, 1.2932],
        ],
      },
    },
    {
      type: "Feature",
      properties: {
        feature_type: "street_edge",
        osm_way_id: 2002,
        from_osm_node: 1003,
        to_osm_node: 1004,
        highway: "footway",
        footway: "sidewalk",
        covered: false,
        length_m: 74.68,
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [103.8523, 1.2932],
          [103.8517, 1.2935],
        ],
      },
    },
  ],
};

/** When the demo version was "published". Fixed, so the version files' hashes don't change. */
export const DEMO_PUBLISHED_AT = "2026-10-15T09:00:00+08:00";

/**
 * status.json as of `now`: the Funan escalator under maintenance and Exit B closed (as in the
 * contracts' example), each from an hour before `now` until further notice.
 */
export function demoStatus(now: Date): StatusOverlay {
  const anHourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    entries: [
      {
        feature_type: "edge",
        feature_id: EDGE.escalator,
        is_open: false,
        note: "Escalator under maintenance",
        valid_from: anHourAgo,
        valid_until: null,
      },
      {
        feature_type: "node",
        feature_id: NODE.northBridgeRoadExit,
        is_open: false,
        note: null,
        valid_from: anHourAgo,
        valid_until: null,
      },
    ],
  };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A public file as the server sends it. */
export interface PublicFile {
  readonly body: string;
  readonly contentType: string;
  readonly cacheControl: string;
}

/**
 * The public files of the demo, by path relative to the root of the public files
 * (docs/snapshot-format.md, "Layout"): latest.json (with `demo: true`), status.json as of `now`,
 * and the version's indoor.json and street.json under `snapshots/<snapshot_sha256>/`, serialised
 * compactly with the hashes the format describes.
 */
export function demoPublicFiles(now: Date): Map<string, PublicFile> {
  const indoor = JSON.stringify(demoIndoor);
  const street = JSON.stringify(demoStreet);
  const digests = { "indoor.json": sha256Hex(indoor), "street.json": sha256Hex(street) };
  const snapshotSha256 = sha256Hex(snapshotDigestInput(digests));
  const latest: LatestPointer = {
    schema_version: 1,
    version: 1,
    published_at: DEMO_PUBLISHED_AT,
    snapshot_sha256: snapshotSha256,
    files: {
      indoor: {
        path: snapshotFilePath(snapshotSha256, "indoor.json"),
        bytes: new TextEncoder().encode(indoor).byteLength,
        sha256: digests["indoor.json"],
      },
      street: {
        path: snapshotFilePath(snapshotSha256, "street.json"),
        bytes: new TextEncoder().encode(street).byteLength,
        sha256: digests["street.json"],
      },
    },
    attribution: [
      { text: "© OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright" },
    ],
    demo: true,
  };
  const json = "application/json";
  const geojson = "application/geo+json";
  const shortLived = "no-cache";
  return new Map<string, PublicFile>([
    ["latest.json", { body: JSON.stringify(latest), contentType: json, cacheControl: shortLived }],
    [
      "status.json",
      { body: JSON.stringify(demoStatus(now)), contentType: json, cacheControl: shortLived },
    ],
    [latest.files.indoor.path, { body: indoor, contentType: geojson, cacheControl: shortLived }],
    [latest.files.street.path, { body: street, contentType: geojson, cacheControl: shortLived }],
  ]);
}
