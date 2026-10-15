// The level switcher's bands (docs/spec.md, "Levels and height"): `ordinal` is a display band, 0
// the street band, -1 the first basement band, and so on. Several venues' levels share a band, and
// one venue's levels can share one too (sort_key orders those), so a band's label is built from
// the names its levels are signed with ("B2", "Concourse"), never from the ordinal. Bands are
// listed top to bottom, the street band always among them.

import { type IndoorSnapshot, isIndoorFeature } from "@usg/contracts";
import { STREET_BAND } from "@usg/map-style";

/** One level in a band. */
export interface BandLevel {
  readonly id: string;
  /** The level's name as signed in the venue, such as "B2". */
  readonly name: string;
  readonly venueName: string | undefined;
  readonly sortKey: number;
}

export interface Band {
  readonly ordinal: number;
  /** A short label for the switcher: "Street", or the band's distinct level names, such as "B2 · Concourse". */
  readonly label: string;
  /** The band's levels by venue, such as "City Hall MRT Concourse · Funan B2". */
  readonly description: string;
  /** The band's levels, by venue name, then sort_key, then name. */
  readonly levels: readonly BandLevel[];
}

/** At most this many level names in a label; the rest are counted ("B2 · B3 +2"). */
export const MAX_LABEL_NAMES = 3;

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Compares level names naturally: "B2" before "B10", then "Concourse". */
function compareNames(a: string, b: string): number {
  return collator.compare(a, b);
}

function bandLabel(ordinal: number, levels: readonly BandLevel[]): string {
  if (ordinal === STREET_BAND) return "Street";
  const ordered = [...levels].sort((a, b) => a.sortKey - b.sortKey || compareNames(a.name, b.name));
  const names = [...new Set(ordered.map((level) => level.name.trim()).filter(Boolean))];
  if (names.length === 0) return `Band ${ordinal}`;
  if (names.length <= MAX_LABEL_NAMES) return names.join(" · ");
  const shown = names.slice(0, MAX_LABEL_NAMES - 1);
  return `${shown.join(" · ")} +${names.length - shown.length}`;
}

function bandDescription(ordinal: number, levels: readonly BandLevel[]): string {
  const byVenue = new Map<string, string[]>();
  for (const level of levels) {
    const venue = level.venueName ?? "";
    byVenue.set(venue, [...(byVenue.get(venue) ?? []), level.name]);
  }
  const parts = [...byVenue].map(([venue, names]) =>
    venue === "" ? names.join(", ") : `${venue} ${names.join(", ")}`,
  );
  if (ordinal === STREET_BAND) return ["Street level", ...parts].join(" · ");
  return parts.length > 0 ? parts.join(" · ") : `Band ${ordinal}`;
}

/** The bands of a version's levels, top to bottom, with the street band always included. */
export function levelBands(indoor: IndoorSnapshot | undefined): Band[] {
  const venues = new Map<string, string>();
  const levelsByBand = new Map<number, BandLevel[]>([[STREET_BAND, []]]);
  for (const feature of indoor?.features ?? []) {
    if (isIndoorFeature(feature, "venue")) venues.set(feature.id, feature.properties.name);
  }
  for (const feature of indoor?.features ?? []) {
    if (!isIndoorFeature(feature, "level")) continue;
    const p = feature.properties;
    const level: BandLevel = {
      id: feature.id,
      name: p.name,
      venueName: venues.get(p.venue_id),
      sortKey: p.sort_key,
    };
    levelsByBand.set(p.ordinal, [...(levelsByBand.get(p.ordinal) ?? []), level]);
  }
  return [...levelsByBand]
    .sort(([a], [b]) => b - a)
    .map(([ordinal, unordered]) => {
      const levels = [...unordered].sort(
        (a, b) =>
          compareNames(a.venueName ?? "", b.venueName ?? "") ||
          a.sortKey - b.sortKey ||
          compareNames(a.name, b.name),
      );
      return {
        ordinal,
        label: bandLabel(ordinal, levels),
        description: bandDescription(ordinal, levels),
        levels,
      };
    });
}

/**
 * The band to show for the one asked for (by the URL or the switcher): that band while the loaded
 * version has it, the street band otherwise (no version yet, or a link to a band it doesn't have).
 */
export function bandToShow(requested: number, bands: readonly Band[]): number {
  return bands.some((band) => band.ordinal === requested) ? requested : STREET_BAND;
}
