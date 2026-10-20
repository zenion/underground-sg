// The walk build's log check (the lean recorder design, W1; backlog "The walk build", Done when):
// sends a marker that looks like a pose through every way JavaScript reaches the device log —
// console.log, console.error, React Native's nativeLoggingHook and the uncaught-error handler (as
// a non-fatal error, so the app keeps running) — while the owner watches `pymobiledevice3 syslog
// live` (docs/phone-testing.md). In the walk build the log guard (log-guard.ts) must leave none of
// it in the log: no marker, only "[redacted capture error]". In other builds the marker shows up,
// which proves the check reaches the log at all. The numbers are made up, never a real place.

import type { LogGuardTarget } from "./log-guard.ts";

/** Searched for in the syslog. Made-up numbers in the shape of a position. */
export const LOG_CHECK_TEXT = "usg-log-check 9.8765 -4.3210 -0.5000";

type Sink = (...args: unknown[]) => void;

/** The channels it used, in order: what the owner should find nothing of in the walk build. */
export function runLogCheck(target: LogGuardTarget = globalThis as LogGuardTarget): string[] {
  const used: string[] = [];
  const consoleObject = target.console as Record<string, unknown> | undefined;
  for (const name of ["log", "error"] as const) {
    const sink = consoleObject?.[name];
    if (typeof sink === "function") {
      (sink as Sink).call(consoleObject, LOG_CHECK_TEXT);
      used.push(`console.${name}`);
    }
  }
  if (typeof target.nativeLoggingHook === "function") {
    (target.nativeLoggingHook as Sink)(LOG_CHECK_TEXT, 1);
    used.push("nativeLoggingHook");
  }
  const handler = target.ErrorUtils?.getGlobalHandler();
  if (handler) {
    handler(new Error(LOG_CHECK_TEXT), false);
    used.push("ErrorUtils");
  }
  return used;
}
