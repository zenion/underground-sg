// The map: OneMap tiles and the published version, drawn with @usg/map-style. The style is built
// once with empty sources, so the street map shows while the version loads (and when it can't);
// as soon as the style has loaded, the version's files are set as the sources' data, status.json
// marks closures, and the level switcher's band is applied to the live map. That doesn't wait for
// MapLibre's `load` event, which comes only once every OneMap tile in view has loaded or failed: a
// slow or hanging tile would otherwise hold back the underground map, which is already here.

import "maplibre-gl/dist/maplibre-gl.css";
import { applyBand, applyStatus, createMapStyle, SOURCES } from "@usg/map-style";
import {
  AttributionControl,
  type GeoJSONSource,
  type IControl,
  Map as MapLibreMap,
  NavigationControl,
  setWorkerUrl,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LoadedMap } from "../data/load.ts";
import { emptyStatus } from "../data/status.ts";
import { CITY_HALL, glyphsUrl, INITIAL_ZOOM, MAX_BOUNDS, MAX_ZOOM, MIN_ZOOM } from "./camera.ts";

// MapLibre GL JS 6 looks for its worker next to its own module, which the bundler moves; point it
// at the worker file the build emits (and the dev server serves) instead.
setWorkerUrl(workerUrl);

type GeoJsonData = Parameters<GeoJSONSource["setData"]>[0];

const EMPTY: GeoJsonData = { type: "FeatureCollection", features: [] };

/** An empty map control that React fills through a portal, so it stacks with MapLibre's own. */
class SlotControl implements IControl {
  readonly element: HTMLDivElement;

  constructor(className: string) {
    this.element = document.createElement("div");
    this.element.className = `maplibregl-ctrl ${className}`;
  }

  onAdd(): HTMLElement {
    return this.element;
  }

  onRemove(): void {
    this.element.remove();
  }
}

export interface MapViewProps {
  /** The loaded version, or undefined while there is none to draw. */
  readonly data: LoadedMap | undefined;
  /** The ordinal band shown in full; the others fade. */
  readonly band: number;
  /** Drawn in the bottom-right control stack, between the zoom buttons and the attribution. */
  readonly controls?: ReactNode;
  /**
   * Called when the map can't be created at all, typically because the browser can't give
   * MapLibre a WebGL 2 context (WebGL off, a blocklisted GPU, no memory for a context).
   */
  readonly onError?: (error: unknown) => void;
}

export function MapView({ data, band, controls, onError }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibreMap>();
  const [slot, setSlot] = useState<HTMLElement>();
  // The latest onError, so the map is created once however the parent passes it.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let instance: MapLibreMap;
    try {
      instance = new MapLibreMap({
        container,
        style: createMapStyle({
          glyphs: glyphsUrl(import.meta.env.BASE_URL, window.location.href),
        }),
        center: [...CITY_HALL],
        zoom: INITIAL_ZOOM,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        maxBounds: MAX_BOUNDS,
        // A flat, north-up map: indoor layers have no height, and a map turned by a stray
        // two-finger gesture is easy to misread underground.
        maxPitch: 0,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        // Added below, expanded on every screen size (packages/map-style README, "Attribution").
        attributionControl: false,
        // The camera in the URL (#map=zoom/lat/lon), so a reload or a shared link keeps the view.
        hash: "map",
      });
    } catch (error) {
      // MapLibre throws from its constructor when it gets no WebGL 2 context (and removes its
      // canvas first). Thrown inside an effect, that would unmount the whole page.
      onErrorRef.current?.(error);
      return;
    }
    instance.touchZoomRotate.disableRotation();
    instance.keyboard.disableRotation();
    // Bottom controls stack upwards in the order they are added: the attribution at the bottom,
    // the level switcher above it, the zoom buttons on top.
    instance.addControl(new AttributionControl({ compact: false }), "bottom-right");
    const switcherSlot = new SlotControl("usg-switcher-slot");
    instance.addControl(switcherSlot, "bottom-right");
    instance.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
    // The style is passed as an object, which MapLibre loads on the next frame, so this listener
    // is in place in time. Sources and layers exist from `style.load`: setData, feature state,
    // filters and paint properties work then, while OneMap's tiles are still arriving.
    instance.once("style.load", () => {
      setMap(instance);
    });
    setSlot(switcherSlot.element);
    if (import.meta.env.DEV) Object.assign(window, { usgMap: instance });
    return () => {
      setMap(undefined);
      setSlot(undefined);
      // remove() takes the camera out of the URL. Keep it: React's development mode unmounts and
      // remounts every effect once, and the second map must still find the view to restore.
      const url = window.location.href;
      instance.remove();
      window.history.replaceState(window.history.state, "", url);
    };
  }, []);

  useEffect(() => {
    if (map === undefined) return;
    map.getSource<GeoJSONSource>(SOURCES.indoor)?.setData((data?.indoor ?? EMPTY) as GeoJsonData);
    map.getSource<GeoJSONSource>(SOURCES.street)?.setData((data?.street ?? EMPTY) as GeoJsonData);
    applyStatus(map, data?.status ?? emptyStatus());
  }, [map, data]);

  useEffect(() => {
    if (map !== undefined) applyBand(map, band);
  }, [map, band]);

  return (
    <>
      <div ref={containerRef} className="map" />
      {slot !== undefined && controls !== undefined ? createPortal(controls, slot) : null}
    </>
  );
}
