// The map data model's shared vocabulary (schemas/map/defs.schema.json): the HEAD tables' enum
// values and the GeoJSON geometry rules that the snapshot files and the change-set diff share.
// Environment-neutral: the webapp, the mapper app (Hermes) and the server import it.

import type {
  EdgeAccess,
  EdgeKind,
  LinearRing,
  LineStringGeometry,
  MultiPolygonGeometry,
  NodeKind,
  PoiCategory,
  PointGeometry,
  PolygonGeometry,
  Position,
  SpaceKind,
  StreetPriorSource,
  VenueKind,
} from "./generated/contracts.ts";
import { SCHEMA_BASE_URL } from "./schema-ids.ts";

/** Base of the `$id` of the shared map definitions. */
export const MAP_SCHEMA_BASE_URL = `${SCHEMA_BASE_URL}map/`;

/** The schema file with the definitions the snapshot and diff schemas share. */
export const MAP_DEFS_SCHEMA_FILE = "defs.schema.json";

/**
 * Coordinates have at most this many decimals: 1e-7 degrees is about 1 cm in Singapore. The
 * snapshot builder writes them with `ST_AsGeoJSON(geom, 7)`.
 */
export const COORDINATE_DECIMALS = 7;

/** The `venue_kind` values in db/schema.sql. */
export const VENUE_KINDS = [
  "mall",
  "mrt_station",
  "link",
  "office",
  "hotel",
  "other",
] as const satisfies readonly VenueKind[];

/** The `space_kind` values in db/schema.sql. */
export const SPACE_KINDS = [
  "walkway",
  "concourse",
  "plaza",
  "shop",
  "toilet",
  "fare_zone",
  "other",
] as const satisfies readonly SpaceKind[];

/** The `node_kind` values in db/schema.sql. */
export const NODE_KINDS = [
  "junction",
  "exit",
  "entrance",
  "escalator",
  "lift",
  "stairs",
  "fare_gate",
  "door",
  "travelator",
  "ramp",
] as const satisfies readonly NodeKind[];

/** The `edge_kind` values in db/schema.sql. */
export const EDGE_KINDS = [
  "walk",
  "escalator",
  "stairs",
  "lift",
  "ramp",
  "travelator",
  "street",
] as const satisfies readonly EdgeKind[];

/** Edge kinds that are vertical connectors between landings on different levels. */
export const CONNECTOR_EDGE_KINDS = [
  "escalator",
  "stairs",
  "lift",
  "ramp",
  "travelator",
] as const satisfies readonly EdgeKind[];

/** Edge kinds that are never step-free (a CHECK in db/schema.sql). */
export const NEVER_STEP_FREE_EDGE_KINDS = [
  "stairs",
  "escalator",
] as const satisfies readonly EdgeKind[];

/** The `edge_access` values in db/schema.sql. */
export const EDGE_ACCESS_VALUES = [
  "public",
  "paid_fare_zone",
  "customers_only",
] as const satisfies readonly EdgeAccess[];

/** The `poi_category` values in db/schema.sql. */
export const POI_CATEGORIES = [
  "shop",
  "food",
  "toilet",
  "atm",
  "info",
  "nursing_room",
  "other",
] as const satisfies readonly PoiCategory[];

/** The `street_prior_source` values in db/schema.sql. */
export const STREET_PRIOR_SOURCES = [
  "lta_exit",
  "gnss",
  "imagery",
  "onemap",
] as const satisfies readonly StreetPriorSource[];

/** Any geometry the map schemas allow. */
export type Geometry = PointGeometry | LineStringGeometry | PolygonGeometry | MultiPolygonGeometry;

/**
 * Whether `value` has at most `decimals` digits after the decimal point in its shortest form,
 * which is what `JSON.stringify` writes.
 */
export function hasAtMostDecimals(value: number, decimals: number = COORDINATE_DECIMALS): boolean {
  return Number.isFinite(value) && Number(value.toFixed(decimals)) === value;
}

/** Collects problem messages, up to a limit, so a bad document can't flood a report. */
export class ProblemList {
  readonly limit: number;
  readonly #messages: string[] = [];
  #omitted = 0;

  constructor(limit = 100) {
    this.limit = limit;
  }

  add(message: string): void {
    if (this.#messages.length < this.limit) this.#messages.push(message);
    else this.#omitted += 1;
  }

  /** The messages, plus a last line counting the ones left out. */
  get messages(): string[] {
    return this.#omitted === 0
      ? [...this.#messages]
      : [...this.#messages, `and ${this.#omitted} more problems`];
  }
}

function checkPosition(position: Position, at: string, problems: ProblemList): void {
  const [lon, lat] = position;
  if (lat < -90 || lat > 90) problems.add(`${at}: latitude ${lat} is outside -90 to 90`);
  if (!hasAtMostDecimals(lon) || !hasAtMostDecimals(lat)) {
    problems.add(`${at}: more than ${COORDINATE_DECIMALS} decimals`);
  }
}

function checkRing(ring: LinearRing, at: string, problems: ProblemList): void {
  ring.forEach((position, i) => {
    checkPosition(position, `${at}[${i}]`, problems);
  });
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first === undefined || last === undefined || first[0] !== last[0] || first[1] !== last[1]) {
    problems.add(`${at}: the ring is not closed (its last position differs from its first)`);
  }
}

/**
 * Checks what the schemas can't: latitudes within -90 to 90, at most `COORDINATE_DECIMALS`
 * decimals, and closed polygon rings. `geometry` must already be schema-valid.
 */
export function checkGeometry(geometry: Geometry | null, at: string, problems: ProblemList): void {
  if (geometry === null) return;
  switch (geometry.type) {
    case "Point":
      checkPosition(geometry.coordinates, `${at}.coordinates`, problems);
      break;
    case "LineString":
      geometry.coordinates.forEach((position, i) => {
        checkPosition(position, `${at}.coordinates[${i}]`, problems);
      });
      break;
    case "Polygon":
      geometry.coordinates.forEach((ring, i) => {
        checkRing(ring, `${at}.coordinates[${i}]`, problems);
      });
      break;
    case "MultiPolygon":
      geometry.coordinates.forEach((polygon, i) => {
        polygon.forEach((ring, j) => {
          checkRing(ring, `${at}.coordinates[${i}][${j}]`, problems);
        });
      });
      break;
  }
}
