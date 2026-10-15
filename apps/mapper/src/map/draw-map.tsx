"use dom";

// The map: maplibre-gl with terra-draw, as an Expo DOM component. On the phone it runs in a
// WebView; with `expo start --web` it renders in the page, so it can be developed in desktop
// Chrome. Drawn features go to the native side through `onFeaturesChange`, which keeps them;
// `initialFeatures` brings them back when the map is mounted again.

import "maplibre-gl/dist/maplibre-gl.css";
import type { DOMProps } from "expo/dom";
import { Map as MapLibreMap, NavigationControl } from "maplibre-gl";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import {
  type GeoJSONStoreFeatures,
  TerraDraw,
  TerraDrawPointMode,
  TerraDrawPolygonMode,
  TerraDrawSelectMode,
} from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { type DrawnFeature, toDrawnFeatures } from "./features.ts";
import { EXTRA_ATTRIBUTION, MAP_VIEW, oneMapRasterStyle } from "./style.ts";
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

export interface DrawMapProps {
  /** Features to show when the map is created. Later changes to this prop are ignored. */
  readonly initialFeatures: DrawnFeature[];
  /** Called with every finished feature after each draw, edit or delete. */
  readonly onFeaturesChange: (features: DrawnFeature[]) => Promise<void>;
  readonly dom?: DOMProps;
}

export default function DrawMap({ initialFeatures, onFeaturesChange }: DrawMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const drawRef = useRef<TerraDraw | null>(null);
  // Props cross the bridge again on every native render; the map reads them through refs so it
  // is created once per mount.
  const initial = useRef(initialFeatures);
  const onChange = useRef(onFeaturesChange);
  onChange.current = onFeaturesChange;
  const lastSent = useRef("");

  const [ready, setReady] = useState(false);
  const [tool, setTool] = useState<Tool>("polygon");
  const [selected, setSelected] = useState<string | number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    installBundledWorker();
    const map = new MapLibreMap({
      container: element,
      style: oneMapRasterStyle(),
      center: MAP_VIEW.center,
      zoom: MAP_VIEW.zoom,
      minZoom: MAP_VIEW.minZoom,
      maxZoom: MAP_VIEW.maxZoom,
      maxBounds: MAP_VIEW.maxBounds,
      maxPitch: 0,
      // Always expanded: OneMap's terms require the logo and attribution to be shown.
      attributionControl: { compact: false, customAttribution: EXTRA_ATTRIBUTION },
    });
    map.addControl(
      new NavigationControl({ showCompass: true, visualizePitch: false }),
      "top-right",
    );
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
    map.once("load", () => {
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
      draw?.stop();
      map.remove();
    };
  }, []);

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
      </div>
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
} satisfies Record<string, CSSProperties>;
