// Whether a walk session is running, for the tab bar: the layout hides it while one runs, so the
// walker can't leave the walk screen mid-session (leaving would unmount the camera view) and the
// map can't mount next to ARKit (ADR 0007).

import { useSyncExternalStore } from "react";

let active = false;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const current = (): boolean => active;

export function setCaptureActive(next: boolean): void {
  if (next === active) return;
  active = next;
  for (const listener of listeners) listener();
}

export function useCaptureActive(): boolean {
  return useSyncExternalStore(subscribe, current, current);
}
