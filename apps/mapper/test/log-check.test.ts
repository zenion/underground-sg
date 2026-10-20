// The walk build's log check (src/capture/log-check.ts), on fake globals: without the guard the
// marker reaches every channel, which proves the check reaches the log; with the walk build's
// guard nothing does, and the error handler sees only the redacted message, as non-fatal.

import { expect, test } from "vitest";
import { LOG_CHECK_TEXT, runLogCheck } from "../src/capture/log-check.ts";
import {
  installLogGuard,
  type LogGuardTarget,
  REDACTED_ERROR_MESSAGE,
} from "../src/capture/log-guard.ts";

function fakeGlobals() {
  const output: string[] = [];
  const handled: { message: string; isFatal: boolean | undefined }[] = [];
  let handler = (error: unknown, isFatal?: boolean) => {
    handled.push({ message: (error as Error).message, isFatal });
  };
  const target: LogGuardTarget = {
    console: {
      log: (...args: unknown[]) => output.push(`log ${args.join(" ")}`),
      error: (...args: unknown[]) => output.push(`error ${args.join(" ")}`),
    },
    nativeLoggingHook: (message: string) => output.push(`hook ${message}`),
    ErrorUtils: {
      getGlobalHandler: () => handler,
      setGlobalHandler: (next) => {
        handler = next;
      },
    },
  };
  return { target, output, handled };
}

test("without the guard the marker reaches every channel", () => {
  const globals = fakeGlobals();
  expect(runLogCheck(globals.target)).toEqual([
    "console.log",
    "console.error",
    "nativeLoggingHook",
    "ErrorUtils",
  ]);
  expect(globals.output).toEqual([
    `log ${LOG_CHECK_TEXT}`,
    `error ${LOG_CHECK_TEXT}`,
    `hook ${LOG_CHECK_TEXT}`,
  ]);
  expect(globals.handled).toEqual([{ message: LOG_CHECK_TEXT, isFatal: false }]);
});

test("with the walk build's guard nothing of the marker is left", () => {
  const globals = fakeGlobals();
  installLogGuard("walk", globals.target);
  runLogCheck(globals.target);
  expect(globals.output).toEqual([]);
  expect(globals.handled).toEqual([{ message: REDACTED_ERROR_MESSAGE, isFatal: false }]);
});
