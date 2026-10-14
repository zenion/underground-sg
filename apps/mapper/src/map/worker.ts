// Points maplibre-gl at its worker script. DOM-component code only: it needs Blob and URL.
//
// maplibre-gl v6 looks for dist/maplibre-gl-worker.mjs next to its own module (import.meta.url),
// which Metro's bundle doesn't have. scripts/maplibre-worker.mts copies the worker into
// generated/maplibre-worker.ts as a string; here it becomes a blob: URL, which has the page's
// origin, so MapLibre starts it as a module worker directly.

import { getVersion, setWorkerUrl } from "maplibre-gl";
import { MAPLIBRE_WORKER_SOURCE, MAPLIBRE_WORKER_VERSION } from "./generated/maplibre-worker.ts";

let workerUrl: string | undefined;

/** Call before creating the first map. Idempotent. */
export function installBundledWorker(): void {
  if (workerUrl !== undefined) return;
  if (getVersion() !== MAPLIBRE_WORKER_VERSION) {
    console.warn(
      `maplibre-gl ${getVersion()} with a ${MAPLIBRE_WORKER_VERSION} worker: run scripts/maplibre-worker.mts`,
    );
  }
  workerUrl = URL.createObjectURL(new Blob([MAPLIBRE_WORKER_SOURCE], { type: "text/javascript" }));
  setWorkerUrl(workerUrl);
}
