// The Recordings screen's wording and rules (src/capture/recordings.ts) and the walk screen's
// (src/walk/describe.ts): counts, sizes, durations and ages only; export only from the walk build;
// the runbook's holding folder and the folders it must never use; the REC badge, refusals and the
// summary. Synthetic values only.

import { describe, expect, test } from "vitest";
import type { RecordingSummary } from "../modules/capture-native/src/types.ts";
import { recordRefusalOf } from "../src/capture/native.ts";
import {
  canDelete,
  canExport,
  describeAge,
  describeVenues,
  exportPercent,
  exportRunbook,
  holdingFolder,
  recordingRows,
} from "../src/capture/recordings.ts";
import { redact } from "../src/capture/redacted.ts";
import {
  describeEnded,
  describeRefusal,
  describeWalkError,
  recBadge,
  summaryRows,
} from "../src/walk/describe.ts";
import { initialWalkState, type WalkState, walkSummary } from "../src/walk/flow.ts";
import { CORRIDOR_VENUES } from "../src/walk/venues.ts";

const ID = "3f2b8c1e-7d4a-4e9b-8a6c-2d1f0e9b7a65";

const SUMMARY: RecordingSummary = {
  id: ID,
  origin: "device",
  profile: "lean",
  state: "closed",
  ended: "end_anchor",
  trimmed: false,
  durationS: 431.6,
  bytes: 48 * 1024 * 1024,
  files: 13,
  ageDays: 2.4,
  venues: [CORRIDOR_VENUES[0]?.id ?? "", CORRIDOR_VENUES[1]?.id ?? ""],
  exportParts: null,
};

describe("the recordings list", () => {
  test("a recording's rows: kind, ending, length, size, age and venues", () => {
    expect(recordingRows(SUMMARY)).toEqual([
      { label: "Kind", value: "lean, device" },
      { label: "Ended", value: "end_anchor" },
      { label: "Length", value: "7:11" },
      { label: "Size", value: "48.0 MB in 13 files" },
      { label: "Age", value: "2 days" },
      { label: "Venues", value: "South Beach, Esplanade MRT" },
    ]);
    expect(
      recordingRows({
        ...SUMMARY,
        state: "exported",
        trimmed: true,
        ended: "stop",
        exportParts: 3,
      }),
    ).toContainEqual({ label: "Export", value: "3 parts in exports" });
    expect(recordingRows({ ...SUMMARY, trimmed: true, ended: "stop" })[1]).toEqual({
      label: "Ended",
      value: "stop, cut back",
    });
  });

  test("ages and venues", () => {
    expect(describeAge(0.3)).toBe("today");
    expect(describeAge(1.9)).toBe("1 day");
    expect(describeAge(12)).toBe("12 days");
    expect(describeVenues([])).toBe("none");
    expect(
      describeVenues([CORRIDOR_VENUES[2]?.id ?? "", "0f7d0e65-6f2e-4b43-9a55-5d7f4f0c5b0e"]),
    ).toBe("Raffles City, 1 other");
  });

  test("export only in the walk build, for a closed or recovered recording", () => {
    expect(canExport(SUMMARY, "walk")).toBe(true);
    expect(canExport({ ...SUMMARY, state: "recovered" }, "walk")).toBe(true);
    expect(canExport(SUMMARY, "development")).toBe(false);
    expect(canExport(SUMMARY, null)).toBe(false);
    for (const state of ["open", "needs_recovery", "exported"] as const) {
      expect(canExport({ ...SUMMARY, state }, "walk"), state).toBe(false);
    }
    expect(canDelete(SUMMARY)).toBe(true);
    expect(canDelete({ ...SUMMARY, state: "open" })).toBe(false);
  });

  test("export progress in whole percent", () => {
    expect(exportPercent(null)).toBe(0);
    expect(exportPercent({ id: ID, bytesDone: 0, bytesTotal: 0 })).toBe(0);
    expect(exportPercent({ id: ID, bytesDone: 333, bytesTotal: 1000 })).toBe(33);
    expect(exportPercent({ id: ID, bytesDone: 2000, bytesTotal: 1000 })).toBe(100);
  });
});

describe("the Apple Devices runbook", () => {
  test("names the holding folder for the id, and only a real id", () => {
    expect(holdingFolder(ID)).toBe(`.data/holding/${ID}/`);
    expect(holdingFolder("../../Desktop")).toBe(".data/holding/<recording id>/");
  });

  test("saves straight into holding, never Downloads, Documents, Desktop or OneDrive", () => {
    const steps = exportRunbook(ID).join("\n");
    expect(steps).toContain(`.data/holding/${ID}/`);
    expect(steps).toContain(`replay-${ID}`);
    for (const folder of ["Downloads", "Documents", "Desktop", "OneDrive"]) {
      expect(steps).toMatch(new RegExp(`never [^.]*${folder}`));
    }
    expect(steps).toContain("recording-validator/cli.ts --parts");
    // Delete comes last, after the validation.
    expect(exportRunbook(ID).at(-1)).toMatch(/delete/i);
    expect(exportRunbook(null).join("\n")).toContain("<recording id>");
  });
});

describe("the walk screen's wording", () => {
  test("refusals read from the module's message, worded with their code", () => {
    const refused = Object.assign(
      new Error("Calling the 'start' function has failed\n→ Caused by: notWalkBuild"),
      { code: "ERR_RECORD_REFUSED" },
    );
    expect(recordRefusalOf(refused)).toBe("notWalkBuild");
    expect(recordRefusalOf(Object.assign(new Error("lowDisk"), { code: "ERR_IO" }))).toBe(null);
    expect(
      recordRefusalOf(Object.assign(new Error("nothing"), { code: "ERR_RECORD_REFUSED" })),
    ).toBe(null);
    expect(describeRefusal("debugBuild")).toBe("Refused (debugBuild): this is a debug build");
    expect(describeWalkError({ source: "start", code: "ERR_RECORD_REFUSED" }, "lowDisk")).toBe(
      "Start failed: Refused (lowDisk): less than 16 GB is free.",
    );
    expect(describeWalkError({ source: "markAnchor", code: "ERR_NO_FLOOR_HIT" }, null)).toMatch(
      /^The mark failed \(ERR_NO_FLOOR_HIT\)\. No floor/,
    );
    expect(describeWalkError({ source: "addTag", code: null }, null)).toBe("The tag failed.");
    expect(describeEnded("background")).toBe("the app went to the background");
    expect(describeEnded(null)).toBe("—");
  });

  test("the REC badge: hidden until the window opens, then length, closing and saving", () => {
    const base = initialWalkState(true);
    const withPhase = (phase: WalkState["recording"]["phase"], recordingS = 0): WalkState => ({
      ...base,
      recordingS,
      recording: { ...base.recording, phase },
    });
    expect(recBadge(base, null)).toEqual({ visible: false, text: "" });
    expect(recBadge(withPhase("armed"), null).visible).toBe(false);
    expect(recBadge(withPhase("open", 75), null)).toEqual({ visible: true, text: "REC 1:15" });
    const status = {
      t: redact(80),
      running: true,
      covered: false,
      tracking: "normal" as const,
      mapping: "mapped" as const,
      fps: 60,
      candidateHz: 0,
      frames: 4800,
      candidates: 0,
      meshAnchors: 40,
      thermal: "nominal" as const,
      recorder: { state: "closing" as const, degradation: null, closingInS: 2.2 },
    };
    expect(recBadge(withPhase("open", 75), status)).toEqual({
      visible: true,
      text: "REC · closing in 3 s",
    });
    expect(recBadge(withPhase("finalizing"), null)).toEqual({
      visible: true,
      text: "REC · saving",
    });
  });

  test("the summary: counts and durations, and how the recording ended", () => {
    const state: WalkState = {
      ...initialWalkState(true),
      step: "summary",
      startMarks: 1,
      endMarks: 2,
      tags: { escalator: 2, door: 1 },
      sessionS: 312,
      recordingS: 290,
      recording: { phase: "closed", ended: "end_anchor", trimmed: false, closed: true },
      windowOpened: true,
    };
    expect(summaryRows(walkSummary(state))).toEqual([
      { label: "Session", value: "5:12" },
      { label: "Recording window", value: "4:50" },
      { label: "Start marks", value: "1" },
      { label: "End marks", value: "2" },
      { label: "Tags", value: "3" },
      { label: "  Door", value: "1" },
      { label: "  Escalator", value: "2" },
      { label: "Recording", value: "Saved" },
      { label: "Ended", value: "at the end mark" },
    ]);
    const discarded = summaryRows(
      walkSummary({ ...state, recording: { ...state.recording, phase: "discarded" } }),
    );
    expect(discarded).toContainEqual({ label: "Recording", value: "Discarded (no end mark)" });
  });

  test("the summary: a recording discarded before it opened isn't worded as a missing end mark", () => {
    // Stopped, backgrounded or too hot before the start mark: the module discards the armed
    // recording, though no window ever opened.
    const state: WalkState = {
      ...initialWalkState(true),
      step: "summary",
      sessionS: 40,
      recording: { phase: "discarded", ended: null, trimmed: null, closed: null },
      windowOpened: false,
    };
    const rows = summaryRows(walkSummary(state));
    expect(rows).toContainEqual({
      label: "Recording",
      value: "None (ended before the start mark)",
    });
    expect(rows).not.toContainEqual({ label: "Recording", value: "Discarded (no end mark)" });
  });

  test("a dropped recording tells the walker to stop and start again", () => {
    const before = describeWalkError(
      { source: "recorder", code: null, dropped: "beforeStart" },
      null,
    );
    expect(before).toMatch(/^The recording was dropped before the start mark/);
    expect(before).toMatch(/Stop, then start a new session\.$/);
    expect(
      describeWalkError({ source: "recorder", code: null, dropped: "beforeEnd" }, null),
    ).toMatch(/^The recording was dropped before an end mark/);
  });
});
