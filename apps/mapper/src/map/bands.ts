// The Map tab's level switcher: one button per display band (`ordinal`: 0 the street, -1 the first
// basement band, and so on; docs/spec.md, "Levels and height"), top to bottom, the street band
// always among them. A band's label is the names its levels are signed with ("B2", "Concourse"),
// never the ordinal, kept short for a phone; the switcher's title names the venues. The map shows a
// band with @usg/map-style's applyBand.

import { type IndoorSnapshot, isIndoorFeature } from "@usg/contracts";
import { STREET_BAND } from "@usg/map-style";

export interface Band {
  readonly ordinal: number;
  /** "Street", or the band's distinct level names: "B2 · Concourse", "B1 · B2 +1". */
  readonly label: string;
  /** The levels by venue: "City Hall MRT Concourse · Funan B2". */
  readonly title: string;
}

/** At most this many level names in a label; the rest are counted. */
export const MAX_LABEL_NAMES = 2;

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

interface Level {
  readonly name: string;
  readonly venue: string;
  readonly sortKey: number;
}

function label(ordinal: number, levels: readonly Level[]): string {
  if (ordinal === STREET_BAND) return "Street";
  const ordered = [...levels].sort(
    (a, b) => a.sortKey - b.sortKey || collator.compare(a.name, b.name),
  );
  const names = [...new Set(ordered.map((level) => level.name.trim()).filter(Boolean))];
  if (names.length === 0) return `Band ${ordinal}`;
  if (names.length <= MAX_LABEL_NAMES) return names.join(" · ");
  return `${names.slice(0, MAX_LABEL_NAMES).join(" · ")} +${names.length - MAX_LABEL_NAMES}`;
}

function title(ordinal: number, levels: readonly Level[]): string {
  const byVenue = new Map<string, string[]>();
  for (const level of [...levels].sort(
    (a, b) => collator.compare(a.venue, b.venue) || a.sortKey - b.sortKey,
  )) {
    byVenue.set(level.venue, [...(byVenue.get(level.venue) ?? []), level.name]);
  }
  const parts = [...byVenue].map(([venue, names]) =>
    venue === "" ? names.join(", ") : `${venue} ${names.join(", ")}`,
  );
  if (ordinal === STREET_BAND) return ["Street level", ...parts].join(" · ");
  return parts.length > 0 ? parts.join(" · ") : `Band ${ordinal}`;
}

/** The bands of a version's levels, top to bottom; just the street band without a version. */
export function levelBands(indoor: IndoorSnapshot | undefined): Band[] {
  const venues = new Map<string, string>();
  const byBand = new Map<number, Level[]>([[STREET_BAND, []]]);
  for (const feature of indoor?.features ?? []) {
    if (isIndoorFeature(feature, "venue")) venues.set(feature.id, feature.properties.name);
  }
  for (const feature of indoor?.features ?? []) {
    if (!isIndoorFeature(feature, "level")) continue;
    const p = feature.properties;
    const level = { name: p.name, venue: venues.get(p.venue_id) ?? "", sortKey: p.sort_key };
    byBand.set(p.ordinal, [...(byBand.get(p.ordinal) ?? []), level]);
  }
  return [...byBand]
    .sort(([a], [b]) => b - a)
    .map(([ordinal, levels]) => ({
      ordinal,
      label: label(ordinal, levels),
      title: title(ordinal, levels),
    }));
}

/** The band to show: the one chosen while the loaded version has it, the street band otherwise. */
export function bandToShow(chosen: number, bands: readonly Band[]): number {
  return bands.some((band) => band.ordinal === chosen) ? chosen : STREET_BAND;
}
