// The features drawn on the map, as they cross between the map (a DOM component in a WebView)
// and the native screen that keeps them. Plain GeoJSON with only the properties terra-draw needs
// to take them back (`mode`), so they survive the bridge's JSON and a remount of the map.

/** [longitude, latitude], WGS84. */
export type LonLat = [number, number];

export interface DrawnPolygon {
  type: "Feature";
  id: string;
  geometry: { type: "Polygon"; coordinates: LonLat[][] };
  properties: { mode: "polygon" };
}

export interface DrawnPoint {
  type: "Feature";
  id: string;
  geometry: { type: "Point"; coordinates: LonLat };
  properties: { mode: "point" };
}

export type DrawnFeature = DrawnPolygon | DrawnPoint;

/** terra-draw's markers for helper features (vertices, midpoints, snapping) and unfinished ones. */
const HELPER_PROPERTIES = [
  "currentlyDrawing",
  "edited",
  "selectionPoint",
  "midPoint",
  "closingPoint",
  "snappingPoint",
  "coordinatePoint",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function lonLat(value: unknown): LonLat | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const [lon, lat] = value as unknown[];
  if (typeof lon !== "number" || typeof lat !== "number") return null;
  if (!(Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90)) return null;
  return [lon, lat];
}

function ring(value: unknown): LonLat[] | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const points: LonLat[] = [];
  for (const item of value) {
    const point = lonLat(item);
    if (!point) return null;
    points.push(point);
  }
  return points;
}

/**
 * Keeps the finished polygons and points from a terra-draw snapshot (or anything else claiming
 * to be features), as fresh plain objects: helper and unfinished features, other geometry types
 * and malformed coordinates are dropped. Used on both sides of the bridge.
 */
export function toDrawnFeatures(input: unknown): DrawnFeature[] {
  if (!Array.isArray(input)) return [];
  const features: DrawnFeature[] = [];
  for (const item of input) {
    if (!isRecord(item) || item["type"] !== "Feature") continue;
    const { id, geometry, properties } = item;
    if (!(typeof id === "string" || typeof id === "number")) continue;
    if (!isRecord(geometry) || !isRecord(properties)) continue;
    if (HELPER_PROPERTIES.some((key) => properties[key])) continue;
    if (geometry["type"] === "Polygon" && properties["mode"] === "polygon") {
      const coordinates = geometry["coordinates"];
      if (!Array.isArray(coordinates) || coordinates.length === 0) continue;
      const rings = coordinates.map(ring);
      if (rings.some((r) => r === null)) continue;
      features.push({
        type: "Feature",
        id: String(id),
        geometry: { type: "Polygon", coordinates: rings as LonLat[][] },
        properties: { mode: "polygon" },
      });
    } else if (geometry["type"] === "Point" && properties["mode"] === "point") {
      const point = lonLat(geometry["coordinates"]);
      if (!point) continue;
      features.push({
        type: "Feature",
        id: String(id),
        geometry: { type: "Point", coordinates: point },
        properties: { mode: "point" },
      });
    }
  }
  return features;
}

export interface FeatureCounts {
  readonly polygons: number;
  readonly points: number;
}

export function countFeatures(features: readonly DrawnFeature[]): FeatureCounts {
  let polygons = 0;
  let points = 0;
  for (const feature of features) {
    if (feature.geometry.type === "Polygon") polygons++;
    else points++;
  }
  return { polygons, points };
}

/** "2 polygons, 1 point". */
export function describeCounts({ polygons, points }: FeatureCounts): string {
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${plural(polygons, "polygon")}, ${plural(points, "point")}`;
}
