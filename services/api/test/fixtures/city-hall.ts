// A synthetic HEAD and street graph at real City Hall cluster coordinates (WGS84 lon/lat): Funan's
// B2 and B1 with the underground link to City Hall MRT's concourse, the concourse's fare gates and
// lift, the link into Raffles City B1, and the North Bridge Road and Stamford Road footpaths. The
// layout, names, OSM ids, hours and lengths are made up; nothing here was recorded in a venue, and
// the restricted zone is invented, never a real back-of-house outline.
//
// The snapshot builder's golden files (snapshot/indoor.json and snapshot/street.json) are built
// from it. It also plants private data that must never reach them: an anchor with a reference
// photo, a restricted zone, venues' operator and permission, a node's height and extra OSM tags.

import { line, point } from "@usg/db/test/fixtures";
import type { TestDb } from "@usg/db/test/harness";

type LonLat = readonly [number, number];

export const VENUE = {
  funan: "10000000-0000-0000-0000-000000000001",
  cityHallMrt: "10000000-0000-0000-0000-000000000002",
  rafflesCity: "10000000-0000-0000-0000-000000000003",
} as const;

export const LEVEL = {
  funanB2: "20000000-0000-0000-0000-000000000001",
  funanB1: "20000000-0000-0000-0000-000000000002",
  /** In band -2 with Funan B2, at a different height. */
  cityHallConcourse: "20000000-0000-0000-0000-000000000003",
  rafflesCityB1: "20000000-0000-0000-0000-000000000004",
} as const;

export const SPACE = {
  funanB2Walkway: "30000000-0000-0000-0000-000000000001",
  funanB2Toilet: "30000000-0000-0000-0000-000000000002",
  funanB1Walkway: "30000000-0000-0000-0000-000000000003",
  cityHallConcourse: "30000000-0000-0000-0000-000000000004",
  cityHallPaidArea: "30000000-0000-0000-0000-000000000005",
  rafflesCityB1Walkway: "30000000-0000-0000-0000-000000000006",
} as const;

export const NODE = {
  funanB2Junction: "40000000-0000-0000-0000-000000000001",
  funanB2Escalator: "40000000-0000-0000-0000-000000000002",
  funanB1Escalator: "40000000-0000-0000-0000-000000000003",
  funanB1Stairs: "40000000-0000-0000-0000-000000000004",
  northBridgeRoadExit: "40000000-0000-0000-0000-000000000005",
  cityHallJunction: "40000000-0000-0000-0000-000000000006",
  cityHallFareGates: "40000000-0000-0000-0000-000000000007",
  cityHallPaidJunction: "40000000-0000-0000-0000-000000000008",
  cityHallLiftConcourse: "40000000-0000-0000-0000-000000000009",
  cityHallLiftStreet: "40000000-0000-0000-0000-000000000010",
  cityHallExitA: "40000000-0000-0000-0000-000000000011",
  rafflesCityDoor: "40000000-0000-0000-0000-000000000012",
  rafflesCityRamp: "40000000-0000-0000-0000-000000000013",
  rafflesCityEntrance: "40000000-0000-0000-0000-000000000014",
} as const;

export const EDGE = {
  /** Stored reversed (from funanB2Junction): the builder turns it round. */
  funanB2Walk: "50000000-0000-0000-0000-000000000001",
  /** One-way, no stored line. */
  funanEscalatorUp: "50000000-0000-0000-0000-000000000002",
  /** Stored with ends a little off its nodes: the builder sets them to the nodes' points. */
  exitBStairs: "50000000-0000-0000-0000-000000000003",
  funanB1Walk: "50000000-0000-0000-0000-000000000004",
  /** The underground link from Funan B2 to City Hall's concourse, with a stored centreline. */
  funanCityHallLink: "50000000-0000-0000-0000-000000000005",
  cityHallToFareGates: "50000000-0000-0000-0000-000000000006",
  /** Through the fare gates: MRT paid area. */
  cityHallPaidWalk: "50000000-0000-0000-0000-000000000007",
  cityHallToLift: "50000000-0000-0000-0000-000000000008",
  /** Both landings at one point. */
  cityHallLift: "50000000-0000-0000-0000-000000000009",
  /** An outdoor link the owner maps where OSM has no footpath. */
  exitAStreet: "50000000-0000-0000-0000-000000000010",
  cityHallRafflesCityLink: "50000000-0000-0000-0000-000000000011",
  rafflesCityCustomersOnly: "50000000-0000-0000-0000-000000000012",
  rafflesCityRamp: "50000000-0000-0000-0000-000000000013",
} as const;

export const POI = {
  funanToilets: "60000000-0000-0000-0000-000000000001",
  cityHallAtm: "60000000-0000-0000-0000-000000000002",
  rafflesCityFood: "60000000-0000-0000-0000-000000000003",
} as const;

/** connector_id: the landings of one physical escalator, flight of stairs, lift or ramp. */
export const PHYSICAL = {
  funanEscalator: "90000000-0000-0000-0000-000000000001",
  exitBStairs: "90000000-0000-0000-0000-000000000002",
  cityHallLift: "90000000-0000-0000-0000-000000000003",
  rafflesCityRamp: "90000000-0000-0000-0000-000000000004",
} as const;

/** Made-up OpenStreetMap ids, above 2^32 so bigints are exercised. */
export const OSM_NODE = {
  exitB: 7_000_000_001,
  northBridgeRoad: 7_000_000_002,
  exitA: 7_000_000_003,
  stamfordRoadCrossing: 7_000_000_004,
  coveredWalkway: 7_000_000_005,
  rafflesCityEntrance: 7_000_000_006,
  stepsTop: 7_000_000_007,
} as const;

export const OSM_WAY = {
  northBridgeRoadSidewalk: 8_000_000_001,
  crossing: 8_000_000_002,
  coveredWalkway: 8_000_000_003,
  steps: 8_000_000_004,
} as const;

/** Private data planted in HEAD; none of it may appear in a public file. */
export const PRIVATE = {
  anchorId: "80000000-0000-0000-0000-000000000001",
  anchorName: "North Bridge Road exit B threshold (synthetic)",
  anchorPhotoUri: "anchor-photos/80000000-0000-0000-0000-000000000001.jpg",
  operator: "Synthetic Landlord Pte Ltd",
  permission: "permission-letter-SYNTHETIC-0001",
  zoneId: "a0000000-0000-0000-0000-000000000001",
  zoneNote: "plant room (synthetic)",
  /** A corner of the zone: a coordinate no public feature uses. */
  zoneCorner: 103.8493123,
  /** nodes.elevation_m of cityHallJunction: private, unlike levels.elevation_m. */
  nodeElevation: -8.15,
  /** OSM tags other than highway and footway. */
  osmTagValues: ["paving_stones", "traffic_signals", "North Bridge Road footpath (synthetic)"],
} as const;

/** A polygon (one ring, closed here) as EWKT. */
function polygon(...ring: LonLat[]): string {
  const closed = [...ring, ring[0] as LonLat];
  return `SRID=4326;POLYGON((${closed.map(([lon, lat]) => `${lon} ${lat}`).join(", ")}))`;
}

/** A one-polygon MultiPolygon as EWKT. */
function multiPolygon(...ring: LonLat[]): string {
  return polygon(...ring)
    .replace("POLYGON((", "MULTIPOLYGON(((")
    .replace(/\)\)$/, ")))");
}

/** A counterclockwise rectangle. */
function rectangle(west: number, south: number, east: number, north: number): LonLat[] {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
  ];
}

const AT = {
  [NODE.funanB2Junction]: [103.8502, 1.2914],
  [NODE.funanB2Escalator]: [103.8498, 1.2913],
  [NODE.funanB1Escalator]: [103.84985, 1.29135],
  [NODE.funanB1Stairs]: [103.8504, 1.2917],
  [NODE.northBridgeRoadExit]: [103.8506, 1.2919],
  [NODE.cityHallJunction]: [103.8517, 1.2928],
  [NODE.cityHallFareGates]: [103.8521, 1.293],
  [NODE.cityHallPaidJunction]: [103.8523, 1.2932],
  [NODE.cityHallLiftConcourse]: [103.8514, 1.2925],
  [NODE.cityHallLiftStreet]: [103.8514, 1.2925],
  [NODE.cityHallExitA]: [103.85135, 1.29245],
  [NODE.rafflesCityDoor]: [103.8525, 1.2934],
  [NODE.rafflesCityRamp]: [103.853, 1.2939],
  [NODE.rafflesCityEntrance]: [103.8531, 1.2941],
} as const satisfies Record<string, LonLat>;

const STREET_AT = {
  [OSM_NODE.exitB]: [103.8507, 1.29195],
  [OSM_NODE.northBridgeRoad]: [103.8511, 1.2923],
  [OSM_NODE.exitA]: [103.8513, 1.2924],
  [OSM_NODE.stamfordRoadCrossing]: [103.8519, 1.29365],
  [OSM_NODE.coveredWalkway]: [103.8525, 1.294],
  [OSM_NODE.rafflesCityEntrance]: [103.8531, 1.29425],
  [OSM_NODE.stepsTop]: [103.8505, 1.2924],
} as const satisfies Record<number, LonLat>;

const venues = [
  {
    id: VENUE.funan,
    name: "Funan",
    kind: "mall",
    footprint: multiPolygon(...rectangle(103.8492, 1.2905, 103.8507, 1.292)),
  },
  {
    id: VENUE.cityHallMrt,
    name: "City Hall MRT",
    kind: "mrt_station",
    // Clockwise: the builder writes it counterclockwise.
    footprint: multiPolygon(
      [103.8512, 1.2922],
      [103.8512, 1.2936],
      [103.8528, 1.2936],
      [103.8528, 1.2922],
    ),
  },
  { id: VENUE.rafflesCity, name: "Raffles City", kind: "mall", footprint: null },
];

const levels = [
  { id: LEVEL.funanB2, venue: VENUE.funan, ordinal: -2, name: "B2", elevation: -9.5, sortKey: 0 },
  { id: LEVEL.funanB1, venue: VENUE.funan, ordinal: -1, name: "B1", elevation: -4.5, sortKey: 0 },
  {
    id: LEVEL.cityHallConcourse,
    venue: VENUE.cityHallMrt,
    ordinal: -2,
    name: "Concourse",
    elevation: -8.2,
    sortKey: 0,
  },
  {
    id: LEVEL.rafflesCityB1,
    venue: VENUE.rafflesCity,
    ordinal: -1,
    name: "B1",
    elevation: null,
    sortKey: 0,
  },
];

const spaces = [
  {
    id: SPACE.funanB2Walkway,
    level: LEVEL.funanB2,
    kind: "walkway",
    name: null,
    // Clockwise: the builder writes it counterclockwise.
    geom: polygon([103.8496, 1.2911], [103.8496, 1.2916], [103.8506, 1.2916], [103.8506, 1.2911]),
  },
  {
    id: SPACE.funanB2Toilet,
    level: LEVEL.funanB2,
    kind: "toilet",
    name: "Toilets",
    geom: polygon(...rectangle(103.84945, 1.2911, 103.8496, 1.29125)),
  },
  {
    id: SPACE.funanB1Walkway,
    level: LEVEL.funanB1,
    kind: "walkway",
    // Empty text is written as null.
    name: "",
    geom: polygon(...rectangle(103.8496, 1.2912, 103.8506, 1.2918)),
  },
  {
    id: SPACE.cityHallConcourse,
    level: LEVEL.cityHallConcourse,
    kind: "concourse",
    name: "City Hall Concourse",
    geom: polygon(...rectangle(103.8513, 1.2924, 103.8521, 1.2931)),
  },
  {
    id: SPACE.cityHallPaidArea,
    level: LEVEL.cityHallConcourse,
    kind: "fare_zone",
    name: null,
    geom: polygon(...rectangle(103.8521, 1.2929, 103.8527, 1.2935)),
  },
  {
    id: SPACE.rafflesCityB1Walkway,
    level: LEVEL.rafflesCityB1,
    kind: "walkway",
    name: null,
    geom: polygon(...rectangle(103.8524, 1.2932, 103.8532, 1.294)),
  },
];

const nodes = [
  { id: NODE.funanB2Junction, level: LEVEL.funanB2, kind: "junction" },
  {
    id: NODE.funanB2Escalator,
    level: LEVEL.funanB2,
    kind: "escalator",
    connector: PHYSICAL.funanEscalator,
  },
  {
    id: NODE.funanB1Escalator,
    level: LEVEL.funanB1,
    kind: "escalator",
    connector: PHYSICAL.funanEscalator,
  },
  { id: NODE.funanB1Stairs, level: LEVEL.funanB1, kind: "stairs", connector: PHYSICAL.exitBStairs },
  {
    id: NODE.northBridgeRoadExit,
    level: null,
    kind: "exit",
    name: "Exit B",
    streetName: "North Bridge Road",
    connector: PHYSICAL.exitBStairs,
  },
  {
    id: NODE.cityHallJunction,
    level: LEVEL.cityHallConcourse,
    kind: "junction",
    elevation: PRIVATE.nodeElevation,
  },
  {
    id: NODE.cityHallFareGates,
    level: LEVEL.cityHallConcourse,
    kind: "fare_gate",
    name: "Fare gates",
  },
  { id: NODE.cityHallPaidJunction, level: LEVEL.cityHallConcourse, kind: "junction" },
  {
    id: NODE.cityHallLiftConcourse,
    level: LEVEL.cityHallConcourse,
    kind: "lift",
    connector: PHYSICAL.cityHallLift,
  },
  { id: NODE.cityHallLiftStreet, level: null, kind: "lift", connector: PHYSICAL.cityHallLift },
  {
    id: NODE.cityHallExitA,
    level: null,
    kind: "exit",
    name: "Exit A",
    streetName: "Stamford Road",
  },
  { id: NODE.rafflesCityDoor, level: LEVEL.rafflesCityB1, kind: "door", name: "Raffles City" },
  {
    id: NODE.rafflesCityRamp,
    level: LEVEL.rafflesCityB1,
    kind: "ramp",
    connector: PHYSICAL.rafflesCityRamp,
  },
  {
    id: NODE.rafflesCityEntrance,
    level: null,
    kind: "entrance",
    streetName: "North Bridge Road",
    connector: PHYSICAL.rafflesCityRamp,
  },
] satisfies {
  id: keyof typeof AT;
  level: string | null;
  kind: string;
  name?: string;
  streetName?: string;
  connector?: string;
  elevation?: number;
}[];

interface EdgeRow {
  id: string;
  from: keyof typeof AT;
  to: keyof typeof AT;
  kind: string;
  level: string | null;
  connector?: string;
  oneway?: boolean;
  access?: string;
  hours?: string;
  /** Metres, or measured in SVY21 along the line (the stored one, or between the nodes). */
  length: number | "measured";
  stepFree: boolean;
  sheltered: boolean;
  outdoor: boolean;
  geom?: string;
}

const edges: EdgeRow[] = [
  {
    id: EDGE.funanB2Walk,
    from: NODE.funanB2Escalator,
    to: NODE.funanB2Junction,
    kind: "walk",
    level: LEVEL.funanB2,
    length: "measured",
    stepFree: true,
    sheltered: true,
    outdoor: false,
    geom: line(AT[NODE.funanB2Junction], [103.85, 1.29145], AT[NODE.funanB2Escalator]),
  },
  {
    id: EDGE.funanEscalatorUp,
    from: NODE.funanB2Escalator,
    to: NODE.funanB1Escalator,
    kind: "escalator",
    level: null,
    connector: PHYSICAL.funanEscalator,
    oneway: true,
    hours: "Mo-Su 10:00-22:00",
    length: 9.6,
    stepFree: false,
    sheltered: true,
    outdoor: false,
  },
  {
    id: EDGE.exitBStairs,
    from: NODE.funanB1Stairs,
    to: NODE.northBridgeRoadExit,
    kind: "stairs",
    level: null,
    connector: PHYSICAL.exitBStairs,
    hours: "Mo-Su 06:00-24:00",
    length: "measured",
    stepFree: false,
    sheltered: true,
    outdoor: false,
    geom: line([103.85041, 1.29171], [103.85052, 1.2918], [103.85059, 1.29189]),
  },
  {
    id: EDGE.funanB1Walk,
    from: NODE.funanB1Escalator,
    to: NODE.funanB1Stairs,
    kind: "walk",
    level: LEVEL.funanB1,
    length: "measured",
    stepFree: true,
    sheltered: true,
    outdoor: false,
  },
  {
    id: EDGE.funanCityHallLink,
    from: NODE.funanB2Junction,
    to: NODE.cityHallJunction,
    kind: "walk",
    level: null,
    hours: "Mo-Su 06:00-24:00",
    length: "measured",
    stepFree: true,
    sheltered: true,
    outdoor: false,
    geom: line(
      AT[NODE.funanB2Junction],
      [103.8508, 1.2921],
      [103.8514, 1.2926],
      AT[NODE.cityHallJunction],
    ),
  },
  {
    id: EDGE.cityHallToFareGates,
    from: NODE.cityHallJunction,
    to: NODE.cityHallFareGates,
    kind: "walk",
    level: LEVEL.cityHallConcourse,
    length: "measured",
    stepFree: true,
    sheltered: true,
    outdoor: false,
  },
  {
    id: EDGE.cityHallPaidWalk,
    from: NODE.cityHallFareGates,
    to: NODE.cityHallPaidJunction,
    kind: "walk",
    level: LEVEL.cityHallConcourse,
    access: "paid_fare_zone",
    length: "measured",
    stepFree: true,
    sheltered: true,
    outdoor: false,
  },
  {
    id: EDGE.cityHallToLift,
    from: NODE.cityHallJunction,
    to: NODE.cityHallLiftConcourse,
    kind: "walk",
    level: LEVEL.cityHallConcourse,
    length: "measured",
    stepFree: true,
    sheltered: true,
    outdoor: false,
  },
  {
    id: EDGE.cityHallLift,
    from: NODE.cityHallLiftConcourse,
    to: NODE.cityHallLiftStreet,
    kind: "lift",
    level: null,
    connector: PHYSICAL.cityHallLift,
    length: 8.2,
    stepFree: true,
    sheltered: true,
    outdoor: false,
  },
  {
    id: EDGE.exitAStreet,
    from: NODE.cityHallLiftStreet,
    to: NODE.cityHallExitA,
    kind: "street",
    level: null,
    length: "measured",
    stepFree: true,
    sheltered: false,
    outdoor: true,
  },
  {
    id: EDGE.cityHallRafflesCityLink,
    from: NODE.cityHallJunction,
    to: NODE.rafflesCityDoor,
    kind: "walk",
    level: null,
    hours: "Mo-Su 10:00-22:00",
    length: "measured",
    stepFree: true,
    sheltered: true,
    outdoor: false,
  },
  {
    id: EDGE.rafflesCityCustomersOnly,
    from: NODE.rafflesCityDoor,
    to: NODE.rafflesCityRamp,
    kind: "walk",
    level: LEVEL.rafflesCityB1,
    access: "customers_only",
    length: "measured",
    stepFree: true,
    sheltered: true,
    outdoor: false,
  },
  {
    id: EDGE.rafflesCityRamp,
    from: NODE.rafflesCityRamp,
    to: NODE.rafflesCityEntrance,
    kind: "ramp",
    level: null,
    connector: PHYSICAL.rafflesCityRamp,
    length: "measured",
    stepFree: true,
    sheltered: true,
    outdoor: false,
  },
];

const pois = [
  {
    id: POI.funanToilets,
    space: SPACE.funanB2Toilet,
    level: LEVEL.funanB2,
    name: "Toilets",
    category: "toilet",
    at: [103.84952, 1.29118] as LonLat,
  },
  {
    id: POI.cityHallAtm,
    space: null,
    level: LEVEL.cityHallConcourse,
    name: "ATM",
    category: "atm",
    at: [103.8516, 1.2927] as LonLat,
  },
  {
    id: POI.rafflesCityFood,
    space: SPACE.rafflesCityB1Walkway,
    level: LEVEL.rafflesCityB1,
    name: "Food court",
    category: "food",
    at: [103.8528, 1.2936] as LonLat,
  },
];

const streetEdges = [
  {
    way: OSM_WAY.northBridgeRoadSidewalk,
    from: OSM_NODE.exitB,
    to: OSM_NODE.northBridgeRoad,
    tags: {
      highway: "footway",
      footway: "sidewalk",
      surface: PRIVATE.osmTagValues[0],
      name: PRIVATE.osmTagValues[2],
    },
    covered: false,
  },
  {
    way: OSM_WAY.northBridgeRoadSidewalk,
    from: OSM_NODE.northBridgeRoad,
    to: OSM_NODE.exitA,
    tags: { highway: "footway", footway: "sidewalk", surface: PRIVATE.osmTagValues[0] },
    covered: false,
  },
  {
    way: OSM_WAY.crossing,
    from: OSM_NODE.exitA,
    to: OSM_NODE.stamfordRoadCrossing,
    tags: { highway: "footway", footway: "crossing", crossing: PRIVATE.osmTagValues[1] },
    covered: false,
  },
  {
    way: OSM_WAY.coveredWalkway,
    from: OSM_NODE.stamfordRoadCrossing,
    to: OSM_NODE.coveredWalkway,
    tags: { highway: "footway", footway: "sidewalk", covered: "yes" },
    covered: true,
  },
  {
    way: OSM_WAY.coveredWalkway,
    from: OSM_NODE.coveredWalkway,
    to: OSM_NODE.rafflesCityEntrance,
    tags: { highway: "footway", footway: "sidewalk", covered: "yes" },
    covered: true,
  },
  {
    way: OSM_WAY.steps,
    from: OSM_NODE.stepsTop,
    to: OSM_NODE.exitB,
    // footway "" is written as null.
    tags: { highway: "steps", footway: "" },
    covered: false,
    // Stored reversed, with a middle vertex: the builder turns it round.
    geom: line(STREET_AT[OSM_NODE.exitB], [103.8506, 1.2922], STREET_AT[OSM_NODE.stepsTop]),
  },
];

/** `rows`, or `rows` reversed, so a test can insert the same data in another physical order. */
function ordered<T>(rows: readonly T[], reverse: boolean): T[] {
  return reverse ? [...rows].reverse() : [...rows];
}

/**
 * Inserts the fixture. `reverse` inserts each table's rows in reverse order. Street connectors are
 * left to rebuildStreetConnectors, as in the publish transaction.
 */
export async function seedCityHall(db: TestDb, options: { reverse?: boolean } = {}): Promise<void> {
  const reverse = options.reverse ?? false;
  for (const v of ordered(venues, reverse)) {
    await db.query(
      `INSERT INTO venues (id, name, kind, operator, permission, footprint)
       VALUES ($1, $2, $3, $4, $5, $6::geometry)`,
      [v.id, v.name, v.kind, PRIVATE.operator, PRIVATE.permission, v.footprint],
    );
  }
  for (const l of ordered(levels, reverse)) {
    await db.query(
      `INSERT INTO levels (id, venue_id, ordinal, name, elevation_m, sort_key)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [l.id, l.venue, l.ordinal, l.name, l.elevation, l.sortKey],
    );
  }
  await db.query(
    `INSERT INTO restricted_zones (id, venue_id, level_id, geom, note)
     VALUES ($1, $2, $3, $4::geometry, $5)`,
    [
      PRIVATE.zoneId,
      VENUE.funan,
      LEVEL.funanB2,
      polygon(...rectangle(PRIVATE.zoneCorner, 1.2906543, 103.8494321, 1.2907654)),
      PRIVATE.zoneNote,
    ],
  );
  for (const s of ordered(spaces, reverse)) {
    await db.query(
      `INSERT INTO spaces (id, level_id, kind, name, geom) VALUES ($1, $2, $3, $4, $5::geometry)`,
      [s.id, s.level, s.kind, s.name, s.geom],
    );
  }
  for (const n of ordered(nodes, reverse)) {
    const row = n as (typeof nodes)[number] & {
      name?: string;
      streetName?: string;
      connector?: string;
      elevation?: number;
    };
    await db.query(
      `INSERT INTO nodes (id, level_id, kind, name, street_name, connector_id, elevation_m, geom)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::geometry)`,
      [
        row.id,
        row.level,
        row.kind,
        row.name ?? null,
        row.streetName ?? null,
        row.connector ?? null,
        row.elevation ?? null,
        point(AT[row.id]),
      ],
    );
  }
  for (const e of ordered(edges, reverse)) {
    await db.query(
      `INSERT INTO edges (id, from_node, to_node, kind, oneway, access, opening_hours, level_id,
                          connector_id, length_m, step_free, sheltered, outdoor, geom)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::geometry)`,
      [
        e.id,
        e.from,
        e.to,
        e.kind,
        e.oneway ?? false,
        e.access ?? "public",
        e.hours ?? null,
        e.level,
        e.connector ?? null,
        e.length === "measured" ? 0 : e.length,
        e.stepFree,
        e.sheltered,
        e.outdoor,
        e.geom ?? null,
      ],
    );
  }
  await db.query(
    `UPDATE edges e
        SET length_m = ST_Length(ST_Transform(COALESCE(e.geom, ST_MakeLine(f.geom, t.geom)), 3414))
       FROM nodes f, nodes t
      WHERE f.id = e.from_node AND t.id = e.to_node AND e.id = ANY($1::uuid[])`,
    [edges.filter((e) => e.length === "measured").map((e) => e.id)],
  );
  for (const p of ordered(pois, reverse)) {
    await db.query(
      `INSERT INTO pois (id, space_id, level_id, name, category, geom)
       VALUES ($1, $2, $3, $4, $5, $6::geometry)`,
      [p.id, p.space, p.level, p.name, p.category, point(p.at)],
    );
  }
  await db.query(
    `INSERT INTO anchors (id, node_id, kind, name, level_id, facing_deg, surveyed_geom,
                          prior_source, prior_sigma_m, photo_uri)
     VALUES ($1, $2, 'floor_point', $3, NULL, 352.5, $4::geometry, 'lta_exit', 3, $5)`,
    [
      PRIVATE.anchorId,
      NODE.northBridgeRoadExit,
      PRIVATE.anchorName,
      point(AT[NODE.northBridgeRoadExit]),
      PRIVATE.anchorPhotoUri,
    ],
  );
  const streetNodes = Object.entries(STREET_AT) as [string, LonLat][];
  for (const [id, at] of ordered(streetNodes, reverse)) {
    await db.query("INSERT INTO street_nodes (osm_node_id, geom) VALUES ($1, $2::geometry)", [
      id,
      point(at),
    ]);
  }
  for (const s of ordered(streetEdges, reverse)) {
    const geom =
      "geom" in s && s.geom !== undefined
        ? s.geom
        : line(
            STREET_AT[s.from as keyof typeof STREET_AT],
            STREET_AT[s.to as keyof typeof STREET_AT],
          );
    await db.query(
      `INSERT INTO street_edges (osm_way_id, from_osm_node, to_osm_node, tags, covered, length_m, geom)
       VALUES ($1, $2, $3, $4::jsonb, $5, ST_Length(ST_Transform($6::geometry, 3414)), $6::geometry)`,
      [s.way, s.from, s.to, JSON.stringify(s.tags), s.covered, geom],
    );
  }
}
