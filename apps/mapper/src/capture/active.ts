// Whether a walk holds the screen (from the Start tap until the summary: isWalkActive in
// src/walk/flow.ts), for the tab bar: the layout hides it and refuses tab presses meanwhile, so the
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

/**
 * The current value, read synchronously: the layout's tabPress listener uses it, so a tap that
 * lands before the hidden tab bar is drawn is still refused.
 */
export function isCaptureActive(): boolean {
  return active;
}

export function useCaptureActive(): boolean {
  return useSyncExternalStore(subscribe, current, current);
}
