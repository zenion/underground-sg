// The public webapp: the published map over OneMap's street map, with a level switcher, and a
// message when there is no version to draw, or no map at all.

import { STREET_BAND } from "@usg/map-style";
import { useEffect, useMemo, useState } from "react";
import { bandToShow, levelBands } from "./data/bands.ts";
import { versionLine } from "./data/format.ts";
import { type DataState, loadMap } from "./data/load.ts";
import { rendererMessage, stateMessage } from "./data/messages.ts";
import { publicRoot } from "./data/urls.ts";
import { hashWithLevel, levelFromHash, withHash } from "./map/hash.ts";
import { MapView } from "./map/MapView.tsx";
import { LevelSwitcher } from "./ui/LevelSwitcher.tsx";
import { StateMessage } from "./ui/StateMessage.tsx";

/** The root of the public map files: VITE_PUBLIC_BASE at build time, or /public on this origin. */
const PUBLIC_ROOT = publicRoot(import.meta.env.VITE_PUBLIC_BASE, window.location.href);

/** The band the URL asks for (#…&level=-2), or the street band. */
function bandFromUrl(): number {
  return levelFromHash(window.location.hash) ?? STREET_BAND;
}

/** Puts `band` in the page's URL, without a history entry (as MapLibre does for the camera). */
function writeBandToUrl(band: number): void {
  const url = withHash(window.location.href, hashWithLevel(window.location.hash, band));
  if (url !== window.location.href) window.history.replaceState(window.history.state, "", url);
}

export function App() {
  const [state, setState] = useState<DataState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  // The band asked for, from the URL at first. What is shown is bandToShow: the street band until
  // a loaded version has the band.
  const [band, setBand] = useState(bandFromUrl);
  // Set when the map can't be drawn at all (no WebGL 2).
  const [mapFailure, setMapFailure] = useState<{ readonly error: unknown }>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt loads the files again.
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    loadMap(PUBLIC_ROOT, { signal: controller.signal }).then(
      (next) => {
        if (controller.signal.aborted) return;
        if (next.kind === "ready" && next.map.warnings.length > 0) {
          console.warn("Map data warnings:", next.map.warnings);
        }
        setState(next);
      },
      () => {
        // Aborted: a newer attempt, or the page going away, replaced this one.
      },
    );
    return () => {
      controller.abort();
    };
  }, [attempt]);

  // A hash edited by hand, or a link followed within the page, can change the band too.
  useEffect(() => {
    const onHashChange = () => {
      setBand(bandFromUrl());
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  const data = state.kind === "ready" ? state.map : undefined;
  const bands = useMemo(() => levelBands(data?.indoor), [data]);
  const shown = bandToShow(band, bands);
  const current = bands.find((item) => item.ordinal === shown);
  const message =
    mapFailure === undefined ? stateMessage(state) : rendererMessage(mapFailure.error);

  return (
    <div className="app">
      <MapView
        data={data}
        band={shown}
        onError={(error) => {
          console.error("The map can't be drawn:", error);
          setMapFailure({ error });
        }}
        controls={
          bands.length > 1 ? (
            <LevelSwitcher
              bands={bands}
              band={shown}
              onChange={(ordinal) => {
                setBand(ordinal);
                writeBandToUrl(ordinal);
              }}
            />
          ) : null
        }
      />
      <header className="top">
        {data?.latest.demo === true ? (
          <p className="demo-banner" role="note">
            <strong>Demo data.</strong> Not a surveyed map: don't use it to find your way.
          </p>
        ) : null}
        <div className="card info">
          <h1>Underground SG</h1>
          {mapFailure === undefined && state.kind === "loading" ? (
            <p className="muted">Loading the map…</p>
          ) : null}
          {mapFailure === undefined && data !== undefined && current !== undefined ? (
            <>
              <p className="band-line">
                <strong>{current.label}</strong> <span>{current.description}</span>
              </p>
              <p className="muted">{versionLine(data.latest)}</p>
            </>
          ) : null}
        </div>
      </header>
      <StateMessage
        message={message}
        onRetry={() => {
          setAttempt((n) => n + 1);
        }}
      />
    </div>
  );
}
