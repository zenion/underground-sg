// Counts mounted maps, so the Capture screen can show that the map is gone while it is active:
// the map's WebView competes with ARKit for GPU, memory and heat (ADR 0007).

import { useEffect, useSyncExternalStore } from "react";

let mounted = 0;
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const mountedMaps = (): number => mounted;

/** Call in the component that renders the map: counts it while mounted. */
export function useCountMountedMap(): void {
  useEffect(() => {
    mounted++;
    notify();
    return () => {
      mounted--;
      notify();
    };
  }, []);
}

/** The number of maps mounted now. */
export function useMountedMaps(): number {
  return useSyncExternalStore(subscribe, mountedMaps, mountedMaps);
}
