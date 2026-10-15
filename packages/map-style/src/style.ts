// The MapLibre style (style spec v8) shared by the webapp and the mapper app: OneMap raster tiles,
// the street graph from street.json, and the indoor layers from indoor.json, filtered by level
// band. Environment-neutral: it builds plain JSON, so it runs in a browser, in the mapper app's
// DOM component and in Node tests.

import type {
  ExpressionSpecification,
  FilterSpecification,
  GeoJSONSourceSpecification,
  LayerSpecification,
  StyleSpecification,
} from "@maplibre/maplibre-gl-style-spec";
import {
  CONNECTOR_EDGE_KINDS,
  type IndoorSnapshot,
  type StatusOverlay,
  type StreetSnapshot,
} from "@usg/contracts";
import { ltaExitAttribution, mapAttribution, OSM_ATTRIBUTION } from "./attribution.ts";
import {
  inBand,
  levelFilter,
  levelOpacity,
  levelSortKey,
  type OtherBands,
  STREET_BAND,
} from "./levels.ts";
import {
  ONEMAP_BOUNDS,
  ONEMAP_MIN_ZOOM,
  type OneMapBasemap,
  oneMapMaxZoom,
  oneMapTileSize,
  oneMapTiles,
} from "./onemap.ts";
import {
  BACKGROUND_COLOR,
  CASING_COLOR,
  CLOSED_COLOR,
  EDGE_COLORS,
  LABEL_COLORS,
  NODE_COLORS,
  POI_COLORS,
  SPACE_COLORS,
  SPACE_OUTLINE_COLOR,
  STREET_COLORS,
  VENUE_OUTLINE_COLOR,
} from "./palette.ts";

/** The style's source ids. */
export const SOURCES = { basemap: "onemap", indoor: "indoor", street: "street" } as const;

/**
 * The one font stack the style uses: a directory of glyph PBFs in this package's glyphs/
 * (Noto Sans Regular, SIL Open Font License; see glyphs/README.md).
 */
export const FONT_STACK = "Noto Sans Regular";

/** The glyph ranges vendored in glyphs/: Latin-1, Latin Extended-A, General Punctuation. */
export const GLYPH_RANGES = ["0-255", "256-511", "8192-8447"] as const;

export interface MapStyleOptions {
  /**
   * URL template of the glyph PBFs, with `{fontstack}` and `{range}`: where the app serves this
   * package's glyphs/ directory, for example "/glyphs/{fontstack}/{range}.pbf".
   */
  readonly glyphs: string;
  /** The OneMap basemap. Default: Grey, on which the indoor layers read best. */
  readonly basemap?: OneMapBasemap;
  /**
   * OneMap's HD tiles (drawn for 2x screens; OneMap's own style uses them) or standard ones.
   * Default: true.
   */
  readonly hd?: boolean;
  /** indoor.json: its URL, or the parsed file. Omitted: an empty source. */
  readonly indoor?: string | IndoorSnapshot;
  /** street.json: its URL, or the parsed file. Omitted: an empty source. */
  readonly street?: string | StreetSnapshot;
  /** The ordinal band shown in full. Default: 0, the street band. */
  readonly band?: number;
  /** Whether features outside the band fade (the default) or are hidden. */
  readonly otherBands?: OtherBands;
  /**
   * When the LTA exit data was accessed, for its attribution, as text such as "20 October 2026".
   * Omitted: the attribution leaves the date out.
   */
  readonly ltaExitDataAccessedOn?: string;
}

const EMPTY_COLLECTION = { type: "FeatureCollection", features: [] };

function featureType(type: string): ExpressionSpecification {
  return ["==", ["get", "feature_type"], type];
}

function all(...filters: (ExpressionSpecification | undefined)[]): FilterSpecification {
  const kept = filters.filter((filter) => filter !== undefined);
  return kept.length === 1 ? (kept[0] as ExpressionSpecification) : ["all", ...kept];
}

function matchColor(
  property: string,
  colors: Readonly<Record<string, string>>,
  fallback: string,
): ExpressionSpecification {
  // A spread can't satisfy the tuple type of "match" (input, then label-output pairs).
  return [
    "match",
    ["get", property],
    ...Object.entries(colors).flat(),
    fallback,
  ] as unknown as ExpressionSpecification;
}

function byZoom(stops: readonly (readonly [number, unknown])[]): ExpressionSpecification {
  return ["interpolate", ["linear"], ["zoom"], ...stops.flat()] as ExpressionSpecification;
}

/** The feature state applyStatus sets on features the status overlay marks closed. */
export const CLOSED_STATE = "closed";

/** True for a feature the status overlay marks closed (see applyStatus). */
const CLOSED: ExpressionSpecification = ["boolean", ["feature-state", CLOSED_STATE], false];

const CONNECTOR_EDGE: ExpressionSpecification = [
  "in",
  ["get", "kind"],
  ["literal", [...CONNECTOR_EDGE_KINDS]],
];

const EXIT: ExpressionSpecification = ["in", ["get", "kind"], ["literal", ["exit", "entrance"]]];

/** An exit's label: the street or building it opens onto, after its own name if it has one. */
const EXIT_LABEL: ExpressionSpecification = [
  "case",
  ["all", ["!=", ["get", "name"], null], ["!=", ["get", "street_name"], null]],
  ["concat", ["get", "name"], " · ", ["get", "street_name"]],
  ["coalesce", ["get", "street_name"], ["get", "name"], ""],
];

const LABEL_PAINT = {
  "text-color": LABEL_COLORS.text,
  "text-halo-color": LABEL_COLORS.halo,
  "text-halo-width": 1.25,
} as const;

/** Opacity of a faded band's features, by kind of mark. */
const FADED = { fill: 0.12, line: 0.2, circle: 0.2 } as const;

/**
 * The style's layers for a band, bottom to top. Everything that depends on the band (filters,
 * opacities, sort keys, the street graph's visibility) is computed here, so `applyBand` can
 * update a live map to match `createMapStyle`.
 */
export function mapLayers(band: number, otherBands: OtherBands = "fade"): LayerSpecification[] {
  const filter = levelFilter(band, otherBands);
  const sortKey = levelSortKey(band);
  const opacity = (full: number, faded: number) => levelOpacity(band, otherBands, full, faded);
  const onStreetBand = band === STREET_BAND;
  const outdoor = (value: boolean): ExpressionSpecification => ["==", ["get", "outdoor"], value];
  const edgeLine = (id: string, isOutdoor: boolean): LayerSpecification => ({
    id,
    type: "line",
    source: SOURCES.indoor,
    minzoom: 16,
    filter: all(featureType("edge"), outdoor(isOutdoor), filter),
    layout: {
      "line-cap": isOutdoor ? "butt" : "round",
      "line-join": "round",
      "line-sort-key": sortKey,
    },
    paint: {
      "line-color": [
        "case",
        CLOSED,
        CLOSED_COLOR,
        matchColor("kind", EDGE_COLORS, EDGE_COLORS.walk),
      ],
      "line-width": byZoom([
        [16, ["case", CONNECTOR_EDGE, 2.5, 1]],
        [21, ["case", CONNECTOR_EDGE, 8, 4]],
      ]),
      // A closed edge is a double line (two lines of line-width either side of a gap), so the
      // closure doesn't depend on colour alone.
      "line-gap-width": byZoom([
        [16, ["case", CLOSED, 2, 0]],
        [21, ["case", CLOSED, 4, 0]],
      ]),
      "line-opacity": opacity(1, FADED.line),
      ...(isOutdoor ? { "line-dasharray": [2, 1.5] } : {}),
    },
  });

  return [
    {
      // Under everything: the dimmed basemap blends with it, and it shows where there are no
      // tiles, so the map looks the same whatever the page or WebView behind it.
      id: "background",
      type: "background",
      paint: { "background-color": BACKGROUND_COLOR },
    },
    {
      id: "onemap",
      type: "raster",
      source: SOURCES.basemap,
      // Dimmed below street level, so the indoor layers stand out.
      paint: { "raster-opacity": onStreetBand ? 1 : 0.6 },
    },
    {
      id: "venue-outline",
      type: "line",
      source: SOURCES.indoor,
      minzoom: 15,
      filter: featureType("venue"),
      paint: {
        "line-color": VENUE_OUTLINE_COLOR,
        "line-width": 1.5,
        "line-dasharray": [3, 2],
        "line-opacity": 0.8,
      },
    },
    {
      id: "space-fill",
      type: "fill",
      source: SOURCES.indoor,
      minzoom: 16,
      filter: all(featureType("space"), filter),
      layout: { "fill-sort-key": sortKey },
      paint: {
        "fill-color": matchColor("kind", SPACE_COLORS, SPACE_COLORS.other),
        "fill-opacity": opacity(0.85, FADED.fill),
      },
    },
    {
      id: "space-outline",
      type: "line",
      source: SOURCES.indoor,
      minzoom: 16,
      filter: all(featureType("space"), filter),
      layout: { "line-sort-key": sortKey },
      paint: {
        "line-color": SPACE_OUTLINE_COLOR,
        "line-width": byZoom([
          [16, 0.5],
          [20, 1.5],
        ]),
        "line-opacity": opacity(0.9, FADED.line),
      },
    },
    {
      id: "street-edge",
      type: "line",
      source: SOURCES.street,
      minzoom: 15,
      filter: featureType("street_edge"),
      layout: {
        "line-cap": "round",
        "line-join": "round",
        visibility: otherBands === "hide" && !onStreetBand ? "none" : "visible",
      },
      paint: {
        "line-color": ["case", ["get", "covered"], STREET_COLORS.covered, STREET_COLORS.footpath],
        "line-width": byZoom([
          [15, 1],
          [20, 4],
        ]),
        "line-opacity": onStreetBand ? 0.9 : 0.3,
      },
    },
    {
      id: "street-connector",
      type: "line",
      source: SOURCES.indoor,
      minzoom: 16,
      filter: all(featureType("street_connector"), filter),
      paint: {
        "line-color": STREET_COLORS.connector,
        "line-width": 2,
        "line-dasharray": [1, 1],
        "line-opacity": opacity(0.9, FADED.line),
      },
    },
    {
      // A white halo under vertical connectors, so escalators, stairs and lifts stand out.
      id: "edge-connector-casing",
      type: "line",
      source: SOURCES.indoor,
      minzoom: 16,
      filter: all(featureType("edge"), CONNECTOR_EDGE, filter),
      layout: { "line-cap": "round", "line-join": "round", "line-sort-key": sortKey },
      paint: {
        "line-color": CASING_COLOR,
        "line-width": byZoom([
          [16, 5],
          [21, 14],
        ]),
        "line-opacity": opacity(1, FADED.line),
      },
    },
    edgeLine("edge", false),
    // Outdoor edges are dashed. line-dasharray is data-driven only in newer renderers, so they
    // get a layer of their own.
    edgeLine("edge-outdoor", true),
    {
      id: "node",
      type: "circle",
      source: SOURCES.indoor,
      minzoom: 17,
      filter: all(featureType("node"), ["!=", ["get", "kind"], "junction"], filter),
      layout: { "circle-sort-key": sortKey },
      paint: {
        // A closed node is a hollow ring in CLOSED_COLOR, so the closure doesn't depend on
        // colour alone.
        "circle-color": [
          "case",
          CLOSED,
          CASING_COLOR,
          matchColor("kind", NODE_COLORS, NODE_COLORS.junction),
        ],
        "circle-radius": byZoom([
          [17, ["case", EXIT, 4, 3]],
          [21, ["case", EXIT, 9, 7]],
        ]),
        "circle-stroke-color": ["case", CLOSED, CLOSED_COLOR, CASING_COLOR],
        "circle-stroke-width": ["case", CLOSED, 3, 1.5],
        "circle-opacity": opacity(1, FADED.circle),
        "circle-stroke-opacity": opacity(1, FADED.circle),
      },
    },
    {
      id: "poi",
      type: "circle",
      source: SOURCES.indoor,
      minzoom: 18,
      filter: all(featureType("poi"), filter),
      layout: { "circle-sort-key": sortKey },
      paint: {
        "circle-color": matchColor("category", POI_COLORS, POI_COLORS.other),
        "circle-radius": byZoom([
          [18, 3],
          [21, 6],
        ]),
        "circle-stroke-color": CASING_COLOR,
        "circle-stroke-width": 1,
        "circle-opacity": opacity(1, FADED.circle),
        "circle-stroke-opacity": opacity(1, FADED.circle),
      },
    },
    // Labels show only the selected band, whichever way the other bands are drawn.
    {
      id: "space-label",
      type: "symbol",
      source: SOURCES.indoor,
      minzoom: 18,
      filter: all(featureType("space"), ["!=", ["get", "name"], null], inBand(band)),
      layout: {
        "text-field": ["get", "name"],
        "text-font": [FONT_STACK],
        "text-size": 11,
        "text-max-width": 8,
      },
      paint: LABEL_PAINT,
    },
    {
      id: "poi-label",
      type: "symbol",
      source: SOURCES.indoor,
      minzoom: 18,
      filter: all(featureType("poi"), inBand(band)),
      layout: {
        "text-field": ["get", "name"],
        "text-font": [FONT_STACK],
        "text-size": 11,
        "text-anchor": "top",
        "text-offset": [0, 0.8],
        "text-max-width": 8,
      },
      paint: LABEL_PAINT,
    },
    {
      // Exits are labelled with the street they open onto: on their own band, and on the
      // street band, which shows every exit whatever its band.
      id: "exit-label",
      type: "symbol",
      source: SOURCES.indoor,
      minzoom: 16,
      filter: all(featureType("node"), EXIT, onStreetBand ? undefined : inBand(band)),
      layout: {
        "text-field": EXIT_LABEL,
        "text-font": [FONT_STACK],
        "text-size": 12,
        "text-anchor": "top",
        "text-offset": [0, 0.9],
        "text-max-width": 10,
      },
      paint: { ...LABEL_PAINT, "text-color": LABEL_COLORS.exit },
    },
  ];
}

/** The style's layer ids, bottom to top. */
export const LAYER_IDS: readonly string[] = mapLayers(STREET_BAND).map((layer) => layer.id);

function geojsonData(data: string | object | undefined): GeoJSONSourceSpecification["data"] {
  return (data ?? EMPTY_COLLECTION) as unknown as GeoJSONSourceSpecification["data"];
}

/** Builds the style. */
export function createMapStyle(options: MapStyleOptions): StyleSpecification {
  const { glyphs, basemap = "Grey", hd = true, band = STREET_BAND, otherBands = "fade" } = options;
  if (!glyphs.includes("{fontstack}") || !glyphs.includes("{range}")) {
    throw new Error("The glyphs URL template needs {fontstack} and {range}");
  }
  return {
    version: 8,
    name: "Underground SG",
    glyphs,
    sources: {
      [SOURCES.basemap]: {
        type: "raster",
        tiles: [oneMapTiles(basemap, hd)],
        tileSize: oneMapTileSize(hd),
        minzoom: ONEMAP_MIN_ZOOM,
        maxzoom: oneMapMaxZoom(hd),
        bounds: [...ONEMAP_BOUNDS],
        // All three attributions: MapLibre shows a source's attribution only while one of its
        // layers is drawn, and the basemap's layer is drawn at every zoom and on every band,
        // unlike the street and indoor layers (attribution.ts).
        attribution: mapAttribution(options.ltaExitDataAccessedOn),
      },
      [SOURCES.street]: {
        type: "geojson",
        data: geojsonData(options.street),
        attribution: OSM_ATTRIBUTION,
      },
      [SOURCES.indoor]: {
        type: "geojson",
        data: geojsonData(options.indoor),
        // MapLibre identifies GeoJSON features only by numeric ids or a promoted property;
        // indoor.json repeats each feature's UUID as properties.id for this.
        promoteId: "id",
        attribution: ltaExitAttribution(options.ltaExitDataAccessedOn),
      },
    },
    layers: mapLayers(band, otherBands),
  };
}

/** The parts of a MapLibre map that `applyBand` uses. */
export interface BandTarget {
  setFilter(layerId: string, filter: FilterSpecification | null): unknown;
  setPaintProperty(layerId: string, name: string, value: unknown): unknown;
  setLayoutProperty(layerId: string, name: string, value: unknown): unknown;
}

/**
 * Switches a map built from `createMapStyle` to another band without rebuilding the style: sets
 * every layer's filter, paint and layout properties to what `mapLayers` gives for the band.
 */
export function applyBand(map: BandTarget, band: number, otherBands: OtherBands = "fade"): void {
  for (const layer of mapLayers(band, otherBands)) {
    if ("filter" in layer) map.setFilter(layer.id, layer.filter ?? null);
    for (const [name, value] of Object.entries(layer.paint ?? {})) {
      map.setPaintProperty(layer.id, name, value);
    }
    for (const [name, value] of Object.entries(layer.layout ?? {})) {
      map.setLayoutProperty(layer.id, name, value);
    }
  }
}

/** The ids of the nodes and edges status.json says are closed at `at`. */
export function closedFeatureIds(overlay: StatusOverlay, at: Date): string[] {
  const time = at.getTime();
  return overlay.entries
    .filter(
      (entry) =>
        !entry.is_open &&
        Date.parse(entry.valid_from) <= time &&
        (entry.valid_until === null || time < Date.parse(entry.valid_until)),
    )
    .map((entry) => entry.feature_id);
}

/** The parts of a MapLibre map that `applyStatus` uses. */
export interface FeatureStateTarget {
  setFeatureState(feature: { source: string; id: string }, state: Record<string, unknown>): unknown;
  removeFeatureState(target: { source: string; id?: string }, key?: string): unknown;
}

/** The ids each map's last applyStatus marked closed, so the next call can clear just those. */
const closedOnMap = new WeakMap<FeatureStateTarget, readonly string[]>();

/**
 * Marks the features status.json says are closed at `at` (default now) with the feature state
 * `closed`, which the node and edge layers draw as closed, and removes that key from features
 * this function marked on the same map before that are no longer closed. Other feature state on
 * the indoor source (a highlighted route, a hovered feature) is left alone. Ids the loaded
 * indoor.json doesn't have are ignored by the map. Returns the ids marked closed.
 */
export function applyStatus(
  map: FeatureStateTarget,
  overlay: StatusOverlay,
  at: Date = new Date(),
): string[] {
  const closed = closedFeatureIds(overlay, at);
  const stillClosed = new Set(closed);
  for (const id of closedOnMap.get(map) ?? []) {
    if (!stillClosed.has(id)) map.removeFeatureState({ source: SOURCES.indoor, id }, CLOSED_STATE);
  }
  for (const id of closed) {
    map.setFeatureState({ source: SOURCES.indoor, id }, { [CLOSED_STATE]: true });
  }
  closedOnMap.set(map, closed);
  return closed;
}
