// Local x/z metres to WGS84 GeoJSON, for display only.
//
// This places the preview on the map approximately. The origin (a street prior or a GNSS fix at
// the start anchor) is metres off, and the heading is the bigger error: each degree moves a point
// 300 m away by 5.2 m sideways. The server's network adjustment is the authority on where a
// segment really is (docs/decisions/0008-anchors-and-georeferencing.md); nothing converted here is
// ever uploaded as a position.
//
// The conversion is a local tangent plane (equirectangular) approximation that uses the WGS84
// ellipsoid's radii of curvature at the reference latitude. At Singapore's latitude (about 1.3°N)
// it stays within a millimetre of the exact geodesic for points 300 m from the reference (a test
// checks this against Vincenty's direct formula). A spherical earth would be about 0.5% off
// north-south, 1.7 m at 300 m, which is why the ellipsoid's radii are used.

import type { FloorPolygon, LocalRing } from "./polygons.ts";

const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const DEGREE = Math.PI / 180;

/** Where the session's frame sits on the earth, approximately. */
export interface DisplayTransform {
  /** WGS84 longitude and latitude of the reference point, in degrees. */
  readonly lon: number;
  readonly lat: number;
  /** The reference point in the session's frame, [x, z] metres. Default [0, 0], the session origin. */
  readonly local?: readonly [number, number];
  /**
   * Bearing of the session's -z axis (ARKit's forward at the start of the session) in degrees
   * clockwise from true north. headingFromDirection derives it from any direction whose bearing
   * is known, such as a door's facing.
   */
  readonly headingDeg: number;
}

/**
 * The heading for DisplayTransform when the local direction (dx, dz) is known to point at
 * `bearingDeg` (degrees clockwise from true north), for example a door's facing at the start
 * anchor. Seen from above with -z pointing up the page, +x points right, so with heading 0 the
 * axes are x east and z south.
 */
export function headingFromDirection(dx: number, dz: number, bearingDeg: number): number {
  if (dx === 0 && dz === 0) throw new RangeError("The direction must not be zero.");
  const heading = bearingDeg - Math.atan2(dx, -dz) / DEGREE;
  return ((heading % 360) + 360) % 360;
}

/** Converts session x/z metres to [lon, lat] degrees. Approximate: see the module comment. */
export function localToLonLat(
  x: number,
  z: number,
  transform: DisplayTransform,
): [lon: number, lat: number] {
  return makeConverter(transform)(x, z);
}

function makeConverter(transform: DisplayTransform): (x: number, z: number) => [number, number] {
  const { lon, lat, headingDeg } = transform;
  if (!Number.isFinite(lon) || !(Math.abs(lat) < 89)) {
    throw new RangeError("The reference point needs a finite longitude and a latitude within 89°.");
  }
  if (!Number.isFinite(headingDeg)) throw new RangeError("The heading must be finite.");
  const [x0, z0] = transform.local ?? [0, 0];
  const phi = lat * DEGREE;
  const sin2 = Math.sin(phi) ** 2;
  const w = Math.sqrt(1 - WGS84_E2 * sin2);
  // Radii of curvature: along the meridian, and of the prime vertical.
  const meridional = (WGS84_A * (1 - WGS84_E2)) / (w * w * w);
  const primeVertical = WGS84_A / w;
  const degLatPerMetre = 1 / (meridional * DEGREE);
  const degLonPerMetre = 1 / (primeVertical * Math.cos(phi) * DEGREE);
  const cos = Math.cos(headingDeg * DEGREE);
  const sin = Math.sin(headingDeg * DEGREE);
  return (x, z) => {
    const dx = x - x0;
    const dz = z - z0;
    // -z has bearing h and +x bearing h + 90°.
    const east = dx * cos - dz * sin;
    const north = -dx * sin - dz * cos;
    return [lon + east * degLonPerMetre, lat + north * degLatPerMetre];
  };
}

/** GeoJSON (RFC 7946) types for the display output. */
export interface DisplayPolygon {
  readonly type: "Polygon";
  /** [lon, lat] rings: the outer ring counter-clockwise, holes clockwise, each closed. */
  readonly coordinates: [number, number][][];
}

export interface DisplayFeature {
  readonly type: "Feature";
  readonly properties: {
    /** Always true: the position is for display only. */
    readonly approximate: true;
    /** The polygon's area in m², from the local geometry. */
    readonly areaM2: number;
  };
  readonly geometry: DisplayPolygon;
}

export interface DisplayFeatureCollection {
  readonly type: "FeatureCollection";
  readonly features: DisplayFeature[];
}

/**
 * Polygons in session x/z metres (from buildFloorplan or traceCoverage) as a GeoJSON feature
 * collection in WGS84, for drawing the preview over the base map. Approximate and for display
 * only: see the module comment. Coordinates are rounded to 1e-8 degrees (about 1 mm). Ring
 * orientation follows RFC 7946, which the local orientation (counter-clockwise from above)
 * already gives.
 */
export function toDisplayGeoJSON(
  polygons: readonly FloorPolygon[],
  transform: DisplayTransform,
): DisplayFeatureCollection {
  const convert = makeConverter(transform);
  const ring = (local: LocalRing): [number, number][] =>
    local.map(([x, z]) => {
      const [lon, lat] = convert(x, z);
      return [round(lon), round(lat)];
    });
  return {
    type: "FeatureCollection",
    features: polygons.map((polygon) => ({
      type: "Feature",
      properties: { approximate: true, areaM2: Math.round(polygon.areaM2 * 100) / 100 },
      geometry: {
        type: "Polygon",
        coordinates: [ring(polygon.outer), ...polygon.holes.map(ring)],
      },
    })),
  };
}

function round(degrees: number): number {
  return Math.round(degrees * 1e8) / 1e8;
}
