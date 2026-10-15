// The level band in the URL, next to the camera MapLibre keeps there: #map=18.5/1.2925/103.852&level=-2.
// A reload (which iOS Safari does to a tab it has put away) or a shared link then comes back on
// the same band as well as the same view. MapLibre's named hash keeps the other parameters when it
// writes `map`, and this keeps `map` when it writes `level`. The street band leaves `level` out.

import { STREET_BAND } from "@usg/map-style";

/** The hash parameter that holds the band's ordinal. */
export const LEVEL_PARAM = "level";

function hashParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.replace(/^#/, ""));
}

/** The band a URL hash asks for, or undefined when it names none (or not as an integer). */
export function levelFromHash(hash: string): number | undefined {
  const value = hashParams(hash).get(LEVEL_PARAM);
  if (value === null || !/^-?\d{1,3}$/.test(value)) return undefined;
  return Number(value);
}

/** `hash` with its band set to `band`, keeping every other parameter; "" when none is left. */
export function hashWithLevel(hash: string, band: number): string {
  const params = hashParams(hash);
  if (band === STREET_BAND) params.delete(LEVEL_PARAM);
  else params.set(LEVEL_PARAM, String(band));
  // URLSearchParams escapes the slashes in MapLibre's map=zoom/lat/lon; keep them readable, as
  // MapLibre writes them. Both forms read back the same.
  const text = params.toString().replaceAll("%2F", "/");
  return text === "" ? "" : `#${text}`;
}

/** `href` with its hash replaced by `hash` ("" removes it). */
export function withHash(href: string, hash: string): string {
  return href.replace(/(#.*)?$/, hash);
}
