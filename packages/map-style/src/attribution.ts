// Attribution, as the HTML strings MapLibre's attribution control shows. Every map view shows all
// three (docs/spec.md, "Map display and street-to-street routing"). MapLibre shows a source's
// attribution only while one of that source's layers is drawn at the current zoom (not below its
// minzoom, not visibility "none"), so the style puts all three on the basemap source, whose layer is
// drawn at every zoom and on every band (mapAttribution). The indoor and street sources carry
// their own as well; MapLibre drops an entry that another one contains.
//
// MapLibre GL JS 6.14 sanitizes each attribution before it shows it: it keeps only some tags and
// attributes (src/util/dom.ts, ALLOWED_TAGS and ALLOWED_ATTRIBUTES; `style` is not one), so the
// HTML here uses only those, and what it renders is what is written here.

import type { Attribution } from "@usg/contracts";

/**
 * OneMap's attribution snippet with its logo, verbatim from https://www.onemap.gov.sg/docs/maps/
 * (https://www.onemap.gov.sg/docs/maps/resources/code-attr.txt; "you MUST include the OneMap logo
 * and attribution", under OneMap's Terms of Use). Kept for reference: don't edit it, and don't give
 * it to MapLibre, whose sanitizer drops the logo's `style` attribute, so the 32 x 32 px image
 * would show at full size. Use ONEMAP_ATTRIBUTION.
 */
export const ONEMAP_SNIPPET =
  '<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" style="height:20px;width:20px;"/>&nbsp;<a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener noreferrer">OneMap</a>&nbsp;&copy;&nbsp;contributors&nbsp;&#124;&nbsp;<a href="https://www.sla.gov.sg/" target="_blank" rel="noopener noreferrer">Singapore Land Authority</a>';

/**
 * OneMap's snippet as MapLibre renders it: the same HTML, with the logo sized by its `width` and
 * `height` attributes (20 x 20 px, as the snippet's style asks) instead of a `style` attribute,
 * which MapLibre's sanitizer would drop. Everything else is ONEMAP_SNIPPET, verbatim.
 */
export const ONEMAP_ATTRIBUTION = ONEMAP_SNIPPET.replace(
  ' style="height:20px;width:20px;"/>',
  ' width="20" height="20"/>',
);

/** OpenStreetMap's attribution, for the street graph (ODbL). */
export const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

/** The LTA MRT Station Exit (GEOJSON) dataset on data.gov.sg: the exits' positions. */
export const LTA_EXIT_DATASET_URL =
  "https://data.gov.sg/datasets/d_b39d3a0871985372d7e1637193335da5/view";

/** The Singapore Open Data Licence version 1.0. */
export const SINGAPORE_OPEN_DATA_LICENCE_URL = "https://data.gov.sg/open-data-licence";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function link(url: string, text: string): string {
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
}

/**
 * The Singapore Open Data Licence attribution for LTA's MRT exit data, in the licence's form:
 * "Contains information from {dataset} accessed on {date} from {source} which is made available
 * under the terms of the Singapore Open Data Licence version 1.0". `accessedOn` is the date the
 * exits were imported, as text, for example "20 October 2026"; without it the date is left out.
 */
export function ltaExitAttribution(accessedOn?: string): string {
  const accessed = accessedOn === undefined ? "" : ` accessed on ${escapeHtml(accessedOn)}`;
  return `Contains information from ${link(LTA_EXIT_DATASET_URL, "LTA MRT Station Exit (GEOJSON)")}${accessed} from data.gov.sg which is made available under the terms of the ${link(SINGAPORE_OPEN_DATA_LICENCE_URL, "Singapore Open Data Licence version 1.0")}`;
}

/**
 * Everything a map view must credit, as one attribution: OneMap's (with its logo), OpenStreetMap's
 * and LTA's, separated as MapLibre separates entries. The style gives it to the basemap source,
 * so MapLibre shows all three at every zoom and on every band.
 */
export function mapAttribution(ltaExitDataAccessedOn?: string): string {
  return [ONEMAP_ATTRIBUTION, OSM_ATTRIBUTION, ltaExitAttribution(ltaExitDataAccessedOn)].join(
    " | ",
  );
}

/** One of latest.json's plain-text attributions as HTML: its text, escaped, linked to its URL. */
export function attributionHtml(attribution: Attribution): string {
  return link(attribution.url, attribution.text);
}
