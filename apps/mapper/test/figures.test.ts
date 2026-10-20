// The debug card's figures (src/capture/figures.ts; the lean recorder design, section 13): known
// keys in their units, streams in one row each, unknown keys only when their name and value pass
// the screen, and never a clock reading, a coordinate or a pose-named figure. Synthetic values.

import { describe, expect, test } from "vitest";
import {
  documentsAsExpected,
  FIGURE_SECTIONS,
  formatBytes,
  formatDebugFigures,
  formatDuration,
  formatFigure,
  formatLogTail,
  formatRecoveryReport,
  formatSelfTestReport,
  formatTraceFigures,
  keyWords,
} from "../src/capture/figures.ts";

function rowsOf(result: ReturnType<typeof formatDebugFigures>, title: string) {
  return result.sections.find((section) => section.title === title)?.rows ?? [];
}

describe("units", () => {
  test.each([
    [0, "0:00"],
    [42.9, "0:42"],
    [725, "12:05"],
    [3723, "1:02:03"],
    [-1, "—"],
    [Number.NaN, "—"],
  ])("duration %s → %s", (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });

  test.each([
    [512, "512 B"],
    [3482, "3.40 KB"],
    [12 * 1024 * 1024, "12.0 MB"],
    [1.25 * 1024 ** 3, "1.25 GB"],
  ])("bytes %s → %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });

  test("each unit, and values that don't fit it", () => {
    expect(formatFigure(212.4, "us")).toBe("212 µs");
    expect(formatFigure(3.25, "ms")).toBe("3.3 ms");
    expect(formatFigure(59.7, "fps")).toBe("60 fps");
    expect(formatFigure(99.6, "rate")).toBe("100/s");
    expect(formatFigure(4.5, "mbPerMin")).toBe("4.5 MB/min");
    expect(formatFigure(no(), "count")).toBe("—");
    expect(formatFigure(null, "code")).toBe("none");
    expect(formatFigure("no_mesh_history", "code")).toBe("no_mesh_history");
    expect(formatFigure("exports", "codes")).toBe("exports");
    expect(formatFigure("", "codes")).toBe("nothing");
    expect(formatFigure(true, "flag")).toBe("Yes");
    // Not counts, not codes: refused rather than shown.
    expect(formatFigure(1.5, "count")).toBe(null);
    expect(formatFigure(-1, "count")).toBe(null);
    expect(formatFigure("09:41:07", "code")).toBe(null);
    expect(formatFigure("1.2834,103.8607", "codes")).toBe(null);
    expect(formatFigure("Serious", "code")).toBe(null);
    expect(formatFigure("12", "ms")).toBe(null);
    expect(formatFigure(Number.POSITIVE_INFINITY, "ms")).toBe(null);
  });
});

function no(): undefined {
  return undefined;
}

describe("the module's figures", () => {
  test("none yet gives no sections", () => {
    expect(formatDebugFigures(null)).toEqual({ sections: [], notShown: 0 });
  });

  test("known keys in their sections and units, in the catalogue's order", () => {
    const result = formatDebugFigures({
      fps: 60,
      delegateUsP95: 240,
      delegateUsP50: 120,
      recorderState: "open",
      degradation: null,
      windowS: 125,
      gnssState: "window",
      gnssBuffered: 4,
      gnssWritten: 2,
      thermal: "fair",
      lowPowerMode: false,
      documentsNames: "exports",
      freeDiskBytes: 40 * 1024 ** 3,
    });
    expect(result.notShown).toBe(0);
    expect(result.sections.map((section) => section.title)).toEqual([
      "Delegate",
      "Recorder",
      "GNSS",
      "Device",
    ]);
    expect(rowsOf(result, "Delegate")).toEqual([
      { label: "Frame work p50", value: "120 µs" },
      { label: "Frame work p95", value: "240 µs" },
      { label: "Frame rate", value: "60 fps" },
    ]);
    expect(rowsOf(result, "Recorder")).toEqual([
      { label: "State", value: "open" },
      { label: "Degradation", value: "none" },
      { label: "Window length", value: "2:05" },
    ]);
    expect(rowsOf(result, "GNSS")).toEqual([
      { label: "State", value: "window" },
      { label: "Buffered (count)", value: "4" },
      { label: "Written (count)", value: "2" },
    ]);
    expect(rowsOf(result, "Device")).toEqual([
      { label: "Thermal", value: "fair" },
      { label: "Free disk", value: "40.0 GB" },
      { label: "Low Power Mode", value: "No" },
      { label: "Documents holds", value: "exports" },
    ]);
  });

  test("a stream's figures make one row, with its drops", () => {
    const result = formatDebugFigures({
      "stream.frames.bytes": 3 * 1024 * 1024,
      "stream.frames.mbPerMin": 1.5,
      "stream.frames.linesPerS": 60,
      "stream.frames.dropsOutside": 0,
      "stream.imu.bytes": 1024 * 1024,
      "stream.imu.dropsOrder": 3,
      "stream.mesh_bin.bytes": 9 * 1024 * 1024,
    });
    expect(rowsOf(result, "Streams")).toEqual([
      { label: "frames", value: "3.00 MB · 1.5 MB/min · 60/s · no drops" },
      { label: "imu", value: "1.00 MB · dropped 3 out of order" },
      { label: "mesh bin", value: "9.00 MB · no drops" },
    ]);
  });

  test("an unknown key is shown under Other only when its name and value pass", () => {
    const result = formatDebugFigures({
      queueDepth: 3,
      ratio: 0.123456,
      newCode: "ok_state",
      cameraX: 1.25,
      poseYaw: 0.3,
      lastFixLat: 1.29,
      startedAt: 1_792_000_000,
      wallClock: "09:41",
      sessionT: 12.5,
      label: "Some text",
      "stream.frames.extra": 1,
      "bad key!": 1,
    });
    expect(rowsOf(result, "Other")).toEqual([
      { label: "newCode", value: "ok_state" },
      { label: "queueDepth", value: "3" },
      { label: "ratio", value: "0.1235" },
      { label: "stream.frames.extra", value: "1" },
    ]);
    expect(result.notShown).toBe(8);
  });

  test("a known key with a value that doesn't fit is counted, not shown", () => {
    const result = formatDebugFigures({ recorderState: "10:15:00", meshSnapshots: 2.5, fps: 60 });
    expect(rowsOf(result, "Recorder")).toEqual([]);
    expect(result.notShown).toBe(2);
  });

  test("the catalogue's keys are unique and never named like a pose or a clock", () => {
    const keys = FIGURE_SECTIONS.flatMap((section) => section.specs.map((item) => item.key));
    expect(new Set(keys).size).toBe(keys.length);
    const forbidden = ["pose", "camera", "transform", "position", "lat", "lon", "t", "at", "date"];
    for (const key of keys) {
      expect(
        keyWords(key).filter((word) => forbidden.includes(word)),
        key,
      ).toEqual([]);
    }
  });

  test("key words", () => {
    expect(keyWords("delegateUsP95")).toEqual(["delegate", "us", "p"]);
    expect(keyWords("lastFixLat")).toEqual(["last", "fix", "lat"]);
    expect(keyWords("stream.mesh_bin.bytes")).toEqual(["stream", "mesh", "bin", "bytes"]);
    expect(keyWords("GNSSFix")).toEqual(["gnss", "fix"]);
  });
});

describe("reports", () => {
  test("the boundary trace's counts", () => {
    const section = formatTraceFigures({
      sent: 120,
      batches: 4,
      failedBatches: 0,
      buffered: 0,
      droppedBeforeOpen: 9,
      droppedAfterEnd: 1,
      droppedOverLimit: 0,
      tooLarge: 0,
      unserializable: 0,
      clamped: 2,
      refused: 0,
    });
    expect(section.rows[0]).toEqual({ label: "Lines sent", value: "120" });
    expect(section.rows).toContainEqual({ label: "Clamped (out of order)", value: "2" });
    expect(section.rows[1]).toEqual({ label: "Batches (failed)", value: "4 (0)" });
  });

  test("recovery: counts, or none in this build", () => {
    expect(formatRecoveryReport(null).rows).toEqual([
      { label: "Report", value: "None in this build" },
    ]);
    const rows = formatRecoveryReport({
      done: true,
      recovered: 1,
      finished: 0,
      discarded: 2,
      swept: 0,
    }).rows;
    expect(rows).toContainEqual({ label: "Recovered (cut back)", value: "1" });
    expect(rows).toContainEqual({ label: "Discarded", value: "2" });
  });

  test("the self-test: results and timings; unexpected Documents names are flagged", () => {
    const report = {
      passed: true,
      protectionWhileWriting: "completeUnlessOpen",
      protectionAfterClose: "complete",
      excludedFromBackup: true,
      compressionMatches: true,
      sha256Matches: true,
      encodeMBps: 210.4,
      deflateMBps: 55.2,
      sha256MBps: 980,
      documentsNames: ["exports"],
      keptId: null,
    };
    const section = formatSelfTestReport(report);
    expect(section.title).toBe("Self-test: passed");
    expect(section.rows).toContainEqual({
      label: "Protection while writing",
      value: "completeUnlessOpen",
    });
    expect(section.rows).toContainEqual({ label: "Encode", value: "210 MB/s" });
    expect(section.rows).toContainEqual({ label: "Documents holds", value: "exports" });
    expect(documentsAsExpected(report.documentsNames)).toBe(true);
    expect(documentsAsExpected([])).toBe(true);
    expect(documentsAsExpected(["exports", "notes.txt"])).toBe(false);
    const failed = formatSelfTestReport({ ...report, passed: false, documentsNames: ["a b/c"] });
    expect(failed.title).toBe("Self-test: FAILED");
    expect(failed.rows).toContainEqual({ label: "Documents holds", value: "unexpected names" });
  });

  test("the log tail keeps code lines and drops any with a decimal or a clock reading", () => {
    expect(
      formatLogTail([
        "recorder.open frame=120",
        "sink.checkpoint seq=4",
        "at 09:41:07",
        "hit 1.2834 103.8607",
        "x".repeat(200),
        'quote "x"',
      ]),
    ).toEqual({ lines: ["recorder.open frame=120", "sink.checkpoint seq=4"], notShown: 4 });
  });
});
