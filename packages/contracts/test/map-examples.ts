// Examples of the public map files and a change-set diff, as typed values. Synthetic, at real
// City Hall cluster coordinates (WGS84 lon/lat): Funan's B2 near the underground link to City
// Hall MRT, and a street exit on North Bridge Road. The OSM ids are made up.

import type {
  ChangeSetDiff,
  IndoorSnapshot,
  LatestPointer,
  StatusOverlay,
  StreetSnapshot,
} from "../src/index.ts";

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
} as const;

export const NODE = {
  funanB2Escalator: "40000000-0000-0000-0000-000000000001",
  funanB1Escalator: "40000000-0000-0000-0000-000000000002",
  funanB2Junction: "40000000-0000-0000-0000-000000000003",
  northBridgeRoadExit: "40000000-0000-0000-0000-000000000004",
  cityHallExitA: "40000000-0000-0000-0000-000000000005",
} as const;

export const EDGE = {
  escalator: "50000000-0000-0000-0000-000000000001",
  walk: "50000000-0000-0000-0000-000000000002",
  stairs: "50000000-0000-0000-0000-000000000003",
  street: "50000000-0000-0000-0000-000000000004",
} as const;

export const POI = { funanB2Toilet: "60000000-0000-0000-0000-000000000001" } as const;
/** A street connector's id is derived from its node's: streetConnectorId(NODE.northBridgeRoadExit). */
export const CONNECTOR = { northBridgeRoad: "2f98748b-4853-530a-a94c-e8cda2047aed" } as const;
export const ANCHOR = { northBridgeRoadExitB: "80000000-0000-0000-0000-000000000001" } as const;

/** connector_id of one physical escalator and one flight of stairs. */
export const PHYSICAL = {
  funanEscalator: "90000000-0000-0000-0000-000000000001",
  exitStairs: "90000000-0000-0000-0000-000000000002",
} as const;

export const indoor: IndoorSnapshot = {
  type: "FeatureCollection",
  schema_version: 1,
  features: [
    {
      type: "Feature",
      id: VENUE.funan,
      properties: { feature_type: "venue", id: VENUE.funan, name: "Funan", kind: "mall" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [103.8492, 1.2908],
              [103.8506, 1.2908],
              [103.8506, 1.2921],
              [103.8492, 1.2921],
              [103.8492, 1.2908],
            ],
          ],
        ],
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
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [103.8497, 1.2911],
            [103.8504, 1.2911],
            [103.8504, 1.2916],
            [103.8497, 1.2916],
            [103.8497, 1.2911],
          ],
        ],
      },
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
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [103.8495, 1.2911],
            [103.8497, 1.2911],
            [103.8497, 1.2913],
            [103.8495, 1.2913],
            [103.8495, 1.2911],
          ],
        ],
      },
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
        oneway: false,
        access: "public",
        opening_hours: null,
        length_m: 65.4,
        step_free: true,
        sheltered: true,
        outdoor: false,
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
        oneway: false,
        access: "public",
        opening_hours: null,
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
  ],
};

export const street: StreetSnapshot = {
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
  ],
};

const SNAPSHOT_SHA256 = "3f8a2b6c4d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a";

export const latest: LatestPointer = {
  schema_version: 1,
  version: 7,
  published_at: "2026-11-02T14:05:11+08:00",
  snapshot_sha256: SNAPSHOT_SHA256,
  files: {
    indoor: {
      path: `snapshots/${SNAPSHOT_SHA256}/indoor.json`,
      bytes: 48213,
      sha256: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    },
    street: {
      path: `snapshots/${SNAPSHOT_SHA256}/street.json`,
      bytes: 120934,
      sha256: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
    },
  },
  attribution: [
    { text: "© OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright" },
    {
      text: "Contains information from LTA MRT Station Exit (GEOJSON) accessed on 20 October 2026 from data.gov.sg which is made available under the terms of the Singapore Open Data Licence version 1.0",
      url: "https://data.gov.sg/open-data-licence",
    },
  ],
};

export const status: StatusOverlay = {
  schema_version: 1,
  generated_at: "2026-11-03T08:00:00+08:00",
  entries: [
    {
      feature_type: "edge",
      feature_id: EDGE.escalator,
      is_open: false,
      note: "Escalator under maintenance",
      valid_from: "2026-11-03T07:00:00+08:00",
      valid_until: "2026-11-03T18:00:00+08:00",
    },
    {
      feature_type: "node",
      feature_id: NODE.northBridgeRoadExit,
      is_open: false,
      note: null,
      valid_from: "2026-11-01T00:00:00+08:00",
      valid_until: null,
    },
  ],
};

/** A structural diff: a new walkway, a moved node, a removed POI, a level's measured height and a new anchor with an LTA street prior. */
export const diff: ChangeSetDiff = [
  {
    op: "add",
    feature_type: "space",
    id: "30000000-0000-0000-0000-000000000003",
    base_rev: null,
    before: null,
    after: {
      level_id: LEVEL.funanB2,
      kind: "walkway",
      name: null,
      geom: {
        type: "Polygon",
        coordinates: [
          [
            [103.8504, 1.2911],
            [103.8506, 1.2911],
            [103.8506, 1.2916],
            [103.8504, 1.2916],
            [103.8504, 1.2911],
          ],
        ],
      },
    },
  },
  {
    op: "modify",
    feature_type: "node",
    id: NODE.funanB2Junction,
    base_rev: 3,
    before: {
      level_id: LEVEL.funanB2,
      kind: "junction",
      name: null,
      street_name: null,
      connector_id: null,
      elevation_m: null,
      geom: { type: "Point", coordinates: [103.8504, 1.2916] },
    },
    after: {
      level_id: LEVEL.funanB2,
      kind: "junction",
      name: null,
      street_name: null,
      connector_id: null,
      elevation_m: null,
      geom: { type: "Point", coordinates: [103.85041, 1.29162] },
    },
  },
  {
    op: "remove",
    feature_type: "poi",
    id: POI.funanB2Toilet,
    base_rev: 1,
    before: {
      space_id: SPACE.funanB2Toilet,
      level_id: LEVEL.funanB2,
      name: "Toilets",
      category: "toilet",
      geom: { type: "Point", coordinates: [103.8496, 1.2912] },
    },
    after: null,
  },
  {
    op: "modify",
    feature_type: "level",
    id: LEVEL.cityHallConcourse,
    base_rev: 1,
    before: {
      venue_id: VENUE.cityHallMrt,
      ordinal: -2,
      name: "Concourse",
      elevation_m: null,
      sort_key: 0,
    },
    after: {
      venue_id: VENUE.cityHallMrt,
      ordinal: -2,
      name: "Concourse",
      elevation_m: -8.2,
      sort_key: 0,
    },
  },
  {
    op: "add",
    feature_type: "anchor",
    id: ANCHOR.northBridgeRoadExitB,
    base_rev: null,
    before: null,
    after: {
      node_id: NODE.northBridgeRoadExit,
      kind: "floor_point",
      name: "North Bridge Road exit B threshold",
      level_id: null,
      facing_deg: 352.5,
      surveyed_geom: { type: "Point", coordinates: [103.8506, 1.2916] },
      prior_source: "lta_exit",
      prior_sigma_m: 3,
      photo_uri: "anchor-photos/80000000-0000-0000-0000-000000000001.jpg",
    },
  },
];
