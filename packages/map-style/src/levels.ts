// The level filter. The level switcher shows one ordinal band at a time (0 street, -1 the first
// basement band, and so on; docs/spec.md, "Levels and height"): features in the band are drawn in
// full, and the other bands are faded or hidden. A vertical connector edge is drawn on both of
// its end bands. Bands come from the features' own properties (ordinal, from_ordinal,
// to_ordinal in indoor.json), never from levels' heights.

import type {
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
} from "@maplibre/maplibre-gl-style-spec";

/** What happens to features outside the selected band. */
export type OtherBands = "fade" | "hide";

/** The street band: street level, and the street graph. */
export const STREET_BAND = 0;

function checkBand(band: number): void {
  if (!Number.isInteger(band) || band < -32_768 || band > 32_767) {
    throw new RangeError(`A band is an ordinal, a smallint: got ${band}`);
  }
}

/**
 * True for a feature drawn on `band`: one whose ordinal is the band, or an edge with either end on
 * it, so a connector shows on both of its end bands.
 */
export function inBand(band: number): ExpressionSpecification {
  checkBand(band);
  return [
    "any",
    ["==", ["get", "ordinal"], band],
    ["==", ["get", "from_ordinal"], band],
    ["==", ["get", "to_ordinal"], band],
  ];
}

/**
 * The band part of a layer filter: only the band's features when other bands are hidden, or
 * `undefined` (no filter) when they fade.
 */
export function levelFilter(
  band: number,
  otherBands: OtherBands,
): ExpressionSpecification | undefined {
  return otherBands === "hide" ? inBand(band) : undefined;
}

/**
 * An opacity: `full` for features in the band and `faded` for the others. When other bands are
 * hidden the filter removes them, so the opacity is simply `full`.
 */
export function levelOpacity(
  band: number,
  otherBands: OtherBands,
  full: number,
  faded: number,
): DataDrivenPropertyValueSpecification<number> {
  return otherBands === "hide" ? full : ["case", inBand(band), full, faded];
}

/** A sort key that draws the band's features above faded ones. */
export function levelSortKey(band: number): ExpressionSpecification {
  return ["case", inBand(band), 1, 0];
}
