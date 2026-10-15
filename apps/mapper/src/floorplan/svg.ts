// Floor-plan polygons as SVG paths. The plan is in the session's x/z metres; seen from above with
// x to the right, z points down the page, which is SVG's y, so x/z go straight in.

import type { FloorPolygon, LocalRing } from "@usg/floorplan";

export interface SvgScene {
  /** "minX minY width height" in metres, with a margin. */
  readonly viewBox: string;
  /** Width over height, for sizing the drawing. */
  readonly aspect: number;
  /** One path per polygon, outer ring and holes together (draw with fillRule "evenodd"). */
  readonly outlines: readonly string[];
  readonly gaps: readonly string[];
}

const round = (value: number): number => Math.round(value * 100) / 100;

function ringPath(ring: LocalRing): string {
  // Rings are closed (the last point repeats the first); Z closes the path instead.
  const points = ring.slice(0, -1);
  return points
    .map(([x, z], index) => `${index === 0 ? "M" : "L"}${round(x)} ${round(z)}`)
    .join("")
    .concat("Z");
}

const polygonPath = (polygon: FloorPolygon): string =>
  [polygon.outer, ...polygon.holes].map(ringPath).join("");

export function svgScene(
  polygons: readonly FloorPolygon[],
  gaps: readonly FloorPolygon[] = [],
  marginM = 2,
): SvgScene | null {
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const polygon of polygons) {
    for (const [x, z] of polygon.outer) {
      minX = Math.min(minX, x);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxZ = Math.max(maxZ, z);
    }
  }
  if (!(minX <= maxX && minZ <= maxZ)) return null;
  const width = maxX - minX + 2 * marginM;
  const height = maxZ - minZ + 2 * marginM;
  return {
    viewBox: [minX - marginM, minZ - marginM, width, height].map(round).join(" "),
    aspect: width / height,
    outlines: polygons.map(polygonPath),
    gaps: gaps.map(polygonPath),
  };
}
