// The demo dataset: made-up map data at plausible City Hall cluster positions, for trying the
// stack end to end on the owner's PC (`pnpm demo`). Not a survey: names start with "Demo:", the
// layout, hours and street ids are invented, nothing was recorded in a venue, and latest.json says
// `demo: true`. It is kept apart from the real seed data (db/seed/core-venues.ts).
//
// It goes through the real path: the demo owner (tier owner); venues and levels through the seed
// script's mechanism; a few synthetic footpaths in the street tables, standing in for the OSM
// import; and everything else as one owner_mapper change set (a manual edit, no captures), whose
// diff this file builds. Every id is fixed, so a run after `pnpm demo --reset` publishes the same
// bytes.
//
// Funan B2 runs through the underground link to City Hall MRT's concourse (fare gates, a paid
// area), then up a ramp to Raffles City B1. An escalator joins Funan B2 and B1. Exit B (North
// Bridge Road) is up stairs from Funan B1, Exit A (Stamford Road) up stairs from the concourse, and
// the Raffles City entrance (North Bridge Road) up stairs from its B1.

import type {
  ChangeSetDiff,
  EdgeRow,
  LinearRing,
  LineStringGeometry,
  NodeRow,
  PoiRow,
  PolygonGeometry,
  SpaceRow,
} from "@usg/contracts";
import { DEMO_CHANGE_SET, DEMO_OWNER } from "@usg/db/demo";
import type { SeedDataset } from "@usg/db/seed";

type LonLat = [number, number];

/**
 * The demo's own owner contributor, whose presence marks a database that holds the demo, and the one
 * change set the demo publishes: in @usg/db/demo, where the seed script reads them too.
 */
export { DEMO_CHANGE_SET, DEMO_OWNER };
export const DEMO_OWNER_NAME = "Demo: owner";

export const DEMO_NOTE = "Demo: synthetic map data for local testing (pnpm demo)";

export const DEMO_VENUE = {
  funan: "de100000-0000-4000-8000-000000000001",
  cityHall: "de100000-0000-4000-8000-000000000002",
  rafflesCity: "de100000-0000-4000-8000-000000000003",
} as const;

export const DEMO_LEVEL = {
  funanB2: "de200000-0000-4000-8000-000000000001",
  funanB1: "de200000-0000-4000-8000-000000000002",
  cityHallConcourse: "de200000-0000-4000-8000-000000000003",
  rafflesCityB1: "de200000-0000-4000-8000-000000000004",
} as const;

const SPACE = {
  funanB2Walkway: "de300000-0000-4000-8000-000000000001",
  funanB2Toilets: "de300000-0000-4000-8000-000000000002",
  funanB1Walkway: "de300000-0000-4000-8000-000000000003",
  funanB1Bookshop: "de300000-0000-4000-8000-000000000004",
  cityHallLink: "de300000-0000-4000-8000-000000000005",
  cityHallConcourse: "de300000-0000-4000-8000-000000000006",
  cityHallPaidArea: "de300000-0000-4000-8000-000000000007",
  rafflesCityB1Walkway: "de300000-0000-4000-8000-000000000008",
  rafflesCityBakery: "de300000-0000-4000-8000-000000000009",
} as const;

export const DEMO_NODE = {
  funanB2Junction: "de400000-0000-4000-8000-000000000001",
  funanB2Escalator: "de400000-0000-4000-8000-000000000002",
  funanB1Escalator: "de400000-0000-4000-8000-000000000003",
  funanB1Stairs: "de400000-0000-4000-8000-000000000004",
  exitB: "de400000-0000-4000-8000-000000000005",
  cityHallJunction: "de400000-0000-4000-8000-000000000006",
  cityHallFareGates: "de400000-0000-4000-8000-000000000007",
  cityHallPaidJunction: "de400000-0000-4000-8000-000000000008",
  cityHallStairs: "de400000-0000-4000-8000-000000000009",
  exitA: "de400000-0000-4000-8000-00000000000a",
  cityHallRamp: "de400000-0000-4000-8000-00000000000b",
  rafflesCityRamp: "de400000-0000-4000-8000-00000000000c",
  rafflesCityJunction: "de400000-0000-4000-8000-00000000000d",
  rafflesCityStairs: "de400000-0000-4000-8000-00000000000e",
  rafflesCityEntrance: "de400000-0000-4000-8000-00000000000f",
} as const;

const EDGE = {
  funanB2Walk: "de500000-0000-4000-8000-000000000001",
  funanEscalator: "de500000-0000-4000-8000-000000000002",
  funanB1Walk: "de500000-0000-4000-8000-000000000003",
  exitBStairs: "de500000-0000-4000-8000-000000000004",
  link: "de500000-0000-4000-8000-000000000005",
  toFareGates: "de500000-0000-4000-8000-000000000006",
  paidArea: "de500000-0000-4000-8000-000000000007",
  toExitAStairs: "de500000-0000-4000-8000-000000000008",
  exitAStairs: "de500000-0000-4000-8000-000000000009",
  toRamp: "de500000-0000-4000-8000-00000000000a",
  ramp: "de500000-0000-4000-8000-00000000000b",
  rafflesCityWalk: "de500000-0000-4000-8000-00000000000c",
  toEntranceStairs: "de500000-0000-4000-8000-00000000000d",
  entranceStairs: "de500000-0000-4000-8000-00000000000e",
} as const;

const POI = {
  toilets: "de600000-0000-4000-8000-000000000001",
  bookshop: "de600000-0000-4000-8000-000000000002",
  atm: "de600000-0000-4000-8000-000000000003",
  bakery: "de600000-0000-4000-8000-000000000004",
  pharmacy: "de600000-0000-4000-8000-000000000005",
} as const;

/** connector_id: the landings of one physical escalator, flight of stairs or ramp. */
const PHYSICAL = {
  funanEscalator: "de900000-0000-4000-8000-000000000001",
  exitBStairs: "de900000-0000-4000-8000-000000000002",
  exitAStairs: "de900000-0000-4000-8000-000000000003",
  ramp: "de900000-0000-4000-8000-000000000004",
  entranceStairs: "de900000-0000-4000-8000-000000000005",
} as const;

/** Made-up OpenStreetMap-style ids, far above any real OSM id, so they can't be mistaken for one. */
export const DEMO_STREET_NODE = {
  exitB: 900_000_000_001,
  exitA: 900_000_000_002,
  crossing: 900_000_000_003,
  rafflesCity: 900_000_000_004,
} as const;

export const DEMO_STREET_WAY = {
  northBridgeRoad: 900_000_000_101,
  crossing: 900_000_000_102,
} as const;

/** A counterclockwise rectangle as a closed ring. */
function rectangle(west: number, south: number, east: number, north: number): LonLat[] {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

const polygon = (ring: LonLat[]): PolygonGeometry => ({
  type: "Polygon",
  coordinates: [ring as LinearRing],
});
const footprint = (ring: LonLat[]) => ({ type: "MultiPolygon" as const, coordinates: [[ring]] });

/** Venues and levels, through the seed script's mechanism. */
export const DEMO_SEED: SeedDataset = {
  name: "demo venues",
  venues: [
    {
      id: DEMO_VENUE.funan,
      name: "Demo: Funan",
      kind: "mall",
      operator: null,
      permission: null,
      footprint: footprint(rectangle(103.8492, 1.2905, 103.8507, 1.292)),
      levels: [
        { id: DEMO_LEVEL.funanB2, name: "B2", ordinal: -2, sort_key: 0 },
        { id: DEMO_LEVEL.funanB1, name: "B1", ordinal: -1, sort_key: 0 },
      ],
    },
    {
      id: DEMO_VENUE.cityHall,
      name: "Demo: City Hall MRT",
      kind: "mrt_station",
      operator: null,
      permission: null,
      footprint: footprint(rectangle(103.8508, 1.2912, 103.8526, 1.2934)),
      levels: [{ id: DEMO_LEVEL.cityHallConcourse, name: "Concourse", ordinal: -2, sort_key: 0 }],
    },
    {
      id: DEMO_VENUE.rafflesCity,
      name: "Demo: Raffles City",
      kind: "mall",
      operator: null,
      permission: null,
      footprint: footprint(rectangle(103.8523, 1.2933, 103.854, 1.295)),
      levels: [{ id: DEMO_LEVEL.rafflesCityB1, name: "B1", ordinal: -1, sort_key: 0 }],
    },
  ],
};

/** The synthetic footpaths, standing in for the OSM import, near the three street exits. */
export const DEMO_STREET = {
  nodes: [
    { id: DEMO_STREET_NODE.exitB, at: [103.8507, 1.29195] as LonLat },
    { id: DEMO_STREET_NODE.exitA, at: [103.8513, 1.2923] as LonLat },
    { id: DEMO_STREET_NODE.crossing, at: [103.8517, 1.2932] as LonLat },
    { id: DEMO_STREET_NODE.rafflesCity, at: [103.8522, 1.294] as LonLat },
  ],
  edges: [
    {
      way: DEMO_STREET_WAY.northBridgeRoad,
      from: DEMO_STREET_NODE.exitB,
      to: DEMO_STREET_NODE.exitA,
      tags: { highway: "footway", footway: "sidewalk" },
      covered: false,
    },
    {
      way: DEMO_STREET_WAY.northBridgeRoad,
      from: DEMO_STREET_NODE.exitA,
      to: DEMO_STREET_NODE.crossing,
      tags: { highway: "footway", footway: "sidewalk" },
      covered: true,
    },
    {
      way: DEMO_STREET_WAY.crossing,
      from: DEMO_STREET_NODE.crossing,
      to: DEMO_STREET_NODE.rafflesCity,
      tags: { highway: "footway", footway: "crossing" },
      covered: false,
    },
  ],
} as const;

const AT: Record<string, LonLat> = {
  [DEMO_NODE.funanB2Junction]: [103.8503, 1.2914],
  [DEMO_NODE.funanB2Escalator]: [103.8498, 1.2913],
  [DEMO_NODE.funanB1Escalator]: [103.84985, 1.29135],
  [DEMO_NODE.funanB1Stairs]: [103.8504, 1.2917],
  [DEMO_NODE.exitB]: [103.8506, 1.2919],
  [DEMO_NODE.cityHallJunction]: [103.8516, 1.2927],
  [DEMO_NODE.cityHallFareGates]: [103.8519, 1.2929],
  [DEMO_NODE.cityHallPaidJunction]: [103.8522, 1.2928],
  [DEMO_NODE.cityHallStairs]: [103.8514, 1.2925],
  [DEMO_NODE.exitA]: [103.85135, 1.29235],
  [DEMO_NODE.cityHallRamp]: [103.852, 1.2932],
  [DEMO_NODE.rafflesCityRamp]: [103.8524, 1.2935],
  [DEMO_NODE.rafflesCityJunction]: [103.8528, 1.2938],
  [DEMO_NODE.rafflesCityStairs]: [103.8525, 1.294],
  [DEMO_NODE.rafflesCityEntrance]: [103.8523, 1.294],
};

function at(id: string): LonLat {
  const position = AT[id];
  if (position === undefined) throw new Error(`no position for ${id}`);
  return position;
}

const spaces: [string, SpaceRow][] = [
  [
    SPACE.funanB2Walkway,
    {
      level_id: DEMO_LEVEL.funanB2,
      kind: "walkway",
      name: null,
      geom: polygon(rectangle(103.8496, 1.2911, 103.8506, 1.2916)),
    },
  ],
  [
    SPACE.funanB2Toilets,
    {
      level_id: DEMO_LEVEL.funanB2,
      kind: "toilet",
      name: "Demo: Toilets",
      geom: polygon(rectangle(103.84945, 1.2911, 103.8496, 1.29125)),
    },
  ],
  [
    SPACE.funanB1Walkway,
    {
      level_id: DEMO_LEVEL.funanB1,
      kind: "walkway",
      name: null,
      geom: polygon(rectangle(103.8496, 1.2912, 103.8506, 1.2918)),
    },
  ],
  [
    SPACE.funanB1Bookshop,
    {
      level_id: DEMO_LEVEL.funanB1,
      kind: "shop",
      name: "Demo: Bookshop",
      geom: polygon(rectangle(103.8497, 1.2918, 103.8501, 1.29195)),
    },
  ],
  [
    SPACE.cityHallLink,
    {
      level_id: DEMO_LEVEL.cityHallConcourse,
      kind: "walkway",
      name: "Demo: Funan link",
      geom: polygon([
        [103.8503, 1.29125],
        [103.8517, 1.2925],
        [103.8515, 1.2928],
        [103.8502, 1.29155],
        [103.8503, 1.29125],
      ]),
    },
  ],
  [
    SPACE.cityHallConcourse,
    {
      level_id: DEMO_LEVEL.cityHallConcourse,
      kind: "concourse",
      name: "Demo: City Hall concourse",
      geom: polygon(rectangle(103.8512, 1.2923, 103.8521, 1.2933)),
    },
  ],
  [
    SPACE.cityHallPaidArea,
    {
      level_id: DEMO_LEVEL.cityHallConcourse,
      kind: "fare_zone",
      name: null,
      geom: polygon(rectangle(103.8521, 1.2925, 103.8525, 1.2931)),
    },
  ],
  [
    SPACE.rafflesCityB1Walkway,
    {
      level_id: DEMO_LEVEL.rafflesCityB1,
      kind: "walkway",
      name: null,
      geom: polygon(rectangle(103.8523, 1.2934, 103.8533, 1.2942)),
    },
  ],
  [
    SPACE.rafflesCityBakery,
    {
      level_id: DEMO_LEVEL.rafflesCityB1,
      kind: "shop",
      name: "Demo: Bakery",
      geom: polygon(rectangle(103.853, 1.2942, 103.8533, 1.2944)),
    },
  ],
];

type NodeInput = Partial<Omit<NodeRow, "geom">> & Pick<NodeRow, "kind">;

const nodes: [string, NodeInput][] = [
  [DEMO_NODE.funanB2Junction, { level_id: DEMO_LEVEL.funanB2, kind: "junction" }],
  [
    DEMO_NODE.funanB2Escalator,
    { level_id: DEMO_LEVEL.funanB2, kind: "escalator", connector_id: PHYSICAL.funanEscalator },
  ],
  [
    DEMO_NODE.funanB1Escalator,
    { level_id: DEMO_LEVEL.funanB1, kind: "escalator", connector_id: PHYSICAL.funanEscalator },
  ],
  [
    DEMO_NODE.funanB1Stairs,
    { level_id: DEMO_LEVEL.funanB1, kind: "stairs", connector_id: PHYSICAL.exitBStairs },
  ],
  [
    DEMO_NODE.exitB,
    {
      kind: "exit",
      name: "Demo: Exit B",
      street_name: "North Bridge Road",
      connector_id: PHYSICAL.exitBStairs,
    },
  ],
  [DEMO_NODE.cityHallJunction, { level_id: DEMO_LEVEL.cityHallConcourse, kind: "junction" }],
  [
    DEMO_NODE.cityHallFareGates,
    { level_id: DEMO_LEVEL.cityHallConcourse, kind: "fare_gate", name: "Demo: Fare gates" },
  ],
  [DEMO_NODE.cityHallPaidJunction, { level_id: DEMO_LEVEL.cityHallConcourse, kind: "junction" }],
  [
    DEMO_NODE.cityHallStairs,
    { level_id: DEMO_LEVEL.cityHallConcourse, kind: "stairs", connector_id: PHYSICAL.exitAStairs },
  ],
  [
    DEMO_NODE.exitA,
    {
      kind: "exit",
      name: "Demo: Exit A",
      street_name: "Stamford Road",
      connector_id: PHYSICAL.exitAStairs,
    },
  ],
  [
    DEMO_NODE.cityHallRamp,
    { level_id: DEMO_LEVEL.cityHallConcourse, kind: "ramp", connector_id: PHYSICAL.ramp },
  ],
  [
    DEMO_NODE.rafflesCityRamp,
    { level_id: DEMO_LEVEL.rafflesCityB1, kind: "ramp", connector_id: PHYSICAL.ramp },
  ],
  [DEMO_NODE.rafflesCityJunction, { level_id: DEMO_LEVEL.rafflesCityB1, kind: "junction" }],
  [
    DEMO_NODE.rafflesCityStairs,
    { level_id: DEMO_LEVEL.rafflesCityB1, kind: "stairs", connector_id: PHYSICAL.entranceStairs },
  ],
  [
    DEMO_NODE.rafflesCityEntrance,
    {
      kind: "entrance",
      name: "Demo: Raffles City entrance",
      street_name: "North Bridge Road",
      connector_id: PHYSICAL.entranceStairs,
    },
  ],
];

type EdgeInput = Pick<EdgeRow, "from_node" | "to_node" | "kind"> &
  Partial<Omit<EdgeRow, "from_node" | "to_node" | "kind" | "length_m" | "geom">> & {
    /** A centreline through these points between the two nodes; a straight line otherwise. */
    readonly via?: LonLat[];
  };

const OPEN_LATE = "Mo-Su 06:00-24:00";
const MALL_HOURS = "Mo-Su 10:00-22:00";

const edges: [string, EdgeInput][] = [
  [
    EDGE.funanB2Walk,
    {
      from_node: DEMO_NODE.funanB2Escalator,
      to_node: DEMO_NODE.funanB2Junction,
      kind: "walk",
      level_id: DEMO_LEVEL.funanB2,
    },
  ],
  [
    EDGE.funanEscalator,
    {
      from_node: DEMO_NODE.funanB2Escalator,
      to_node: DEMO_NODE.funanB1Escalator,
      kind: "escalator",
      oneway: true,
      opening_hours: MALL_HOURS,
      connector_id: PHYSICAL.funanEscalator,
    },
  ],
  [
    EDGE.funanB1Walk,
    {
      from_node: DEMO_NODE.funanB1Escalator,
      to_node: DEMO_NODE.funanB1Stairs,
      kind: "walk",
      level_id: DEMO_LEVEL.funanB1,
    },
  ],
  [
    EDGE.exitBStairs,
    {
      from_node: DEMO_NODE.funanB1Stairs,
      to_node: DEMO_NODE.exitB,
      kind: "stairs",
      opening_hours: OPEN_LATE,
      connector_id: PHYSICAL.exitBStairs,
    },
  ],
  [
    EDGE.link,
    {
      from_node: DEMO_NODE.funanB2Junction,
      to_node: DEMO_NODE.cityHallJunction,
      kind: "walk",
      opening_hours: OPEN_LATE,
      via: [
        [103.8508, 1.2918],
        [103.8513, 1.2923],
      ],
    },
  ],
  [
    EDGE.toFareGates,
    {
      from_node: DEMO_NODE.cityHallJunction,
      to_node: DEMO_NODE.cityHallFareGates,
      kind: "walk",
      level_id: DEMO_LEVEL.cityHallConcourse,
    },
  ],
  [
    EDGE.paidArea,
    {
      from_node: DEMO_NODE.cityHallFareGates,
      to_node: DEMO_NODE.cityHallPaidJunction,
      kind: "walk",
      access: "paid_fare_zone",
      level_id: DEMO_LEVEL.cityHallConcourse,
    },
  ],
  [
    EDGE.toExitAStairs,
    {
      from_node: DEMO_NODE.cityHallJunction,
      to_node: DEMO_NODE.cityHallStairs,
      kind: "walk",
      level_id: DEMO_LEVEL.cityHallConcourse,
    },
  ],
  [
    EDGE.exitAStairs,
    {
      from_node: DEMO_NODE.cityHallStairs,
      to_node: DEMO_NODE.exitA,
      kind: "stairs",
      opening_hours: OPEN_LATE,
      connector_id: PHYSICAL.exitAStairs,
    },
  ],
  [
    EDGE.toRamp,
    {
      from_node: DEMO_NODE.cityHallJunction,
      to_node: DEMO_NODE.cityHallRamp,
      kind: "walk",
      level_id: DEMO_LEVEL.cityHallConcourse,
    },
  ],
  [
    EDGE.ramp,
    {
      from_node: DEMO_NODE.cityHallRamp,
      to_node: DEMO_NODE.rafflesCityRamp,
      kind: "ramp",
      step_free: true,
      opening_hours: MALL_HOURS,
      connector_id: PHYSICAL.ramp,
    },
  ],
  [
    EDGE.rafflesCityWalk,
    {
      from_node: DEMO_NODE.rafflesCityRamp,
      to_node: DEMO_NODE.rafflesCityJunction,
      kind: "walk",
      level_id: DEMO_LEVEL.rafflesCityB1,
    },
  ],
  [
    EDGE.toEntranceStairs,
    {
      from_node: DEMO_NODE.rafflesCityJunction,
      to_node: DEMO_NODE.rafflesCityStairs,
      kind: "walk",
      level_id: DEMO_LEVEL.rafflesCityB1,
    },
  ],
  [
    EDGE.entranceStairs,
    {
      from_node: DEMO_NODE.rafflesCityStairs,
      to_node: DEMO_NODE.rafflesCityEntrance,
      kind: "stairs",
      opening_hours: MALL_HOURS,
      connector_id: PHYSICAL.entranceStairs,
    },
  ],
];

const pois: [string, PoiRow][] = [
  [
    POI.toilets,
    {
      space_id: SPACE.funanB2Toilets,
      level_id: DEMO_LEVEL.funanB2,
      name: "Demo: Toilets",
      category: "toilet",
      geom: { type: "Point", coordinates: [103.84952, 1.29118] },
    },
  ],
  [
    POI.bookshop,
    {
      space_id: SPACE.funanB1Bookshop,
      level_id: DEMO_LEVEL.funanB1,
      name: "Demo: Bookshop",
      category: "shop",
      geom: { type: "Point", coordinates: [103.8499, 1.29188] },
    },
  ],
  [
    POI.atm,
    {
      space_id: SPACE.cityHallConcourse,
      level_id: DEMO_LEVEL.cityHallConcourse,
      name: "Demo: ATM",
      category: "atm",
      geom: { type: "Point", coordinates: [103.8517, 1.2929] },
    },
  ],
  [
    POI.bakery,
    {
      space_id: SPACE.rafflesCityBakery,
      level_id: DEMO_LEVEL.rafflesCityB1,
      name: "Demo: Bakery",
      category: "food",
      geom: { type: "Point", coordinates: [103.85315, 1.2943] },
    },
  ],
  [
    POI.pharmacy,
    {
      space_id: null,
      level_id: DEMO_LEVEL.rafflesCityB1,
      name: "Demo: Pharmacy",
      category: "shop",
      geom: { type: "Point", coordinates: [103.8527, 1.294] },
    },
  ],
];

/** Every id the demo writes to HEAD, by table: what `pnpm demo --reset` may wipe. */
export const DEMO_IDS = {
  venues: Object.values(DEMO_VENUE),
  levels: Object.values(DEMO_LEVEL),
  spaces: spaces.map(([id]) => id),
  nodes: nodes.map(([id]) => id),
  edges: edges.map(([id]) => id),
  pois: pois.map(([id]) => id),
} as const;

/** The straight or stored centreline of each edge, from its start node to its end node. */
export function demoEdgeLines(): Map<string, LineStringGeometry> {
  const lines = new Map<string, LineStringGeometry>();
  for (const [id, edge] of edges) {
    const [first, second, ...rest]: LonLat[] = [
      at(edge.from_node),
      ...(edge.via ?? []),
      at(edge.to_node),
    ];
    if (first === undefined || second === undefined) throw new Error(`edge ${id} has no line`);
    lines.set(id, { type: "LineString", coordinates: [first, second, ...rest] });
  }
  return lines;
}

/**
 * The demo change set's diff: every space, node, edge and POI as an add. `lengths` gives each
 * edge's length in metres, measured in SVY21 by the caller (in PostGIS), rounded to 2 decimals.
 */
export function demoDiff(lengths: ReadonlyMap<string, number>): ChangeSetDiff {
  const lines = demoEdgeLines();
  const diff: ChangeSetDiff = [];
  for (const [id, after] of spaces) {
    diff.push({ op: "add", feature_type: "space", id, base_rev: null, before: null, after });
  }
  for (const [id, node] of nodes) {
    const after: NodeRow = {
      level_id: node.level_id ?? null,
      kind: node.kind,
      name: node.name ?? null,
      street_name: node.street_name ?? null,
      connector_id: node.connector_id ?? null,
      elevation_m: null,
      geom: { type: "Point", coordinates: at(id) },
    };
    diff.push({ op: "add", feature_type: "node", id, base_rev: null, before: null, after });
  }
  for (const [id, edge] of edges) {
    const length = lengths.get(id);
    if (length === undefined) throw new Error(`no length for edge ${id}`);
    const indoor = edge.kind !== "street";
    const after: EdgeRow = {
      from_node: edge.from_node,
      to_node: edge.to_node,
      kind: edge.kind,
      oneway: edge.oneway ?? false,
      access: edge.access ?? "public",
      opening_hours: edge.opening_hours ?? null,
      level_id: edge.level_id ?? null,
      connector_id: edge.connector_id ?? null,
      length_m: length,
      step_free: edge.step_free ?? (edge.kind === "walk" || edge.kind === "ramp"),
      sheltered: edge.sheltered ?? indoor,
      outdoor: edge.outdoor ?? !indoor,
      // Only the link has a centreline of its own; the rest are drawn straight.
      geom: edge.via === undefined ? null : (lines.get(id) ?? null),
    };
    diff.push({ op: "add", feature_type: "edge", id, base_rev: null, before: null, after });
  }
  for (const [id, after] of pois) {
    diff.push({ op: "add", feature_type: "poi", id, base_rev: null, before: null, after });
  }
  return diff;
}
