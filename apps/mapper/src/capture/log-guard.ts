// The walk build's JavaScript log guard (ADR 0010 "Privacy"; the lean recorder design, D19).
// React Native forwards JavaScript's console output and uncaught errors to the device log in
// release builds too, so in the walk build, from launch:
// - every console method, and `nativeLoggingHook` (React Native's way into the device log), are
//   replaced with no-ops;
// - the ErrorUtils global handler is wrapped so that an uncaught error reaches it with its message
//   replaced by "[redacted capture error]", keeping only the stack's frames (files, lines and
//   function names, never values). A crash still crashes, and still says where.
// The native layer (RCTSetLogFunction dropping JavaScript messages) comes with the module glue.
// Outside the walk build this does nothing: desk testing needs the console, and the no-pose lint
// (test/no-pose-logging.test.ts) keeps values out of it there.

import type { BuildProfile } from "../../modules/capture-native/src/types.ts";

export const REDACTED_ERROR_MESSAGE = "[redacted capture error]";

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;

interface ErrorUtilsLike {
  getGlobalHandler(): GlobalHandler;
  setGlobalHandler(handler: GlobalHandler): void;
}

/** The globals the guard replaces; `globalThis` in the app, a fake in tests. */
export interface LogGuardTarget {
  console?: object;
  nativeLoggingHook?: unknown;
  ErrorUtils?: ErrorUtilsLike;
}

const INSTALLED: unique symbol = Symbol.for("usg.logGuard.installed");

const CONSOLE_METHODS = [
  "assert",
  "clear",
  "count",
  "countReset",
  "debug",
  "dir",
  "dirxml",
  "error",
  "group",
  "groupCollapsed",
  "groupEnd",
  "info",
  "log",
  "profile",
  "profileEnd",
  "table",
  "time",
  "timeEnd",
  "timeLog",
  "timeStamp",
  "trace",
  "warn",
] as const;

function noop(): void {}

/**
 * Installs the guard when `profile` is the walk build; returns whether it is installed. Calling it
 * again changes nothing.
 */
export function installLogGuard(
  profile: BuildProfile | null,
  target: LogGuardTarget = globalThis as LogGuardTarget,
): boolean {
  if (profile !== "walk") return false;
  const marked = target as LogGuardTarget & { [INSTALLED]?: boolean };
  if (marked[INSTALLED]) return true;

  const consoleObject = target.console as Record<string, unknown> | undefined;
  if (consoleObject) {
    for (const name of CONSOLE_METHODS) consoleObject[name] = noop;
    for (const name of Object.keys(consoleObject)) {
      if (typeof consoleObject[name] === "function") consoleObject[name] = noop;
    }
  }
  target.nativeLoggingHook = noop;

  const errorUtils = target.ErrorUtils;
  if (errorUtils) {
    const previous = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error, isFatal) => previous(redactError(error), isFatal));
  }

  marked[INSTALLED] = true;
  return true;
}

/**
 * The error a handler may see: an Error with the constant message, the same name, and the stack's
 * frame lines only (V8 and Hermes both write frames as "    at …"; the lines before them are the
 * message, which may hold a value). Nothing else of the original is kept: no `cause`, no fields.
 */
export function redactError(error: unknown): Error {
  const redacted = new Error(REDACTED_ERROR_MESSAGE);
  if (error instanceof Error) {
    redacted.name = safeName(error.name);
    let stack = typeof error.stack === "string" ? error.stack : "";
    // The message is cut out first, so a message with a line like a frame leaves nothing behind.
    if (error.message !== "") stack = stack.split(error.message).join("");
    const frames = stack.split("\n").filter((line) => /^\s+at /.test(line));
    redacted.stack = [`${redacted.name}: ${REDACTED_ERROR_MESSAGE}`, ...frames].join("\n");
  } else {
    redacted.stack = `Error: ${REDACTED_ERROR_MESSAGE}`;
  }
  return redacted;
}

/** An error class's name, if it looks like one; a thrown object could put a value in `name`. */
function safeName(name: unknown): string {
  return typeof name === "string" && /^[A-Za-z_$][\w$]{0,63}$/.test(name) ? name : "Error";
}
