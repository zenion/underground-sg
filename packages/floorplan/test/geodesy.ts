// Vincenty's direct formula on the WGS84 ellipsoid: the reference that the display conversion is
// checked against. Over a few hundred metres its own error is far below a micrometre.

const A = 6378137;
const F = 1 / 298.257223563;
const B = A * (1 - F);
const DEGREE = Math.PI / 180;

/** The point `distance` metres from (lon, lat) along the geodesic with the given azimuth (degrees clockwise from north). */
export function vincentyDirect(
  lon: number,
  lat: number,
  azimuthDeg: number,
  distance: number,
): [lon: number, lat: number] {
  const alpha1 = azimuthDeg * DEGREE;
  const sinAlpha1 = Math.sin(alpha1);
  const cosAlpha1 = Math.cos(alpha1);
  const tanU1 = (1 - F) * Math.tan(lat * DEGREE);
  const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1);
  const sinU1 = tanU1 * cosU1;
  const sigma1 = Math.atan2(tanU1, cosAlpha1);
  const sinAlpha = cosU1 * sinAlpha1;
  const cos2Alpha = 1 - sinAlpha * sinAlpha;
  const u2 = (cos2Alpha * (A * A - B * B)) / (B * B);
  const bigA = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const bigB = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  let sigma = distance / (B * bigA);
  let cos2SigmaM = 0;
  let sinSigma = 0;
  let cosSigma = 0;
  for (let i = 0; i < 100; i++) {
    cos2SigmaM = Math.cos(2 * sigma1 + sigma);
    sinSigma = Math.sin(sigma);
    cosSigma = Math.cos(sigma);
    const deltaSigma =
      bigB *
      sinSigma *
      (cos2SigmaM +
        (bigB / 4) *
          (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
            (bigB / 6) *
              cos2SigmaM *
              (-3 + 4 * sinSigma * sinSigma) *
              (-3 + 4 * cos2SigmaM * cos2SigmaM)));
    const next = distance / (B * bigA) + deltaSigma;
    if (Math.abs(next - sigma) < 1e-14) {
      sigma = next;
      break;
    }
    sigma = next;
  }
  cos2SigmaM = Math.cos(2 * sigma1 + sigma);
  sinSigma = Math.sin(sigma);
  cosSigma = Math.cos(sigma);
  const tmp = sinU1 * sinSigma - cosU1 * cosSigma * cosAlpha1;
  const lat2 = Math.atan2(
    sinU1 * cosSigma + cosU1 * sinSigma * cosAlpha1,
    (1 - F) * Math.sqrt(sinAlpha * sinAlpha + tmp * tmp),
  );
  const lambda = Math.atan2(sinSigma * sinAlpha1, cosU1 * cosSigma - sinU1 * sinSigma * cosAlpha1);
  const c = (F / 16) * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha));
  const l =
    lambda -
    (1 - c) *
      F *
      sinAlpha *
      (sigma + c * sinSigma * (cos2SigmaM + c * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
  return [lon + l / DEGREE, lat2 / DEGREE];
}

/** Metres between two nearby points, through the local radii of curvature (fine below a few km). */
export function nearbyDistance(a: [number, number], b: [number, number]): number {
  const phi = ((a[1] + b[1]) / 2) * DEGREE;
  const e2 = F * (2 - F);
  const w = Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const meridional = (A * (1 - e2)) / (w * w * w);
  const primeVertical = A / w;
  const north = (b[1] - a[1]) * DEGREE * meridional;
  const east = (b[0] - a[0]) * DEGREE * primeVertical * Math.cos(phi);
  return Math.hypot(east, north);
}
