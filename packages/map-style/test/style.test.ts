import {
  expression,
  type Feature,
  type FilterSpecification,
  featureFilter,
  type LayerSpecification,
  latest,
  type StylePropertySpecification,
  validateStyleMin,
} from "@maplibre/maplibre-gl-style-spec";
import {
  EDGE_KINDS,
  type IndoorSnapshot,
  NODE_KINDS,
  POI_CATEGORIES,
  SPACE_KINDS,
  type StatusOverlay,
  type StreetSnapshot,
} from "@usg/contracts";
import { validateSnapshotFile } from "@usg/contracts/validators";
import { describe, expect, test } from "vitest";
import {
  applyBand,
  applyStatus,
  BACKGROUND_COLOR,
  type BandTarget,
  CASING_COLOR,
  CLOSED_COLOR,
  closedFeatureIds,
  createMapStyle,
  EDGE_COLORS,
  type FeatureStateTarget,
  FONT_STACK,
  inBand,
  LAYER_IDS,
  ltaExitAttribution,
  type MapStyleOptions,
  mapAttribution,
  mapLayers,
  NODE_COLORS,
  ONEMAP_ATTRIBUTION,
  ONEMAP_BASEMAPS,
  ONEMAP_SNIPPET,
  OSM_ATTRIBUTION,
  type OtherBands,
  POI_COLORS,
  SOURCES,
  SPACE_COLORS,
} from "../src/index.ts";

const GLYPHS = "/glyphs/{fontstack}/{range}.pbf";

// Synthetic data at real City Hall cluster coordinates: Funan B2 (band -2), an escalator up to B1
// (band -1), and a street exit on North Bridge Road (band 0).
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const INDOOR: IndoorSnapshot = {
  type: "FeatureCollection",
  schema_version: 1,
  features: [
    {
      type: "Feature",
      id: id(1),
      properties: { feature_type: "venue", id: id(1), name: "Funan", kind: "mall" },
      geometry: null,
    },
    {
      type: "Feature",
      id: id(2),
      properties: {
        feature_type: "level",
        id: id(2),
        venue_id: id(1),
        name: "B2",
        ordinal: -2,
        sort_key: 0,
        elevation_m: -9.5,
      },
      geometry: null,
    },
    {
      type: "Feature",
      id: id(3),
      properties: {
        feature_type: "level",
        id: id(3),
        venue_id: id(1),
        name: "B1",
        ordinal: -1,
        sort_key: 0,
        elevation_m: -4.5,
      },
      geometry: null,
    },
    {
      type: "Feature",
      id: id(4),
      properties: {
        feature_type: "space",
        id: id(4),
        level_id: id(2),
        ordinal: -2,
        kind: "walkway",
        name: "Funan B2 link",
      },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [103.8497, 1.2911],
            [103.8504, 1.2911],
            [103.8504, 1.2916],
            [103.8497, 1.2916],
            [103.8497, 1.2911],
          ],
        ],
      },
    },
    {
      type: "Feature",
      id: id(5),
      properties: {
        feature_type: "node",
        id: id(5),
        level_id: id(2),
        ordinal: -2,
        kind: "escalator",
        name: null,
        street_name: null,
        connector_id: id(99),
      },
      geometry: { type: "Point", coordinates: [103.8499, 1.2913] },
    },
    {
      type: "Feature",
      id: id(6),
      properties: {
        feature_type: "node",
        id: id(6),
        level_id: id(3),
        ordinal: -1,
        kind: "escalator",
        name: null,
        street_name: null,
        connector_id: id(99),
      },
      geometry: { type: "Point", coordinates: [103.84995, 1.29135] },
    },
    {
      type: "Feature",
      id: id(7),
      properties: {
        feature_type: "node",
        id: id(7),
        level_id: null,
        ordinal: 0,
        kind: "exit",
        name: "Exit B",
        street_name: "North Bridge Road",
        connector_id: null,
      },
      geometry: { type: "Point", coordinates: [103.8506, 1.2928] },
    },
    {
      type: "Feature",
      id: id(8),
      properties: {
        feature_type: "edge",
        id: id(8),
        from_node: id(5),
        to_node: id(6),
        from_ordinal: -2,
        to_ordinal: -1,
        level_id: null,
        kind: "escalator",
        connector_id: id(99),
        oneway: true,
        access: "public",
        opening_hours: null,
        length_m: 9.8,
        step_free: false,
        sheltered: true,
        outdoor: false,
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [103.8499, 1.2913],
          [103.84995, 1.29135],
        ],
      },
    },
    {
      type: "Feature",
      id: id(9),
      properties: {
        feature_type: "poi",
        id: id(9),
        level_id: id(2),
        ordinal: -2,
        space_id: id(4),
        name: "McDonald’s",
        category: "food",
      },
      geometry: { type: "Point", coordinates: [103.85, 1.2914] },
    },
  ],
};

const STREET: StreetSnapshot = {
  type: "FeatureCollection",
  schema_version: 1,
  source: {
    name: "OpenStreetMap",
    licence: "ODbL-1.0",
    licence_url: "https://opendatacommons.org/licenses/odbl/1-0/",
    attribution: "© OpenStreetMap contributors",
    attribution_url: "https://www.openstreetmap.org/copyright",
  },
  features: [
    {
      type: "Feature",
      id: 1001,
      properties: { feature_type: "street_node" },
      geometry: { type: "Point", coordinates: [103.8507, 1.29285] },
    },
    {
      type: "Feature",
      id: 1002,
      properties: { feature_type: "street_node" },
      geometry: { type: "Point", coordinates: [103.8515, 1.293] },
    },
    {
      type: "Feature",
      properties: {
        feature_type: "street_edge",
        osm_way_id: 2001,
        from_osm_node: 1001,
        to_osm_node: 1002,
        highway: "footway",
        footway: "sidewalk",
        covered: true,
        length_m: 92.31,
      },
      geometry: {
        type: "LineString",
        coordinates: [
          [103.8507, 1.29285],
          [103.8515, 1.293],
        ],
      },
    },
  ],
};

describe("the test data", () => {
  test("is a valid indoor.json and street.json", () => {
    expect(validateSnapshotFile("indoor.json", INDOOR)).toEqual({ valid: true, problems: [] });
    expect(validateSnapshotFile("street.json", STREET)).toEqual({ valid: true, problems: [] });
  });
});

const DATA: Record<string, Pick<MapStyleOptions, "indoor" | "street">> = {
  "no data": {},
  "data URLs": {
    indoor: "https://maps.example/snapshots/abc/indoor.json",
    street: "https://maps.example/snapshots/abc/street.json",
  },
  "data passed in": { indoor: INDOOR, street: STREET },
};

const cases = ONEMAP_BASEMAPS.flatMap((basemap) =>
  [true, false].flatMap((hd) =>
    Object.keys(DATA).flatMap((data) =>
      [0, -1, -2].flatMap((band) =>
        (["fade", "hide"] as const).map((otherBands) => ({ basemap, hd, data, band, otherBands })),
      ),
    ),
  ),
);

describe("the style validates against the MapLibre style spec", () => {
  test.each(cases)("$basemap, hd $hd, $data, band $band, $otherBands", (c) => {
    const style = createMapStyle({
      glyphs: GLYPHS,
      basemap: c.basemap,
      hd: c.hd,
      band: c.band,
      otherBands: c.otherBands,
      ...DATA[c.data],
    });
    expect(validateStyleMin(style)).toEqual([]);
    expect(style.layers.map((layer) => layer.id)).toEqual(LAYER_IDS);
  });

  test("with the LTA access date", () => {
    const style = createMapStyle({ glyphs: GLYPHS, ltaExitDataAccessedOn: "20 October 2026" });
    expect(validateStyleMin(style)).toEqual([]);
  });
});

describe("OneMap basemap", () => {
  test.each([
    ["Grey", true, "https://www.onemap.gov.sg/maps/tiles/Grey_HD/{z}/{x}/{y}.png", 128],
    ["Grey", false, "https://www.onemap.gov.sg/maps/tiles/Grey/{z}/{x}/{y}.png", 256],
    ["Default", true, "https://www.onemap.gov.sg/maps/tiles/Default_HD/{z}/{x}/{y}.png", 128],
    ["Default", false, "https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png", 256],
  ] as const)("%s, hd %s: %s at tile size %d", (basemap, hd, url, tileSize) => {
    const source = createMapStyle({ glyphs: GLYPHS, basemap, hd }).sources[SOURCES.basemap];
    expect(source).toMatchObject({ type: "raster", tiles: [url], tileSize });
  });

  test("defaults to Grey HD tiles", () => {
    const source = createMapStyle({ glyphs: GLYPHS }).sources[SOURCES.basemap];
    expect(source).toMatchObject({ tiles: [expect.stringContaining("/Grey_HD/")] });
  });

  test("stops at zoom 20 for HD tiles and 19 for standard ones; the indoor zooms overzoom", () => {
    const hd = createMapStyle({ glyphs: GLYPHS }).sources[SOURCES.basemap];
    expect(hd).toMatchObject({ minzoom: 11, maxzoom: 20 });
    const standard = createMapStyle({ glyphs: GLYPHS, hd: false }).sources[SOURCES.basemap];
    expect(standard).toMatchObject({ minzoom: 11, maxzoom: 19 });
    const layer = createMapStyle({ glyphs: GLYPHS }).layers.find((l) => l.id === "onemap");
    expect(layer).toMatchObject({ id: "onemap", type: "raster" });
    expect(layer).not.toHaveProperty("maxzoom");
    expect(layer).not.toHaveProperty("minzoom");
  });

  test("keeps OneMap's snippet verbatim, and sizes the logo with attributes MapLibre keeps", () => {
    expect(ONEMAP_SNIPPET).toBe(
      '<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" style="height:20px;width:20px;"/>&nbsp;<a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener noreferrer">OneMap</a>&nbsp;&copy;&nbsp;contributors&nbsp;&#124;&nbsp;<a href="https://www.sla.gov.sg/" target="_blank" rel="noopener noreferrer">Singapore Land Authority</a>',
    );
    // Only the logo's sizing differs: attributes instead of a style.
    expect(ONEMAP_ATTRIBUTION).toBe(
      ONEMAP_SNIPPET.replace('style="height:20px;width:20px;"', 'width="20" height="20"'),
    );
    expect(ONEMAP_ATTRIBUTION).not.toBe(ONEMAP_SNIPPET);
    expect(createMapStyle({ glyphs: GLYPHS }).sources[SOURCES.basemap]).toMatchObject({
      attribution: mapAttribution(),
    });
    expect(mapAttribution().startsWith(`${ONEMAP_ATTRIBUTION} | `)).toBe(true);
  });
});

// MapLibre GL JS 6.14's attribution sanitizer (src/util/dom.ts): it removes other tags, other
// attributes, and href or src values that aren't http, https or mailto URLs.
const MAPLIBRE_ALLOWED_TAGS = new Set(
  "a abbr b bdi bdo br cite code del div em i img ins kbd li mark ol p q s samp small span strong sub sup time u ul var wbr".split(
    " ",
  ),
);
const MAPLIBRE_ALLOWED_ATTRIBUTES = new Set(
  "alt class datetime dir height href hreflang lang referrerpolicy rel role src target title translate type width".split(
    " ",
  ),
);

/** What MapLibre's sanitizer would remove from an attribution: none means it renders as written. */
function removedBySanitizer(html: string): string[] {
  const removed: string[] = [];
  for (const tag of html.matchAll(/<([a-zA-Z][\w-]*)([^>]*?)\/?>/g)) {
    const name = String(tag[1]).toLowerCase();
    if (!MAPLIBRE_ALLOWED_TAGS.has(name)) removed.push(`<${name}>`);
    for (const attribute of String(tag[2]).matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) {
      const attributeName = String(attribute[1]).toLowerCase();
      if (!MAPLIBRE_ALLOWED_ATTRIBUTES.has(attributeName))
        removed.push(`${name}[${attributeName}]`);
      if (
        (attributeName === "href" || attributeName === "src") &&
        !/^(https?:|mailto:)/.test(String(attribute[2]))
      ) {
        removed.push(`${name}[${attributeName}=${attribute[2]}]`);
      }
    }
  }
  return removed;
}

/**
 * The attributions MapLibre's attribution control shows at a zoom, following MapLibre GL JS 6.14:
 * a source counts only while one of its layers is not hidden (src/style/style.ts and
 * StyleLayer.isHidden: below the layer's minzoom, at or above its maxzoom, or visibility "none");
 * duplicates go, and so does an entry that a longer one contains
 * (src/ui/control/attribution_control.ts).
 */
function shownAttributions(style: ReturnType<typeof createMapStyle>, zoom: number): string[] {
  const used = new Set<string>();
  for (const layer of style.layers) {
    if (!("source" in layer) || typeof layer.source !== "string") continue;
    if (layer.minzoom !== undefined && layer.minzoom !== 0 && zoom < layer.minzoom) continue;
    if (layer.maxzoom !== undefined && layer.maxzoom !== 0 && zoom >= layer.maxzoom) continue;
    if (
      layer.layout !== undefined &&
      "visibility" in layer.layout &&
      layer.layout.visibility === "none"
    )
      continue;
    used.add(layer.source);
  }
  let attributions: string[] = [];
  for (const id of used) {
    const attribution = (style.sources[id] as { attribution?: string } | undefined)?.attribution;
    if (attribution !== undefined && !attributions.includes(attribution))
      attributions.push(attribution);
  }
  attributions = attributions.filter((a) => a.trim() !== "").sort((a, b) => a.length - b.length);
  return attributions.filter((a, i) => !attributions.slice(i + 1).some((b) => b.includes(a)));
}

describe("attribution", () => {
  const zooms = Array.from({ length: 45 }, (_, i) => i / 2);
  const views = [0, -1, -2].flatMap((band) =>
    (["fade", "hide"] as const).flatMap((otherBands) =>
      [true, false].map((hd) => ({ band, otherBands, hd })),
    ),
  );

  test.each(views)(
    "OneMap, OpenStreetMap and LTA show at every zoom: band $band, $otherBands, hd $hd",
    ({ band, otherBands, hd }) => {
      const style = createMapStyle({
        glyphs: GLYPHS,
        band,
        otherBands,
        hd,
        indoor: INDOOR,
        street: STREET,
      });
      for (const zoom of zooms) {
        const shown = shownAttributions(style, zoom).join(" | ");
        expect(shown, `zoom ${zoom}`).toContain(ONEMAP_ATTRIBUTION);
        expect(shown, `zoom ${zoom}`).toContain(OSM_ATTRIBUTION);
        expect(shown, `zoom ${zoom}`).toContain(ltaExitAttribution());
      }
    },
  );

  test("the LTA access date reaches what is shown", () => {
    const style = createMapStyle({ glyphs: GLYPHS, ltaExitDataAccessedOn: "20 October 2026" });
    expect(shownAttributions(style, 12)).toEqual([mapAttribution("20 October 2026")]);
  });

  test("the copy that would show without the basemap's is not enough on its own", () => {
    // Why the basemap carries all three: below zoom 15 no street or indoor layer is drawn.
    const style = createMapStyle({ glyphs: GLYPHS });
    const withoutBasemap = { ...style, layers: style.layers.filter((l) => l.id !== "onemap") };
    expect(shownAttributions(withoutBasemap, 14)).toEqual([]);
  });

  test.each([
    ["OneMap", ONEMAP_ATTRIBUTION],
    ["OpenStreetMap", OSM_ATTRIBUTION],
    ["LTA", ltaExitAttribution("20 October 2026")],
    ["all three", mapAttribution("20 October 2026")],
  ])("MapLibre's sanitizer leaves the %s attribution as written", (_name, html) => {
    expect(removedBySanitizer(html)).toEqual([]);
  });

  test("the sanitizer check catches OneMap's style attribute", () => {
    expect(removedBySanitizer(ONEMAP_SNIPPET)).toEqual(["img[style]"]);
    expect(ONEMAP_ATTRIBUTION).toMatch(/<img [^>]*width="20" height="20"/);
  });

  test("every source carries its attribution, with or without data", () => {
    for (const data of Object.values(DATA)) {
      const { sources } = createMapStyle({ glyphs: GLYPHS, ...data });
      expect(sources[SOURCES.street]).toMatchObject({ attribution: OSM_ATTRIBUTION });
      expect(sources[SOURCES.indoor]).toMatchObject({ attribution: ltaExitAttribution() });
    }
    expect(OSM_ATTRIBUTION).toContain("https://www.openstreetmap.org/copyright");
  });

  test("LTA's exit data in the Singapore Open Data Licence's form", () => {
    expect(ltaExitAttribution("20 October 2026")).toBe(
      'Contains information from <a href="https://data.gov.sg/datasets/d_b39d3a0871985372d7e1637193335da5/view" target="_blank" rel="noopener noreferrer">LTA MRT Station Exit (GEOJSON)</a> accessed on 20 October 2026 from data.gov.sg which is made available under the terms of the <a href="https://data.gov.sg/open-data-licence" target="_blank" rel="noopener noreferrer">Singapore Open Data Licence version 1.0</a>',
    );
    expect(ltaExitAttribution()).not.toContain("accessed on");
    expect(ltaExitAttribution("<b>today</b>")).toContain("&lt;b&gt;today&lt;/b&gt;");
  });
});

describe("glyphs", () => {
  test("every text layer uses the package's font stack", () => {
    const symbols = mapLayers(0).filter((layer) => layer.type === "symbol");
    expect(symbols.length).toBeGreaterThan(0);
    for (const layer of symbols) {
      expect(layer.layout?.["text-font"], layer.id).toEqual([FONT_STACK]);
    }
  });

  test("the glyphs URL is the one given, and needs both placeholders", () => {
    expect(createMapStyle({ glyphs: GLYPHS }).glyphs).toBe(GLYPHS);
    expect(() => createMapStyle({ glyphs: "/glyphs/Noto Sans Regular/0-255.pbf" })).toThrow(
      "{fontstack} and {range}",
    );
    expect(() =>
      createMapStyle({ glyphs: "mapbox://fonts/sla/{fontstack}/{range}.pbf" }),
    ).not.toThrow();
  });
});

describe("sources", () => {
  test("data URLs or data pass through; no data gives empty collections", () => {
    const urls = createMapStyle({ glyphs: GLYPHS, ...DATA["data URLs"] }).sources;
    expect(urls[SOURCES.indoor]).toMatchObject({ data: DATA["data URLs"]?.indoor });
    const given = createMapStyle({ glyphs: GLYPHS, indoor: INDOOR, street: STREET }).sources;
    expect(given[SOURCES.indoor]).toMatchObject({ data: INDOOR });
    expect(given[SOURCES.street]).toMatchObject({ data: STREET });
    const empty = createMapStyle({ glyphs: GLYPHS }).sources;
    expect(empty[SOURCES.indoor]).toMatchObject({
      data: { type: "FeatureCollection", features: [] },
    });
  });

  test("indoor features are identified by properties.id", () => {
    expect(createMapStyle({ glyphs: GLYPHS }).sources[SOURCES.indoor]).toMatchObject({
      promoteId: "id",
    });
  });
});

// ---------------------------------------------------------------- the level filter, evaluated

/** The test data's features as the style spec's evaluator sees them. */
const FEATURES: Record<string, Feature> = Object.fromEntries(
  INDOOR.features.map((feature) => [
    `${feature.properties.feature_type}:${feature.id}`,
    {
      type: feature.geometry?.type ?? "Unknown",
      id: feature.id,
      properties: { ...feature.properties },
    } as Feature,
  ]),
);
const space = FEATURES[`space:${id(4)}`] as Feature;
const landingB2 = FEATURES[`node:${id(5)}`] as Feature;
const landingB1 = FEATURES[`node:${id(6)}`] as Feature;
const exit = FEATURES[`node:${id(7)}`] as Feature;
const escalator = FEATURES[`edge:${id(8)}`] as Feature;
const poi = FEATURES[`poi:${id(9)}`] as Feature;

function layer(band: number, otherBands: OtherBands, layerId: string): LayerSpecification {
  const found = mapLayers(band, otherBands).find((l) => l.id === layerId);
  if (found === undefined) throw new Error(`no layer ${layerId}`);
  return found;
}

function shows(band: number, otherBands: OtherBands, layerId: string, feature: Feature): boolean {
  const l = layer(band, otherBands, layerId);
  const filter = "filter" in l ? (l.filter as FilterSpecification | undefined) : undefined;
  return featureFilter(filter, `${layerId}.filter`).filter({ zoom: 19 }, feature);
}

function paint(
  band: number,
  otherBands: OtherBands,
  layerId: string,
  property: string,
  feature: Feature,
  state: Record<string, unknown> = {},
): unknown {
  const l = layer(band, otherBands, layerId);
  const spec = (latest as unknown as Record<string, Record<string, StylePropertySpecification>>)[
    `paint_${l.type}`
  ]?.[property];
  if (spec === undefined) throw new Error(`no paint property ${property}`);
  const value = (l.paint as Record<string, unknown>)[property];
  const parsed = expression.createPropertyExpression(value, `${layerId}.${property}`, spec);
  if (parsed.result !== "success") throw new Error(JSON.stringify(parsed.value));
  return parsed.value.evaluate({ zoom: 19 }, feature, state);
}

describe("level filter", () => {
  test("inBand matches a feature's ordinal, or either end of an edge", () => {
    const filter = (band: number) => featureFilter(inBand(band), "inBand").filter;
    expect(filter(-2)({ zoom: 19 }, space)).toBe(true);
    expect(filter(-1)({ zoom: 19 }, space)).toBe(false);
    // A connector edge between B2 and B1 shows on both bands, and not on the street band.
    expect(filter(-2)({ zoom: 19 }, escalator)).toBe(true);
    expect(filter(-1)({ zoom: 19 }, escalator)).toBe(true);
    expect(filter(0)({ zoom: 19 }, escalator)).toBe(false);
    expect(filter(0)({ zoom: 19 }, exit)).toBe(true);
  });

  test("inBand refuses a band that is not a smallint", () => {
    expect(() => inBand(0.5)).toThrow(RangeError);
    expect(() => inBand(40_000)).toThrow(RangeError);
  });

  test("hide: only the band's features are drawn", () => {
    expect(shows(-1, "hide", "space-fill", space)).toBe(false);
    expect(shows(-2, "hide", "space-fill", space)).toBe(true);
    expect(shows(-1, "hide", "edge", escalator)).toBe(true);
    expect(shows(-1, "hide", "node", landingB1)).toBe(true);
    expect(shows(-1, "hide", "node", landingB2)).toBe(false);
    expect(shows(-1, "hide", "poi", poi)).toBe(false);
  });

  test("fade: every band is drawn, the selected one in full", () => {
    expect(shows(-1, "fade", "space-fill", space)).toBe(true);
    expect(paint(-2, "fade", "space-fill", "fill-opacity", space)).toBe(0.85);
    expect(paint(-1, "fade", "space-fill", "fill-opacity", space)).toBe(0.12);
    expect(paint(-1, "fade", "node", "circle-opacity", landingB1)).toBe(1);
    expect(paint(-1, "fade", "node", "circle-opacity", landingB2)).toBe(0.2);
    expect(paint(-1, "fade", "edge", "line-opacity", escalator)).toBe(1);
  });

  test("labels show only the selected band, in either mode", () => {
    for (const mode of ["fade", "hide"] as const) {
      expect(shows(-2, mode, "space-label", space)).toBe(true);
      expect(shows(-1, mode, "space-label", space)).toBe(false);
      expect(shows(-2, mode, "poi-label", poi)).toBe(true);
      expect(shows(-1, mode, "poi-label", poi)).toBe(false);
    }
  });

  test("exits are labelled on their band and on the street band", () => {
    expect(shows(0, "fade", "exit-label", exit)).toBe(true);
    expect(shows(-1, "fade", "exit-label", exit)).toBe(false);
    expect(shows(0, "hide", "exit-label", landingB1)).toBe(false);
    const underground = { ...exit, properties: { ...exit.properties, ordinal: -1 } } as Feature;
    expect(shows(0, "fade", "exit-label", underground)).toBe(true);
    expect(shows(-1, "fade", "exit-label", underground)).toBe(true);
    expect(shows(-2, "fade", "exit-label", underground)).toBe(false);
  });

  test("junctions are not drawn", () => {
    const junction = { ...landingB2, properties: { ...landingB2.properties, kind: "junction" } };
    expect(shows(-2, "fade", "node", junction as Feature)).toBe(false);
  });

  test("outdoor edges are dashed in their own layer", () => {
    const outdoor = { ...escalator, properties: { ...escalator.properties, outdoor: true } };
    expect(shows(-2, "fade", "edge", outdoor as Feature)).toBe(false);
    expect(shows(-2, "fade", "edge-outdoor", outdoor as Feature)).toBe(true);
    expect(layer(0, "fade", "edge-outdoor").paint).toHaveProperty("line-dasharray");
    expect(layer(0, "fade", "edge").paint).not.toHaveProperty("line-dasharray");
  });

  test("vertical connectors get a casing; walk edges don't", () => {
    expect(shows(-2, "fade", "edge-connector-casing", escalator)).toBe(true);
    const walk = { ...escalator, properties: { ...escalator.properties, kind: "walk" } };
    expect(shows(-2, "fade", "edge-connector-casing", walk as Feature)).toBe(false);
  });

  test("the street graph belongs to the street band", () => {
    expect(layer(0, "hide", "street-edge").layout).toMatchObject({ visibility: "visible" });
    expect(layer(-1, "hide", "street-edge").layout).toMatchObject({ visibility: "none" });
    expect(layer(-1, "fade", "street-edge").layout).toMatchObject({ visibility: "visible" });
    expect(layer(0, "fade", "street-edge").paint).toMatchObject({ "line-opacity": 0.9 });
    expect(layer(-1, "fade", "street-edge").paint).toMatchObject({ "line-opacity": 0.3 });
  });
});

/** CIE76 colour difference of two sRGB colours (#rrggbb), in CIELAB under D65. */
function deltaE(a: readonly number[], b: readonly number[]): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

function rgb(hex: string): number[] {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
}

function lab(color: readonly number[]): [number, number, number] {
  const [r, g, b] = color.map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** `top` drawn at `opacity` over `under`. */
function blend(top: readonly number[], under: readonly number[], opacity: number): number[] {
  return top.map((c, i) => c * opacity + (under[i] ?? 0) * (1 - opacity));
}

describe("colour contrast", () => {
  // OneMap Grey's two main colours (a zoom-18 tile at City Hall): building fill and ground.
  const greyBasemap = ["#e3e4e4", "#f2f2f2"].map(rgb);

  test.each(Object.entries(SPACE_COLORS))(
    "a %s space (%s) stands out from the Grey basemap on every band",
    (_kind, color) => {
      const fill = layer(-1, "fade", "space-fill").paint as Record<string, unknown>;
      const opacity = paint(-2, "fade", "space-fill", "fill-opacity", space) as number;
      expect(opacity).toBe(0.85);
      expect(fill).toHaveProperty("fill-color");
      for (const grey of greyBasemap) {
        // Street band: the basemap in full. Below it: the basemap at 0.6 over the background.
        for (const under of [grey, blend(grey, rgb(BACKGROUND_COLOR), 0.6)]) {
          expect(deltaE(blend(rgb(color), under, opacity), under)).toBeGreaterThanOrEqual(10);
        }
      }
    },
  );

  test.each([
    ...Object.entries(NODE_COLORS).map(([kind, color]) => [`node ${kind}`, color] as const),
    ...Object.entries(EDGE_COLORS).map(([kind, color]) => [`edge ${kind}`, color] as const),
  ])("%s (%s) is far from the closed colour", (_name, color) => {
    expect(deltaE(rgb(color), rgb(CLOSED_COLOR))).toBeGreaterThanOrEqual(25);
  });
});

describe("colours", () => {
  test("every kind and category has its own colour entry", () => {
    expect(Object.keys(SPACE_COLORS)).toEqual([...SPACE_KINDS]);
    expect(Object.keys(EDGE_COLORS)).toEqual([...EDGE_KINDS]);
    expect(Object.keys(NODE_COLORS)).toEqual([...NODE_KINDS]);
    expect(Object.keys(POI_COLORS)).toEqual([...POI_CATEGORIES]);
  });

  test("spaces, edges, nodes and POIs are coloured by kind", () => {
    const withKind = (feature: Feature, property: string, value: string) =>
      ({ ...feature, properties: { ...feature.properties, [property]: value } }) as Feature;
    const differ = (layerId: string, property: string, a: Feature, b: Feature) =>
      expect(String(paint(-2, "fade", layerId, property, a))).not.toBe(
        String(paint(-2, "fade", layerId, property, b)),
      );
    differ("space-fill", "fill-color", space, withKind(space, "kind", "fare_zone"));
    differ("edge", "line-color", escalator, withKind(escalator, "kind", "lift"));
    differ("node", "circle-color", exit, landingB2);
    differ("poi", "circle-color", poi, withKind(poi, "category", "toilet"));
  });
});

// ---------------------------------------------------------------- live updates

/** A map stand-in that records the latest filter and properties of each layer. */
function recordingMap() {
  const filters = new Map<string, unknown>();
  const paints = new Map<string, Record<string, unknown>>();
  const layouts = new Map<string, Record<string, unknown>>();
  const map: BandTarget = {
    setFilter: (layerId, filter) => filters.set(layerId, filter),
    setPaintProperty: (layerId, name, value) => {
      paints.set(layerId, { ...paints.get(layerId), [name]: value });
    },
    setLayoutProperty: (layerId, name, value) => {
      layouts.set(layerId, { ...layouts.get(layerId), [name]: value });
    },
  };
  return { map, filters, paints, layouts };
}

describe("applyBand", () => {
  test.each([
    [-1, "fade"],
    [-2, "hide"],
    [0, "hide"],
  ] as const)("brings a live map to band %d (%s) exactly as createMapStyle would", (band, mode) => {
    const { map, filters, paints, layouts } = recordingMap();
    applyBand(map, band, mode);
    for (const expected of createMapStyle({ glyphs: GLYPHS, band, otherBands: mode }).layers) {
      expect(paints.get(expected.id) ?? {}, expected.id).toEqual(expected.paint ?? {});
      expect(layouts.get(expected.id) ?? {}, expected.id).toEqual(expected.layout ?? {});
      if ("filter" in expected)
        expect(filters.get(expected.id), expected.id).toEqual(expected.filter ?? null);
    }
  });

  test("clears a band filter when switching from hide to fade", () => {
    const { map, filters } = recordingMap();
    applyBand(map, -1, "hide");
    expect(filters.get("poi")).not.toEqual(["==", ["get", "feature_type"], "poi"]);
    applyBand(map, -1, "fade");
    expect(filters.get("poi")).toEqual(["==", ["get", "feature_type"], "poi"]);
  });
});

describe("status overlay", () => {
  const overlay: StatusOverlay = {
    schema_version: 1,
    generated_at: "2026-11-03T08:00:00+08:00",
    entries: [
      {
        feature_type: "edge",
        feature_id: id(8),
        is_open: false,
        note: "Escalator under maintenance",
        valid_from: "2026-11-03T07:00:00+08:00",
        valid_until: "2026-11-03T18:00:00+08:00",
      },
      {
        feature_type: "node",
        feature_id: id(7),
        is_open: false,
        note: null,
        valid_from: "2026-11-01T00:00:00+08:00",
        valid_until: null,
      },
      {
        feature_type: "node",
        feature_id: id(6),
        is_open: true,
        note: "Open again",
        valid_from: "2026-11-02T00:00:00+08:00",
        valid_until: null,
      },
    ],
  };

  test("closed features are those closed at the given time", () => {
    expect(closedFeatureIds(overlay, new Date("2026-11-03T08:00:00+08:00"))).toEqual([
      id(8),
      id(7),
    ]);
    expect(closedFeatureIds(overlay, new Date("2026-11-03T18:00:00+08:00"))).toEqual([id(7)]);
    expect(closedFeatureIds(overlay, new Date("2026-10-31T12:00:00+08:00"))).toEqual([]);
  });

  /** A map stand-in that keeps feature state the way MapLibre does: merged per id, by key. */
  function stateMap() {
    const states = new Map<string, Record<string, unknown>>();
    const map: FeatureStateTarget = {
      setFeatureState: (feature, state) => {
        states.set(feature.id, { ...states.get(feature.id), ...state });
      },
      removeFeatureState: (target, key) => {
        if (target.id === undefined) throw new Error("applyStatus must name the feature");
        const state = { ...states.get(target.id) };
        if (key === undefined) states.delete(target.id);
        else {
          delete state[key];
          states.set(target.id, state);
        }
      },
    };
    return { map, states };
  }

  test("applyStatus marks the closed features", () => {
    const { map, states } = stateMap();
    expect(applyStatus(map, overlay, new Date("2026-11-03T12:00:00+08:00"))).toEqual([
      id(8),
      id(7),
    ]);
    expect(Object.fromEntries(states)).toEqual({
      [id(8)]: { closed: true },
      [id(7)]: { closed: true },
    });
  });

  test("applyStatus clears only its own key on features that reopened", () => {
    const { map, states } = stateMap();
    map.setFeatureState({ source: SOURCES.indoor, id: id(8) }, { route: true });
    map.setFeatureState({ source: SOURCES.indoor, id: id(5) }, { hover: true });
    applyStatus(map, overlay, new Date("2026-11-03T12:00:00+08:00"));
    // At 18:00 the escalator (id 8) has reopened; the exit (id 7) is still closed.
    applyStatus(map, overlay, new Date("2026-11-03T18:00:00+08:00"));
    expect(states.get(id(8))).toEqual({ route: true });
    expect(states.get(id(7))).toEqual({ closed: true });
    expect(states.get(id(5))).toEqual({ hover: true });
    applyStatus(map, { ...overlay, entries: [] });
    expect(states.get(id(7))).toEqual({});
    expect(states.get(id(8))).toEqual({ route: true });
  });

  test("applyStatus keeps track of each map separately", () => {
    const a = stateMap();
    const b = stateMap();
    applyStatus(a.map, overlay, new Date("2026-11-03T12:00:00+08:00"));
    applyStatus(b.map, { ...overlay, entries: [] });
    expect(a.states.get(id(8))).toEqual({ closed: true });
  });

  /** A colour as the style spec's evaluator gives it, for comparing with evaluated paint. */
  function evaluatedColor(hex: string): string {
    const lineColor = (
      latest as unknown as Record<string, Record<string, StylePropertySpecification>>
    )["paint_line"]?.["line-color"] as StylePropertySpecification;
    const parsed = expression.createPropertyExpression(hex, "colour", lineColor);
    if (parsed.result !== "success") throw new Error("bad colour");
    return String(parsed.value.evaluate({ zoom: 19 }));
  }

  test("a closed edge is a double line in the closed colour", () => {
    const closed = { closed: true };
    expect(String(paint(-2, "fade", "edge", "line-color", escalator, closed))).toBe(
      evaluatedColor(CLOSED_COLOR),
    );
    expect(String(paint(-2, "fade", "edge", "line-color", escalator))).not.toBe(
      evaluatedColor(CLOSED_COLOR),
    );
    expect(paint(-2, "fade", "edge", "line-gap-width", escalator, closed)).toBeGreaterThan(0);
    expect(paint(-2, "fade", "edge", "line-gap-width", escalator)).toBe(0);
    expect(paint(-2, "fade", "edge-outdoor", "line-gap-width", escalator, closed)).toBeGreaterThan(
      0,
    );
  });

  test("a closed node is a hollow ring in the closed colour", () => {
    const closed = { closed: true };
    expect(String(paint(0, "fade", "node", "circle-color", exit, closed))).toBe(
      evaluatedColor(CASING_COLOR),
    );
    expect(String(paint(0, "fade", "node", "circle-stroke-color", exit, closed))).toBe(
      evaluatedColor(CLOSED_COLOR),
    );
    expect(String(paint(0, "fade", "node", "circle-color", exit))).toBe(
      evaluatedColor(NODE_COLORS.exit),
    );
    expect(paint(0, "fade", "node", "circle-stroke-width", exit, closed)).toBeGreaterThan(
      paint(0, "fade", "node", "circle-stroke-width", exit) as number,
    );
  });
});

describe("background", () => {
  test("a background layer sits under everything, in the background colour", () => {
    for (const band of [0, -1]) {
      const [first] = mapLayers(band);
      expect(first).toMatchObject({
        id: "background",
        type: "background",
        paint: { "background-color": BACKGROUND_COLOR },
      });
    }
    expect(LAYER_IDS[0]).toBe("background");
    expect(LAYER_IDS[1]).toBe("onemap");
  });
});
