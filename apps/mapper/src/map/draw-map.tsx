"use dom";

// The map: maplibre-gl with terra-draw, as an Expo DOM component. On the phone it runs in a
// WebView; with `expo start --web` it renders in the page, so it can be developed in desktop
// Chrome. The base map and the published underground map use @usg/map-style, the webapp's style:
// OneMap tiles, the indoor and street layers, the level filter, glyphs from the API and the
// attribution every map view shows. The published map is loaded here, from the API the native
// screen names (src/map/published.ts), and drawn under the drawing. Drawn features go to the
// native side through `onFeaturesChange`, which keeps them; `initialFeatures` brings them back when
// the map is mounted again.

import "maplibre-gl/dist/maplibre-gl.css";
import { applyBand, createMapStyle, SOURCES, STREET_BAND } from "@usg/map-style";
import type { DOMProps } from "expo/dom";
import {
  AttributionControl,
  type GeoJSONSource,
  type IControl,
  Map as MapLibreMap,
  NavigationControl,
} from "maplibre-gl";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type GeoJSONStoreFeatures,
  TerraDraw,
  TerraDrawPointMode,
  TerraDrawPolygonMode,
  TerraDrawSelectMode,
} from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { bandToShow, levelBands } from "./bands.ts";
import { MAP_VIEW } from "./camera.ts";
import { type DrawnFeature, toDrawnFeatures } from "./features.ts";
import { glyphsTemplate, loadPublishedMap, type PublishedState, versionLine } from "./published.ts";
import { installBundledWorker } from "./worker.ts";

type Tool = "select" | "polygon" | "point";

const TOOLS: { readonly tool: Tool; readonly label: string; readonly hint: string }[] = [
  {
    tool: "polygon",
    label: "Polygon",
    hint: "Tap to add corners; tap the first or last corner to finish.",
  },
  { tool: "point", label: "Point", hint: "Tap to place a point." },
  {
    tool: "select",
    label: "Edit",
    hint: "Tap a shape to select it, then drag it, its corners or the midpoints between them.",
  },
];

// Handles big enough for a finger: terra-draw's defaults suit a mouse.
const BLUE = "#0b6bcb";
const ORANGE = "#e36209";
const WHITE = "#ffffff";
const POLYGON_STYLES = {
  fillColor: BLUE,
  fillOpacity: 0.25,
  outlineColor: BLUE,
  outlineWidth: 3,
  closingPointWidth: 9,
  closingPointColor: WHITE,
  closingPointOutlineColor: BLUE,
  closingPointOutlineWidth: 3,
} as const;
const POINT_STYLES = {
  pointWidth: 8,
  pointColor: BLUE,
  pointOutlineColor: WHITE,
  pointOutlineWidth: 2,
} as const;
const SELECT_STYLES = {
  selectedPolygonColor: ORANGE,
  selectedPolygonFillOpacity: 0.25,
  selectedPolygonOutlineColor: ORANGE,
  selectedPolygonOutlineWidth: 3,
  selectedPointColor: ORANGE,
  selectedPointWidth: 10,
  selectedPointOutlineColor: WHITE,
  selectedPointOutlineWidth: 2,
  selectionPointWidth: 9,
  selectionPointColor: WHITE,
  selectionPointOutlineColor: ORANGE,
  selectionPointOutlineWidth: 3,
  midPointWidth: 6,
  midPointColor: ORANGE,
  midPointOutlineColor: WHITE,
  midPointOutlineWidth: 2,
} as const;

type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

const EMPTY: GeoJsonData = { type: "FeatureCollection", features: [] };

/** An empty map control that React fills through a portal, so it stacks with MapLibre's own. */
class SlotControl implements IControl {
  readonly element: HTMLDivElement;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "maplibregl-ctrl";
  }

  onAdd(): HTMLElement {
    return this.element;
  }

  onRemove(): void {
    this.element.remove();
  }
}

export interface DrawMapProps {
  /** Features to show when the map is created. Later changes to this prop are ignored. */
  readonly initialFeatures: DrawnFeature[];
  /** Called with every finished feature after each draw, edit or delete. */
  readonly onFeaturesChange: (features: DrawnFeature[]) => Promise<void>;
  /**
   * The API's base URL (src/config.ts), where the published map and the glyphs come from, or null
   * when the app can't tell; `apiProblem` then says why.
   */
  readonly apiUrl: string | null;
  readonly apiProblem?: string;
  readonly dom?: DOMProps;
}

export default function DrawMap({
  initialFeatures,
  onFeaturesChange,
  apiUrl,
  apiProblem,
}: DrawMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  // Props cross the bridge again on every native render; the map reads them through refs so it
  // is created once per mount.
  const initial = useRef(initialFeatures);
  const onChange = useRef(onFeaturesChange);
  onChange.current = onFeaturesChange;
  const glyphs = useRef(glyphsTemplate(apiUrl));
  const lastSent = useRef("");

  const [ready, setReady] = useState(false);
  const [tool, setTool] = useState<Tool>("polygon");
  const [selected, setSelected] = useState<string | number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The map once its style has loaded (sources and layers exist), and the switcher's slot.
  const [styled, setStyled] = useState<MapLibreMap | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [published, setPublished] = useState<PublishedState>(
    apiUrl === null
      ? { kind: "no-api", detail: apiProblem ?? "the app doesn't know the API's address." }
      : { kind: "loading" },
  );
  const [attempt, setAttempt] = useState(0);
  const [band, setBand] = useState(STREET_BAND);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    installBundledWorker();
    const map = new MapLibreMap({
      container: element,
      // Empty sources: the street map shows at once, and the published map is set as their data
      // when it arrives.
      style: createMapStyle({ glyphs: glyphs.current }),
      center: MAP_VIEW.center,
      zoom: MAP_VIEW.zoom,
      minZoom: MAP_VIEW.minZoom,
      maxZoom: MAP_VIEW.maxZoom,
      maxBounds: MAP_VIEW.maxBounds,
      maxPitch: 0,
      // Added below, expanded on every screen size: OneMap's terms require the logo and
      // attribution to be shown, and the style credits OpenStreetMap and LTA too.
      attributionControl: false,
    });
    map.addControl(
      new NavigationControl({ showCompass: true, visualizePitch: false }),
      "top-right",
    );
    // Bottom controls stack upwards in the order they are added: the attribution at the bottom,
    // the level switcher above it.
    map.addControl(new AttributionControl({ compact: false }), "bottom-right");
    const switcherSlot = new SlotControl();
    map.addControl(switcherSlot, "bottom-right");
    setSlot(switcherSlot.element);
    // Usually a tile that didn't load (no connection): show it for a while, then the hint again.
    let errorTimer: ReturnType<typeof setTimeout> | undefined;
    map.on("error", (event) => {
      setError(`Map: ${event.error?.message ?? "something didn't load"}`);
      clearTimeout(errorTimer);
      errorTimer = setTimeout(() => setError(null), 6000);
    });

    let draw: TerraDraw | null = null;
    const send = (): void => {
      if (!draw) return;
      const features = toDrawnFeatures(draw.getSnapshot());
      const json = JSON.stringify(features);
      if (json === lastSent.current) return;
      lastSent.current = json;
      void onChange.current(features);
    };
    // Sources and layers exist from `style.load`, which is all the published layers and terra-draw
    // need. MapLibre's `load` waits for every OneMap tile in view as well (dozens at the Grey HD
    // tiles' zoom), and never comes if one hangs, so it isn't waited for.
    map.once("style.load", () => {
      setStyled(map);
      draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map }),
        modes: [
          new TerraDrawPolygonMode({ styles: POLYGON_STYLES }),
          new TerraDrawPointMode({ styles: POINT_STYLES }),
          new TerraDrawSelectMode({
            styles: SELECT_STYLES,
            flags: {
              polygon: {
                feature: {
                  draggable: true,
                  coordinates: { midpoints: true, draggable: true, deletable: true },
                },
              },
              point: { feature: { draggable: true } },
            },
          }),
        ],
      });
      draw.start();
      const restored = toDrawnFeatures(initial.current);
      draw.addFeatures(restored as GeoJSONStoreFeatures[]);
      lastSent.current = JSON.stringify(restored);
      // If terra-draw refused any of them, tell the native side what the map really holds.
      send();
      draw.setMode("polygon");
      draw.on("finish", send);
      draw.on("change", (_ids, type) => {
        if (type === "delete") send();
      });
      draw.on("select", (id) => setSelected(id));
      draw.on("deselect", () => setSelected(null));
      drawRef.current = draw;
      setReady(true);
    });

    return () => {
      clearTimeout(errorTimer);
      drawRef.current = null;
      setStyled(null);
      setSlot(null);
      draw?.stop();
      map.remove();
    };
  }, []);

  // The published map; Retry loads it again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt loads the files again.
  useEffect(() => {
    if (apiUrl === null) return;
    const controller = new AbortController();
    setPublished({ kind: "loading" });
    loadPublishedMap(apiUrl, (url, init) => fetch(url, init), controller.signal).then(
      (next) => {
        if (!controller.signal.aborted) setPublished(next);
      },
      () => {
        // Aborted: the map went away, or a newer attempt replaced this one.
      },
    );
    return () => controller.abort();
  }, [apiUrl, attempt]);

  const loaded = published.kind === "ready" ? published.map : undefined;
  const bands = useMemo(() => levelBands(loaded?.indoor), [loaded]);
  const shown = bandToShow(band, bands);

  useEffect(() => {
    if (styled === null) return;
    styled
      .getSource<GeoJSONSource>(SOURCES.indoor)
      ?.setData((loaded?.indoor ?? EMPTY) as GeoJsonData);
    styled
      .getSource<GeoJSONSource>(SOURCES.street)
      ?.setData((loaded?.street ?? EMPTY) as GeoJsonData);
  }, [styled, loaded]);

  useEffect(() => {
    if (styled !== null) applyBand(styled, shown);
  }, [styled, shown]);

  const choose = (next: Tool): void => {
    drawRef.current?.setMode(next);
    setTool(next);
    setSelected(null);
  };

  const sendNow = (): void => {
    const draw = drawRef.current;
    if (!draw) return;
    const features = toDrawnFeatures(draw.getSnapshot());
    lastSent.current = JSON.stringify(features);
    void onChange.current(features);
  };

  const deleteSelected = (): void => {
    const draw = drawRef.current;
    if (!draw || selected === null) return;
    draw.deselectFeature(selected);
    if (draw.hasFeature(selected)) draw.removeFeatures([selected]);
    setSelected(null);
    sendNow();
  };

  const clearAll = (): void => {
    drawRef.current?.clear();
    setSelected(null);
    sendNow();
  };

  const hint = TOOLS.find((entry) => entry.tool === tool)?.hint ?? "";
  return (
    <div style={styles.root}>
      <div ref={container} style={styles.map} />
      {slot !== null && bands.length > 1
        ? createPortal(
            <fieldset style={styles.switcher}>
              <legend style={styles.hidden}>Level</legend>
              {bands.map((item) => (
                <button
                  key={item.ordinal}
                  type="button"
                  title={item.title}
                  aria-label={`${item.label}: ${item.title}`}
                  aria-pressed={item.ordinal === shown}
                  onClick={() => setBand(item.ordinal)}
                  style={
                    item.ordinal === shown
                      ? { ...styles.bandButton, ...styles.active }
                      : styles.bandButton
                  }
                >
                  {item.label}
                </button>
              ))}
            </fieldset>,
            slot,
          )
        : null}
      <div style={styles.panel}>
        <div style={styles.toolbar}>
          {TOOLS.map((entry) => (
            <button
              key={entry.tool}
              type="button"
              disabled={!ready}
              onClick={() => choose(entry.tool)}
              style={entry.tool === tool ? { ...styles.button, ...styles.active } : styles.button}
            >
              {entry.label}
            </button>
          ))}
          <button
            type="button"
            disabled={!ready || selected === null}
            onClick={deleteSelected}
            style={{ ...styles.button, opacity: ready && selected !== null ? 1 : 0.4 }}
          >
            Delete
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={clearAll}
            style={{ ...styles.button, opacity: ready ? 1 : 0.4 }}
          >
            Clear
          </button>
        </div>
        <div style={styles.hint}>{error ?? (ready ? hint : "Loading the map…")}</div>
        <PublishedLine state={published} onRetry={() => setAttempt((n) => n + 1)} />
      </div>
    </div>
  );
}

/** One line about the published map under the hint: its version, or why there is none. */
function PublishedLine({ state, onRetry }: { state: PublishedState; onRetry: () => void }) {
  if (state.kind === "loading") {
    return <div style={styles.status}>Loading the published map…</div>;
  }
  if (state.kind === "ready") {
    return (
      <div style={styles.status}>
        {state.map.demo ? <span style={styles.demo}>Demo data</span> : null}
        <span>{versionLine(state.map)}</span>
      </div>
    );
  }
  const text =
    state.kind === "no-api"
      ? `No published map: ${state.detail}`
      : state.kind === "no-version"
        ? "No map published yet: the API answers, but nothing is published (pnpm demo publishes the demo map)."
        : state.kind === "unreachable"
          ? `Can't reach the API for the published map (${state.detail}).`
          : `Can't read the published map: ${state.detail}`;
  return (
    <div style={{ ...styles.status, ...styles.problem }}>
      <span>{text}</span>
      {state.kind === "no-api" ? null : (
        <button type="button" onClick={onRetry} style={styles.retry}>
          Retry
        </button>
      )}
    </div>
  );
}

const styles = {
  // Absolute, so it fills the WebView on the phone and the screen's view in desktop Chrome.
  root: {
    position: "absolute",
    inset: 0,
    overflow: "hidden",
    fontFamily: "-apple-system, system-ui, sans-serif",
  },
  map: { position: "absolute", inset: 0 },
  // Top left, clear of the zoom buttons (top right) and the attribution (bottom).
  panel: {
    position: "absolute",
    top: 8,
    left: 8,
    right: 48,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 6,
    // Only the buttons take touches; the rest of the panel passes them to the map.
    pointerEvents: "none",
  },
  toolbar: { display: "flex", flexWrap: "wrap", gap: 4, pointerEvents: "auto" },
  button: {
    minHeight: 40,
    padding: "0 8px",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#c7ccd1",
    borderRadius: 8,
    background: "#ffffff",
    color: "#1b1f23",
    fontSize: 14,
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.15)",
  },
  active: { background: BLUE, borderColor: BLUE, color: WHITE },
  hint: {
    padding: "6px 10px",
    borderRadius: 8,
    background: "rgba(255, 255, 255, 0.92)",
    color: "#1b1f23",
    fontSize: 13,
    pointerEvents: "none",
  },
  status: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    padding: "5px 10px",
    borderRadius: 8,
    background: "rgba(255, 255, 255, 0.92)",
    color: "#59636e",
    fontSize: 12,
    pointerEvents: "none",
  },
  problem: { color: "#9a6700", pointerEvents: "auto" },
  demo: {
    padding: "1px 6px",
    borderRadius: 4,
    background: "#9a6700",
    color: WHITE,
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
  },
  retry: {
    minHeight: 32,
    padding: "0 10px",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#c7ccd1",
    borderRadius: 6,
    background: WHITE,
    color: "#1b1f23",
    fontSize: 13,
  },
  // The level switcher: in the bottom-right control stack, above the attribution, in reach of a
  // right thumb.
  switcher: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    margin: 0,
    padding: 0,
    border: "none",
  },
  hidden: {
    position: "absolute",
    width: 1,
    height: 1,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
  bandButton: {
    minHeight: 40,
    minWidth: 64,
    padding: "0 10px",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#c7ccd1",
    borderRadius: 8,
    background: WHITE,
    color: "#1b1f23",
    fontSize: 14,
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.15)",
    whiteSpace: "nowrap",
  },
} satisfies Record<string, CSSProperties>;
