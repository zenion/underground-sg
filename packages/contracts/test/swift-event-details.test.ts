// The Swift recorder writes events.jsonl from a typed enum, and its tests check every case's
// detail against a copy of RECORDING_EVENT_DETAILS (RecordingEventTests.swift in the capture
// module). This checks that copy against the table here, so the Swift tests can't pass against a
// stale table.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { RECORDING_EVENT_DETAILS } from "../src/recording.ts";

const SWIFT_TESTS = new URL(
  "../../../apps/mapper/modules/capture-native/Tests/CaptureCoreTests/RecordingEventTests.swift",
  import.meta.url,
);

/** The Swift dictionary literal `recordingEventDetails`, as kind to rule. */
function swiftTable(source: string): Record<string, string> {
  const start = source.indexOf("private let recordingEventDetails: [String: DetailRule] = [");
  const end = source.indexOf("\n]\n", start);
  if (start < 0 || end < 0) throw new Error("RecordingEventTests.swift has no table");
  const table: Record<string, string> = {};
  for (const line of source.slice(start, end).split("\n").slice(1)) {
    const entry = /^\s*"([a-z_]+)": \.([a-z]+),$/.exec(line);
    if (entry === null) throw new Error(`an unexpected line in the Swift table: ${line.trim()}`);
    table[entry[1] as string] = entry[2] as string;
  }
  return table;
}

describe("the Swift copy of RECORDING_EVENT_DETAILS", () => {
  test("is the same table", () => {
    const swift = swiftTable(readFileSync(SWIFT_TESTS, "utf8"));
    expect(swift).toEqual({ ...RECORDING_EVENT_DETAILS });
  });

  test("the reader finds every entry", () => {
    const sample = [
      "private let recordingEventDetails: [String: DetailRule] = [",
      '  "recording_opened": .null,',
      '  "thermal": .thermal,',
      "]",
      "",
    ].join("\n");
    expect(swiftTable(sample)).toEqual({ recording_opened: "null", thermal: "thermal" });
  });
});
