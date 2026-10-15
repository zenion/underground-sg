// SVY21 (EPSG:3414) for the tests' measurements: the transverse Mercator forward projection (Snyder,
// Map Projections: A Working Manual, 1987, equations 8-9 to 8-10) with SVY21's parameters on the
// WGS84 ellipsoid. It agrees with PostGIS's ST_Transform(geom, 3414) to well under a millimetre
// across the City Hall cluster. Lengths are measured in metres in SVY21, never in degrees.

const SEMI_MAJOR = 6_378_137;
const FLATTENING = 1 / 298.257223563;
const E2 = 2 * FLATTENING - FLATTENING * FLATTENING;
const EP2 = E2 / (1 - E2);
const RAD = Math.PI / 180;
/** SVY21's origin: 1°22'N 103°50'E, false easting 28001.642 m, false northing 38744.572 m, k 1. */
const ORIGIN_LAT = (1 + 22 / 60) * RAD;
const ORIGIN_LON = (103 + 50 / 60) * RAD;
const FALSE_EASTING = 28_001.642;
const FALSE_NORTHING = 38_744.572;

/** The meridian arc from the equator to latitude `phi` (radians), in metres. */
function meridianArc(phi: number): number {
  const e4 = E2 * E2;
  const e6 = e4 * E2;
  return (
    SEMI_MAJOR *
    ((1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
      ((3 * E2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
      ((35 * e6) / 3072) * Math.sin(6 * phi))
  );
}

/** A WGS84 [longitude, latitude] as SVY21 [easting, northing], in metres. */
export function toSvy21(position: readonly number[]): [number, number] {
  const [lon = Number.NaN, lat = Number.NaN] = position;
  const phi = lat * RAD;
  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  const tan = Math.tan(phi);
  const n = SEMI_MAJOR / Math.sqrt(1 - E2 * sin * sin);
  const t = tan * tan;
  const c = EP2 * cos * cos;
  const a = (lon * RAD - ORIGIN_LON) * cos;
  const x =
    n *
    (a + ((1 - t + c) * a ** 3) / 6 + ((5 - 18 * t + t * t + 72 * c - 58 * EP2) * a ** 5) / 120);
  const y =
    meridianArc(phi) -
    meridianArc(ORIGIN_LAT) +
    n *
      tan *
      ((a * a) / 2 +
        ((5 - t + 9 * c + 4 * c * c) * a ** 4) / 24 +
        ((61 - 58 * t + t * t + 600 * c - 330 * EP2) * a ** 6) / 720);
  return [FALSE_EASTING + x, FALSE_NORTHING + y];
}

/** A line's planar length in SVY21, in metres. */
export function svy21Length(line: readonly (readonly number[])[]): number {
  let length = 0;
  for (let i = 1; i < line.length; i++) {
    const [x1, y1] = toSvy21(line[i - 1] ?? []);
    const [x2, y2] = toSvy21(line[i] ?? []);
    length += Math.hypot(x2 - x1, y2 - y1);
  }
  return length;
}
