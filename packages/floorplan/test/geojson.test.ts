import { describe, expect, test } from "vitest";
import {
  buildFloorplan,
  type DisplayTransform,
  headingFromDirection,
  localToLonLat,
  toDisplayGeoJSON,
} from "../src/index.ts";
import { rect, Triangles } from "../src/synthetic.ts";
import { nearbyDistance, vincentyDirect } from "./geodesy.ts";

// Approximate WGS84 positions in the City Hall cluster, for realistic latitudes and longitudes.
// They are not surveyed and nothing here depends on their exact values.
const CITY_HALL_MRT = { lon: 103.852, lat: 1.2931 };
const ESPLANADE_MRT = { lon: 103.8555, lat: 1.2934 };

const DEGREE = Math.PI / 180;

describe("headingFromDirection", () => {
  test("gives the bearing of -z from any direction with a known bearing", () => {
    expect(headingFromDirection(0, -1, 0)).toBeCloseTo(0, 12);
    expect(headingFromDirection(0, -1, 90)).toBeCloseTo(90, 12);
    // +x is 90° clockwise from -z.
    expect(headingFromDirection(1, 0, 90)).toBeCloseTo(0, 12);
    expect(headingFromDirection(1, 0, 0)).toBeCloseTo(270, 12);
    // +z points backwards.
    expect(headingFromDirection(0, 2, 200)).toBeCloseTo(20, 12);
    expect(headingFromDirection(-3, -3, 45 + 270)).toBeCloseTo(0, 12);
    expect(() => headingFromDirection(0, 0, 10)).toThrow(RangeError);
  });

  test("round-trips through localToLonLat", () => {
    // A door facing (0.6, 0.8) in the session frame, known from imagery to face bearing 130°.
    const transform: DisplayTransform = {
      ...CITY_HALL_MRT,
      headingDeg: headingFromDirection(0.6, 0.8, 130),
    };
    // 100 m along the facing lands 100 m from the anchor at bearing 130°.
    const along = localToLonLat(60, 80, transform);
    const expected = vincentyDirect(CITY_HALL_MRT.lon, CITY_HALL_MRT.lat, 130, 100);
    expect(nearbyDistance(along, expected)).toBeLessThan(0.001);
  });
});

describe("localToLonLat", () => {
  test("puts -z at the heading and +x 90° clockwise from it", () => {
    const at = (x: number, z: number, headingDeg: number) =>
      localToLonLat(x, z, { ...CITY_HALL_MRT, headingDeg });
    const close = (a: [number, number], b: [number, number]) =>
      expect(nearbyDistance(a, b)).toBeLessThan(0.001);
    const { lon, lat } = CITY_HALL_MRT;
    close(at(0, -300, 0), vincentyDirect(lon, lat, 0, 300));
    close(at(300, 0, 0), vincentyDirect(lon, lat, 90, 300));
    close(at(0, 300, 0), vincentyDirect(lon, lat, 180, 300));
    close(at(0, -300, 90), vincentyDirect(lon, lat, 90, 300));
    close(at(300, 0, 90), vincentyDirect(lon, lat, 180, 300));
    close(at(-200, -200, 30), vincentyDirect(lon, lat, 30 - 45, Math.hypot(200, 200)));
  });

  test("measures from the reference point's local position", () => {
    const transform: DisplayTransform = { ...CITY_HALL_MRT, local: [12, -7], headingDeg: 75 };
    expect(localToLonLat(12, -7, transform)).toEqual([CITY_HALL_MRT.lon, CITY_HALL_MRT.lat]);
    const moved = localToLonLat(12, -107, transform);
    expect(
      nearbyDistance(moved, vincentyDirect(CITY_HALL_MRT.lon, CITY_HALL_MRT.lat, 75, 100)),
    ).toBeLessThan(0.001);
  });

  test("is within a millimetre of the geodesic at 300 m in the City Hall cluster", () => {
    let worst = 0;
    let worstSphere = 0;
    const sphere = 6371008.8;
    for (const origin of [CITY_HALL_MRT, ESPLANADE_MRT]) {
      for (let bearing = 0; bearing < 360; bearing += 10) {
        for (const distance of [50, 150, 300]) {
          const exact = vincentyDirect(origin.lon, origin.lat, bearing, distance);
          const east = distance * Math.sin(bearing * DEGREE);
          const north = distance * Math.cos(bearing * DEGREE);
          // heading 0: x east, z south.
          const approximate = localToLonLat(east, -north, { ...origin, headingDeg: 0 });
          worst = Math.max(worst, nearbyDistance(approximate, exact));
          const spherical: [number, number] = [
            origin.lon + east / (sphere * Math.cos(origin.lat * DEGREE) * DEGREE),
            origin.lat + north / (sphere * DEGREE),
          ];
          worstSphere = Math.max(worstSphere, nearbyDistance(spherical, exact));
        }
      }
    }
    // README.md quotes these figures.
    expect(worst).toBeLessThan(0.001);
    expect(worstSphere).toBeGreaterThan(1.5);
    expect(worstSphere).toBeLessThan(1.8);
  });

  test("refuses a reference it can't use", () => {
    for (const bad of [
      { lon: Number.NaN, lat: 1.29, headingDeg: 0 },
      { lon: 103.85, lat: 90, headingDeg: 0 },
      { lon: 103.85, lat: Number.POSITIVE_INFINITY, headingDeg: 0 },
      { lon: 103.85, lat: 1.29, headingDeg: Number.NaN },
    ]) {
      expect(() => localToLonLat(0, 0, bad), JSON.stringify(bad)).toThrow(RangeError);
    }
  });
});

describe("toDisplayGeoJSON", () => {
  // A corridor with a pillar, in a session whose -z faces north-east.
  const corridor = new Triangles().addRect(rect(0, -40, 6, 0), 0.25, [
    rect(2.5, -20.5, 3.5, -19.5),
  ]);
  const { polygons } = buildFloorplan(corridor.toFloat32());
  const transform: DisplayTransform = { ...CITY_HALL_MRT, headingDeg: 45 };
  const collection = toDisplayGeoJSON(polygons, transform);

  test("is a GeoJSON feature collection of approximate polygons", () => {
    expect(collection.type).toBe("FeatureCollection");
    expect(collection.features).toHaveLength(1);
    const [feature] = collection.features;
    expect(feature?.type).toBe("Feature");
    expect(feature?.geometry.type).toBe("Polygon");
    expect(feature?.properties.approximate).toBe(true);
    expect(feature?.properties.areaM2).toBe(Math.round((polygons[0]?.areaM2 ?? 0) * 100) / 100);
    expect(feature?.geometry.coordinates).toHaveLength(2);
    expect(JSON.parse(JSON.stringify(collection))).toEqual(collection);
  });

  test("follows RFC 7946 ring orientation, with closed rings", () => {
    const rings = collection.features[0]?.geometry.coordinates ?? [];
    // Shoelace in (lon, lat): positive is counter-clockwise on the map.
    const signed = (ring: [number, number][]) => {
      let sum = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[j] as [number, number];
        const b = ring[i] as [number, number];
        sum += a[0] * b[1] - b[0] * a[1];
      }
      return sum / 2;
    };
    const [outer, hole] = rings;
    expect(signed(outer ?? [])).toBeGreaterThan(0);
    expect(signed(hole ?? [])).toBeLessThan(0);
    for (const ring of rings) expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  test("keeps the shape: area and the far end's position", () => {
    const outer = collection.features[0]?.geometry.coordinates[0] ?? [];
    const phi = CITY_HALL_MRT.lat * DEGREE;
    const metresPerDegLat = 110574.4;
    const metresPerDegLon = 111319.5 * Math.cos(phi);
    let sum = 0;
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      const a = outer[j] as [number, number];
      const b = outer[i] as [number, number];
      sum +=
        a[0] * metresPerDegLon * (b[1] * metresPerDegLat) -
        b[0] * metresPerDegLon * (a[1] * metresPerDegLat);
    }
    expect(sum / 2).toBeCloseTo(240, -1);
    // The corridor runs 40 m along -z, so its far end is about 40 m north-east of the anchor.
    const far = vincentyDirect(CITY_HALL_MRT.lon, CITY_HALL_MRT.lat, 45, 40);
    const nearest = Math.min(...outer.map((p) => nearbyDistance(p, far)));
    expect(nearest).toBeLessThan(0.2);
  });

  test("rounds coordinates to 1e-8 degrees", () => {
    for (const [lon, lat] of collection.features[0]?.geometry.coordinates.flat() ?? []) {
      expect(Math.round(lon * 1e8) / 1e8).toBe(lon);
      expect(Math.round(lat * 1e8) / 1e8).toBe(lat);
    }
  });
});
