// Redacted (src/capture/redacted.ts): however a wrapped pose is printed, it gives "[redacted]";
// only unwrap() reads it.

import { format, inspect } from "node:util";
import { describe, expect, test } from "vitest";
import { isRedacted, Redacted, redact, type SessionTime } from "../src/capture/redacted.ts";

const pose = redact([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.25, -1.4, 3.5, 1]);
const t: SessionTime = redact(12.345);

describe("printing a wrapped value", () => {
  test("String(), template literals and concatenation", () => {
    expect(String(pose)).toBe("[redacted]");
    expect(`${pose}`).toBe("[redacted]");
    expect(`at ${t} s`).toBe("at [redacted] s");
    expect(`${"x"}${pose}`).toBe("x[redacted]");
    expect(pose.toString()).toBe("[redacted]");
  });

  test("JSON.stringify, alone and nested", () => {
    expect(JSON.stringify(pose)).toBe('"[redacted]"');
    expect(JSON.stringify({ hit: { transform: pose }, t })).toBe(
      '{"hit":{"transform":"[redacted]"},"t":"[redacted]"}',
    );
  });

  test("Node's util.inspect and format, as console.log uses them", () => {
    expect(inspect(pose)).toBe("[redacted]");
    expect(inspect({ camera: pose }, { depth: 10, showHidden: true })).toBe(
      "{ camera: [redacted] }",
    );
    expect(format("%o %O %s %j", pose, pose, pose, pose)).toBe(
      '[redacted] [redacted] [redacted] "[redacted]"',
    );
  });

  test("nothing on the object holds the value", () => {
    expect(Object.keys(pose)).toEqual([]);
    expect(Object.getOwnPropertyNames(pose)).toEqual([]);
    expect(Object.getOwnPropertySymbols(pose)).toEqual([]);
    expect(Object.isFrozen(pose)).toBe(true);
    expect({ ...pose }).toEqual({});
  });

  test("arithmetic doesn't leak it either", () => {
    expect(Number.isNaN(Number(t))).toBe(true);
  });
});

test("unwrap reads the value", () => {
  expect(t.unwrap()).toBe(12.345);
  expect(pose.unwrap()[12]).toBe(0.25);
  expect(isRedacted(pose)).toBe(true);
  expect(isRedacted(12.345)).toBe(false);
  expect(new Redacted(null).unwrap()).toBe(null);
});
