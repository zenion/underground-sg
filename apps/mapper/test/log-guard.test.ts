// The walk build's log guard (src/capture/log-guard.ts), on a fake set of globals: in the walk
// build console output and nativeLoggingHook go nowhere and uncaught errors lose their message;
// in any other build nothing changes.

import { describe, expect, test } from "vitest";
import {
  installLogGuard,
  type LogGuardTarget,
  REDACTED_ERROR_MESSAGE,
  redactError,
} from "../src/capture/log-guard.ts";

const FAKE_POSE = "0.25,-1.4,3.5";

function fakeGlobals() {
  const output: string[] = [];
  const handled: { error: unknown; isFatal: boolean | undefined }[] = [];
  let handler = (error: unknown, isFatal?: boolean) => {
    handled.push({ error, isFatal });
  };
  const target: LogGuardTarget = {
    console: {
      log: (...args: unknown[]) => output.push(`log ${args.join(" ")}`),
      warn: (...args: unknown[]) => output.push(`warn ${args.join(" ")}`),
      error: (...args: unknown[]) => output.push(`error ${args.join(" ")}`),
      // A method only this engine has.
      nativeOnly: (...args: unknown[]) => output.push(`nativeOnly ${args.join(" ")}`),
    },
    nativeLoggingHook: (message: string) => output.push(`hook ${message}`),
    ErrorUtils: {
      getGlobalHandler: () => handler,
      setGlobalHandler: (next) => {
        handler = next;
      },
    },
  };
  const call = (name: string, ...args: unknown[]) =>
    (target.console as Record<string, (...args: unknown[]) => void>)[name]?.(...args);
  const hook = (message: string) =>
    (target.nativeLoggingHook as (message: string) => void)(message);
  const fail = (error: unknown, isFatal?: boolean) =>
    target.ErrorUtils?.getGlobalHandler()(error, isFatal);
  return { target, output, handled, call, hook, fail };
}

describe("in the walk build", () => {
  test("console output and nativeLoggingHook are dropped", () => {
    const globals = fakeGlobals();
    expect(installLogGuard("walk", globals.target)).toBe(true);
    globals.call("log", "pose", FAKE_POSE);
    globals.call("warn", FAKE_POSE);
    globals.call("error", new Error(FAKE_POSE));
    globals.call("info", FAKE_POSE);
    globals.call("nativeOnly", FAKE_POSE);
    globals.hook(FAKE_POSE);
    expect(globals.output).toEqual([]);
  });

  test("an uncaught error reaches the handler with its message replaced and its frames kept", () => {
    const globals = fakeGlobals();
    installLogGuard("walk", globals.target);
    const error = new TypeError(`no floor at ${FAKE_POSE}`);
    globals.fail(error, true);
    const [seen] = globals.handled;
    expect(seen?.isFatal).toBe(true);
    expect(seen?.error).toBeInstanceOf(Error);
    const redacted = seen?.error as Error;
    expect(redacted.message).toBe(REDACTED_ERROR_MESSAGE);
    expect(redacted.name).toBe("TypeError");
    expect(redacted.stack).not.toContain(FAKE_POSE);
    expect(redacted.stack?.split("\n")[0]).toBe(`TypeError: ${REDACTED_ERROR_MESSAGE}`);
    expect(redacted.stack).toMatch(/\n\s+at /);
  });

  test("installing twice wraps the handler once", () => {
    const globals = fakeGlobals();
    installLogGuard("walk", globals.target);
    installLogGuard("walk", globals.target);
    globals.fail(new Error(FAKE_POSE));
    expect(globals.handled).toHaveLength(1);
    expect(globals.handled[0]?.error).toMatchObject({ message: REDACTED_ERROR_MESSAGE });
  });
});

test.each([null, "development"] as const)("in a %s build nothing changes", (profile) => {
  const globals = fakeGlobals();
  const handler = globals.target.ErrorUtils?.getGlobalHandler();
  expect(installLogGuard(profile, globals.target)).toBe(false);
  globals.call("log", "desk check");
  globals.hook("desk check");
  expect(globals.output).toEqual(["log desk check", "hook desk check"]);
  expect(globals.target.ErrorUtils?.getGlobalHandler()).toBe(handler);
});

describe("redactError", () => {
  test("a message with a line like a frame leaves nothing behind", () => {
    const error = new Error(`first\n    at ${FAKE_POSE}`);
    expect(redactError(error).stack).not.toContain(FAKE_POSE);
  });

  test("a thrown non-Error becomes a plain redacted Error", () => {
    for (const thrown of [FAKE_POSE, { pose: FAKE_POSE }, 12.5, null]) {
      const redacted = redactError(thrown);
      expect(redacted.message).toBe(REDACTED_ERROR_MESSAGE);
      expect(redacted.stack).toBe(`Error: ${REDACTED_ERROR_MESSAGE}`);
    }
  });

  test("a name that isn't an identifier is not kept", () => {
    const error = new Error("x");
    error.name = FAKE_POSE;
    expect(redactError(error).name).toBe("Error");
  });
});
