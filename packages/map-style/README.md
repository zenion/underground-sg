# @usg/map-style

The one MapLibre style (style spec v8) for the webapp (`apps/web`) and the mapper app's map, a DOM component in `apps/mapper`: OneMap raster tiles, the street graph from `street.json`, and the indoor layers from `indoor.json` ([snapshot-format.md](../../docs/snapshot-format.md)), with a level filter, its own glyphs and the attribution every map view must show. Environment-neutral: it builds plain JSON and imports no renderer, no Node API and nothing that needs `eval` or WebAssembly; `pnpm typecheck` compiles the entry without Node types (`tsconfig.neutral.json`).

```ts
import { applyBand, applyStatus, createMapStyle } from "@usg/map-style";

const map = new maplibregl.Map({
  container,
  style: createMapStyle({
    glyphs: "/glyphs/{fontstack}/{range}.pbf", // where the app serves glyphs/
    indoor: indoorJsonUrl, // or the parsed file, which the router needs anyway
    street: streetJsonUrl,
    band: 0,
  }),
  center: [103.852, 1.2925],
  zoom: 17,
  maxZoom: 21,
});

applyBand(map, -1); // the level switcher: show band -1 in full, fade the others
applyStatus(map, statusJson); // mark what status.json says is closed; call again on each refresh
```

| Export | What it is |
| --- | --- |
| `createMapStyle(options)` | The style. Options: `glyphs` (required URL template), `basemap` (`"Grey"`, the default, or `"Default"`), `hd` (OneMap's HD tiles, default `true`), `indoor` and `street` (URL or parsed file; empty sources when left out), `band` (default 0), `otherBands` (`"fade"`, the default, or `"hide"`), `ltaExitDataAccessedOn` |
| `mapLayers(band, otherBands)`, `LAYER_IDS` | The layers alone, bottom to top |
| `applyBand(map, band, otherBands)` | Switches a live map to another band: sets each layer's filter and band-dependent properties to what `createMapStyle` would give. Takes any object with MapLibre's `setFilter`, `setPaintProperty` and `setLayoutProperty` |
| `inBand`, `levelFilter`, `levelOpacity`, `levelSortKey` | The level filter as MapLibre expressions |
| `applyStatus(map, overlay, at)`, `closedFeatureIds` | Marks features closed in `status.json` with the feature state `closed` (`CLOSED_STATE`): a closed node is drawn as a hollow ring in `CLOSED_COLOR`, a closed edge as a double line in it. Each call clears `closed` from the features its previous call on the same map marked and that have reopened, and leaves other feature state alone |
| `mapAttribution(date)`, `ONEMAP_ATTRIBUTION`, `ONEMAP_SNIPPET`, `OSM_ATTRIBUTION`, `ltaExitAttribution(date)`, `attributionHtml` | Attribution HTML for MapLibre's attribution control (see [Attribution](#attribution)) |
| `oneMapTiles`, `oneMapMaxZoom`, `ONEMAP_*` | OneMap's tile URLs and limits, with the source checked against in `src/onemap.ts` |
| `SPACE_COLORS`, `EDGE_COLORS`, `NODE_COLORS`, `POI_COLORS`, `BACKGROUND_COLOR` and the rest | The palette |
| `@usg/map-style/glyphs/*` | The glyph PBFs ([glyphs/README.md](glyphs/README.md)) |

## OneMap

Tiles come from `https://www.onemap.gov.sg/maps/tiles/<Basemap>[_HD]/{z}/{x}/{y}.png`, checked on 2026-10-15 against OneMap's basemap documentation and tile server (details and sources in `src/onemap.ts`). HD tiles are what OneMap's own TileJSON and style use: drawn for 2x screens, shown at a tile size of 128, and served as `Content-Type: image/undefined`, which the webapp skeleton task tests MapLibre against. The raster source stops at zoom 20 for HD tiles, as OneMap's own style does (OneMap serves sharp zoom-20 HD tiles), and at 19 for standard tiles, whose zoom-20 responses are empty. Beyond that MapLibre overzooms the last tiles, and the indoor layers carry the detail. No token is needed; caching tiles or packing them for offline use needs SLA's written permission first ([0009](../../docs/decisions/0009-hosting-and-budget.md)).

## Attribution

Every map view shows OneMap's logo and attribution, OpenStreetMap's, and LTA's for the exit data in the Singapore Open Data Licence's form ([spec](../../docs/spec.md#map-display-and-street-to-street-routing)).

- MapLibre shows a source's attribution only while one of that source's layers is drawn at the current zoom: not below the layer's `minzoom` and not `visibility: none`. The street and indoor layers start at zoom 15 or later, and the street graph is hidden on underground bands in `hide` mode, so their sources' attributions would come and go. The basemap's layer is drawn at every zoom and on every band, so the basemap source carries all three (`mapAttribution`). The street and indoor sources keep their own too; MapLibre drops an entry that another one contains.
- MapLibre sanitizes attributions and drops attributes it doesn't allow, `style` among them. OneMap's snippet (`ONEMAP_SNIPPET`, verbatim) sizes its logo with `style`, so `ONEMAP_ATTRIBUTION` is the same HTML with `width="20" height="20"` on the logo instead, which renders the logo at the size the snippet asks for. The tests check that the sanitizer leaves every attribution as written.
- Keep the attribution control on and expanded on every screen, phones included (the attribution control's `compact: false` option; MapLibre collapses it on narrow maps by default): OneMap's Terms of Use require the logo and attribution to be visible, and the spec asks for all three on every map view.
- Pass `ltaExitDataAccessedOn` (the date the LTA import fetched the data, such as "20 October 2026") once the import records it; until then the statement leaves the date out.

## Layers

Bottom to top: a white background (so the dimmed raster and any area without tiles look the same in every page or WebView), the OneMap raster (dimmed below the street band), venue outlines, space fills and outlines by kind, the street graph (covered footpaths in teal), street connectors, a white casing under vertical connectors, edges by kind (outdoor ones dashed, in a layer of their own; closed ones a double line), nodes by kind (junctions are not drawn; closed ones a hollow ring), POIs by category, then labels: space names, POI names and exit labels. An exit is labelled with the street or building it opens onto, on its own band and on the street band. Labels show only the selected band.

Indoor features are identified by `properties.id` (`promoteId`), so feature state and `queryRenderedFeatures` see their UUIDs.

## Tests

`pnpm --filter @usg/map-style test` validates the style with `@maplibre/maplibre-gl-style-spec`'s validator for both basemaps, HD and standard tiles, with no data, data URLs and data passed in, on three bands in both modes; evaluates the level filter, opacities and colours on synthetic City Hall features with the spec's own expression engine; checks that `applyBand` reproduces `createMapStyle`; follows MapLibre 6.14's rules to check that all three attributions show at every zoom from 0 to 22 on every band, and that its sanitizer leaves them as written; checks colour contrasts (space fills against OneMap Grey's greys, kinds against the closed colour, CIE76); checks that `applyStatus` touches only its own feature-state key; decodes the glyph PBFs; and checks that, at run time, the entry imports only its own files and `@usg/contracts` (the style spec is a type-only import). Rendering text with the glyphs is checked in a browser by the webapp skeleton task.
