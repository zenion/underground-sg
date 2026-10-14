import { describe, expect, test } from "vitest";
import { countFeatures, describeCounts, toDrawnFeatures } from "../src/map/features.ts";

// Around City Hall MRT.
const ring = [
  [103.8518, 1.2929],
  [103.8522, 1.2929],
  [103.8522, 1.2933],
  [103.8518, 1.2933],
  [103.8518, 1.2929],
];

const polygon = {
  type: "Feature",
  id: "0b8a5e0c-6f0c-4a39-9f43-3f1e6c3d1a11",
  geometry: { type: "Polygon", coordinates: [ring] },
  properties: { mode: "polygon" },
};

const point = {
  type: "Feature",
  id: 7,
  geometry: { type: "Point", coordinates: [103.852, 1.2931] },
  properties: { mode: "point" },
};

describe("toDrawnFeatures", () => {
  test("keeps finished polygons and points as plain copies", () => {
    const features = toDrawnFeatures([polygon, point]);
    expect(features).toEqual([
      { ...polygon, properties: { mode: "polygon" } },
      { ...point, id: "7", properties: { mode: "point" } },
    ]);
    expect(features[0]?.geometry.coordinates).not.toBe(polygon.geometry.coordinates);
  });

  test("drops terra-draw's helper and unfinished features, and extra properties", () => {
    const helpers = [
      { ...point, id: "a", properties: { mode: "select", selectionPoint: true } },
      { ...point, id: "b", properties: { mode: "polygon", coordinatePoint: true } },
      { ...point, id: "c", properties: { mode: "point", midPoint: true } },
      { ...polygon, id: "d", properties: { mode: "polygon", currentlyDrawing: true } },
      { ...polygon, id: "e", properties: { mode: "polygon", closingPoint: true } },
    ];
    expect(toDrawnFeatures(helpers)).toEqual([]);
    const [kept] = toDrawnFeatures([{ ...polygon, properties: { mode: "polygon", note: "x" } }]);
    expect(kept?.properties).toEqual({ mode: "polygon" });
  });

  test("drops malformed input", () => {
    const bad = [
      null,
      "Feature",
      { ...polygon, id: undefined },
      { ...polygon, type: "FeatureCollection" },
      { ...polygon, properties: { mode: "point" } },
      { ...polygon, geometry: { type: "Polygon", coordinates: [] } },
      { ...polygon, geometry: { type: "Polygon", coordinates: [ring.slice(0, 3)] } },
      {
        ...polygon,
        geometry: { type: "Polygon", coordinates: [[...ring.slice(0, 4), [Number.NaN, 1]]] },
      },
      { ...point, geometry: { type: "Point", coordinates: [103.85, 91] } },
      { ...point, geometry: { type: "Point", coordinates: ["103.85", "1.29"] } },
      { ...point, geometry: { type: "LineString", coordinates: [ring[0], ring[1]] } },
    ];
    expect(toDrawnFeatures(bad)).toEqual([]);
    expect(toDrawnFeatures({ features: [polygon] })).toEqual([]);
    expect(toDrawnFeatures(undefined)).toEqual([]);
  });
});

describe("countFeatures", () => {
  test("counts polygons and points", () => {
    const features = toDrawnFeatures([polygon, point, { ...point, id: "p2" }]);
    expect(countFeatures(features)).toEqual({ polygons: 1, points: 2 });
    expect(describeCounts(countFeatures(features))).toBe("1 polygon, 2 points");
    expect(describeCounts(countFeatures([]))).toBe("0 polygons, 0 points");
  });
});
