// validate-recording on synthetic recordings and replay sets generated in code
// (recording-fixture.ts): a valid lean set in every input form, each missing file, every rule the
// schemas leave to code, the export's parts, and hostile input.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterAll, describe, expect, test } from "vitest";
import type { MeshHistoryLine, RecordingManifest } from "../src/index.ts";
import {
  formatRecordingReport,
  RECORDING_PROBLEM_CODES,
  RECORDING_REQUIRED_FILES,
  type RecordingProblem,
  type RecordingProblemCode,
  type RecordingValidationReport,
  type ValidateRecordingOptions,
  validateRecording,
  validateRecordingParts,
  validateRecordingTar,
} from "../src/recording-validator/index.ts";
import { BUNDLE_DIR, jsonl, text } from "./bundle-fixture.ts";
import {
  END_T,
  exportParts,
  KEPT_FRAME,
  leanSpec,
  REC_DIR,
  type RecordingFiles,
  type RecordingSpec,
  type ReplaySet,
  recording,
  removeRecordingDirectories,
  replaced,
  replaySet,
  setTar,
  standardSpec,
  withRecordingManifest,
  writePartsDirectory,
  writeRecordingDirectory,
  writeSetDirectory,
  writeTemporaryFile,
} from "./recording-fixture.ts";
import { chunks } from "./tar-writer.ts";

afterAll(removeRecordingDirectories);

const OTHER_ID = "0e4b7c2a-9f13-4d68-a5e0-3b1c8d7f2a94";

function problems(report: RecordingValidationReport): RecordingProblem[] {
  return [...report.errors, ...report.warnings];
}

function codes(report: RecordingValidationReport): RecordingProblemCode[] {
  return [...new Set(problems(report).map((problem) => problem.code))];
}

/** Asserts that the report has a problem with this code (and file and line, when given). */
function expectProblem(
  report: RecordingValidationReport,
  code: RecordingProblemCode,
  file?: string | null,
  line?: number,
): RecordingProblem {
  const found = problems(report).find(
    (problem) =>
      problem.code === code &&
      (file === undefined || problem.file === file) &&
      (line === undefined || problem.line === line),
  );
  expect(
    found,
    `${code} ${file ?? ""} in ${JSON.stringify(problems(report), null, 2)}`,
  ).toBeDefined();
  return found as RecordingProblem;
}

/** Asserts a valid report with no problems, the bundles' included. */
function expectClean(report: RecordingValidationReport): void {
  expect(problems(report)).toEqual([]);
  for (const bundle of report.bundles) {
    expect([...bundle.report.errors, ...bundle.report.warnings]).toEqual([]);
  }
  expect(report.valid).toBe(true);
  expect(report.failure_reason).toBeNull();
}

/** Validates the recording written as rec-<recording_id>/. */
function asDirectory(
  files: RecordingFiles,
  options: ValidateRecordingOptions = {},
  name = REC_DIR,
): Promise<RecordingValidationReport> {
  return validateRecording(writeRecordingDirectory(files, name), options);
}

/** Validates the set as its tar, written to a file (so the mesh blocks can be read again). */
function asTarFile(set: ReplaySet, options: ValidateRecordingOptions = {}) {
  return validateRecording(writeTemporaryFile("set.tar", setTar(set)), options);
}

/** A recording alone, as a set without bundles. */
function alone(files: RecordingFiles): ReplaySet {
  return { recording: files, bundles: new Map() };
}

/** recording.json's document without files, from a recording's files. */
function manifestOf(files: RecordingFiles): Omit<RecordingManifest, "files"> {
  const { files: _files, ...rest } = JSON.parse(
    new TextDecoder().decode(files.get("recording.json")),
  ) as RecordingManifest;
  return rest;
}

/** `changes` applied, with recording.json's files listing them again. */
function relisted(
  files: RecordingFiles,
  changes: Record<string, Uint8Array | null>,
): RecordingFiles {
  return withRecordingManifest(replaced(files, changes), manifestOf(files));
}

/** A JSONL file's lines, changed by `change`, with the listing updated. */
function editLines<T>(
  files: RecordingFiles,
  path: string,
  change: (lines: T[]) => void,
): RecordingFiles {
  const lines = new TextDecoder()
    .decode(files.get(path))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as T);
  change(lines);
  return relisted(files, { [path]: jsonl(lines) });
}

/** A lean recording with its spec changed. */
function lean(change: (spec: RecordingSpec) => void): RecordingFiles {
  return recording(leanSpec(), change);
}

describe("a valid recording", () => {
  test("a lean recording directory has no problems", async () => {
    const report = await asDirectory(recording());
    expectClean(report);
    expect(report.source).toBe("directory");
    expect(report.recording_id).toBe(REC_DIR.slice(4));
    expect(report.info).toMatchObject({
      profile: "lean",
      ended: "end_anchor",
      closed: true,
      candidates: 4,
      candidates_kept: 0,
      mesh_blocks: 4,
      segments: 0,
    });
    expect(report.info.lines["frames.jsonl"]).toBe(11);
    expect(report.info.mesh_inflated_bytes).toBe(3 * (4 * 12 + 2 * 13) + (3 * 12 + 13));
    expect(report.info.checks_skipped).toEqual([
      "Segments against their bundles: a recording directory alone, without its replay set",
    ]);
  });

  test("a lean recording's tar, as a file, has no problems", async () => {
    const report = await asTarFile(alone(recording()));
    expectClean(report);
    expect(report.source).toBe("tar");
    expect(report.info.mesh_inflated_bytes).toBeGreaterThan(0);
  });

  test("a tar from a stream can't be read twice, so the mesh blocks are not inflated", async () => {
    const report = await validateRecordingTar(chunks(setTar(alone(recording())), 1000));
    expect(report.valid).toBe(true);
    expect(problems(report)).toEqual([]);
    expect(report.info.mesh_inflated_bytes).toBeNull();
    expect(report.info.checks_skipped).toContain(
      "Mesh block inflate check: the tar was read from a stream, which can't be read twice",
    );
  });

  test("a replay set directory with its bundle has no problems", async () => {
    const report = await validateRecording(writeSetDirectory(replaySet()));
    expectClean(report);
    expect(report.source).toBe("set_directory");
    expect(report.bundles.map((bundle) => bundle.directory)).toEqual([BUNDLE_DIR]);
    expect(report.info.segments).toBe(1);
  });

  test("a replay set's tar has no problems", async () => {
    const report = await asTarFile(replaySet());
    expectClean(report);
    expect(report.bundles).toHaveLength(1);
  });

  test("a standard recording with a kept candidate has no problems", async () => {
    const report = await asDirectory(recording(standardSpec()));
    expectClean(report);
    expect(report.info.candidates_kept).toBe(1);
  });

  test("mesh history may be absent once it stopped before its first snapshot", async () => {
    const report = await asDirectory(
      lean((spec) => {
        spec.mesh = null;
        spec.events.splice(1, 0, { t: 2, kind: "degradation", detail: "no_mesh_history" });
      }),
    );
    expectClean(report);
  });
});

describe("required files", () => {
  test.each(RECORDING_REQUIRED_FILES)("without %s it is invalid", async (path) => {
    const files = recording();
    const without =
      path === "recording.json"
        ? replaced(files, { [path]: null })
        : relisted(files, { [path]: null });
    const report = await asDirectory(without);
    expect(report.valid).toBe(false);
    expectProblem(report, "file.missing", path);
  });

  test("mesh/history.bin and its index come together", async () => {
    const report = await asDirectory(relisted(recording(), { "mesh/history.bin": null }));
    expectProblem(report, "file.missing", "mesh/history.bin");
  });

  test("without mesh history and no degradation event, both files are missing", async () => {
    const report = await asDirectory(lean((spec) => (spec.mesh = null)));
    expectProblem(report, "file.missing", "mesh/history.bin");
    expectProblem(report, "file.missing", "mesh/history.jsonl");
  });

  test("a standard recording needs privacy/blur.jsonl", async () => {
    const report = await asDirectory(
      recording(standardSpec(), (spec) => {
        spec.blur = null;
      }),
    );
    expectProblem(report, "file.missing", "privacy/blur.jsonl");
  });

  test("a file outside the layout is rejected", async () => {
    const report = await asDirectory(relisted(recording(), { "notes.txt": text("hello") }));
    expectProblem(report, "path.outside_layout", "notes.txt");
  });
});

describe("candidates", () => {
  test("a kept candidate without a blur line is invalid", async () => {
    const report = await asDirectory(
      recording(standardSpec(), (spec) => {
        spec.blur = [];
      }),
    );
    expect(report.valid).toBe(false);
    expect(
      expectProblem(report, "candidate.blur_line_missing", "privacy/blur.jsonl").message,
    ).toContain(`frame ${KEPT_FRAME}`);
  });

  test("a kept candidate without its JPEG or depth is invalid", async () => {
    const files = recording(standardSpec());
    const report = await asDirectory(
      relisted(files, { "candidates/000125.jpg": null, "depth/000125.png": null }),
    );
    expectProblem(report, "candidate.jpeg_missing", "candidates/000125.jpg");
    expectProblem(report, "candidate.depth_missing", "depth/000125.png");
  });

  test("a candidate file in lean, or for a frame not kept, is rejected", async () => {
    const files = recording(standardSpec());
    const jpg = files.get("candidates/000125.jpg") as Uint8Array;
    const leanReport = await asDirectory(relisted(recording(), { "candidates/000125.jpg": jpg }));
    expectProblem(leanReport, "candidate.unexpected_file", "candidates/000125.jpg");
    const standardReport = await asDirectory(relisted(files, { "candidates/000126.jpg": jpg }));
    expectProblem(standardReport, "candidate.unexpected_file", "candidates/000126.jpg");
  });

  test("a blur line for a frame that isn't a kept candidate is invalid", async () => {
    const report = await asDirectory(
      recording(standardSpec(), (spec) => {
        spec.blur?.push({ frame: 127, boxes: [] });
      }),
    );
    expectProblem(report, "blur.not_candidate", "privacy/blur.jsonl", 2);
  });

  test("a candidate JPEG must be at the video format's size", async () => {
    // The fixture writes JPEGs at the video format's size, so change the format after.
    const files = recording(standardSpec());
    const manifest = manifestOf(files);
    const report = await asDirectory(
      withRecordingManifest(files, {
        ...manifest,
        arkit: { ...manifest.arkit, video_format: { width: 32, height: 24, fps: 60 } },
      }),
    );
    expectProblem(report, "jpeg.size_mismatch", "candidates/000125.jpg");
  });
});

describe("recording.json", () => {
  test("files must match the recording", async () => {
    const files = recording();
    const frames = files.get("frames.jsonl") as Uint8Array;
    const changed = frames.slice();
    changed[10] = (changed[10] ?? 0) ^ 1;
    const report = await asDirectory(
      replaced(files, { "frames.jsonl": changed, "location.jsonl": null, "extra.jsonl": null }),
    );
    expectProblem(report, "files.sha256_mismatch", "frames.jsonl");
    expectProblem(report, "files.listed_but_missing", "location.jsonl");
    const longer = await asDirectory(
      replaced(files, {
        "telemetry.jsonl": text(`${new TextDecoder().decode(files.get("telemetry.jsonl"))}\n`),
      }),
    );
    expectProblem(longer, "files.bytes_mismatch", "telemetry.jsonl");
    const unlisted = await asDirectory(
      replaced(files, { "boundary/000009.f32": new Uint8Array(4) }),
    );
    expectProblem(unlisted, "files.not_listed", "boundary/000009.f32");
  });

  test("the directory is named after recording_id", async () => {
    const report = await asDirectory(recording(), {}, `rec-${OTHER_ID}`);
    expectProblem(report, "recording.id_mismatch", `rec-${OTHER_ID}/`);
  });

  test("a recording that was never closed is reported, without the listing", async () => {
    const report = await asDirectory(
      lean((spec) => {
        spec.manifest.window = { start_t: 2, end_t: null, ended: null, trimmed: false };
        spec.manifest.rates = null;
        spec.manifest.closed = false;
        spec.anchors = spec.anchors.filter((line) => !line.final);
        spec.mesh = spec.mesh?.filter((snapshot) => !snapshot.final) ?? null;
      }),
    );
    expect(codes(report)).toEqual(["recording.open"]);
  });

  test("window.end_t, ended and rates are null together", async () => {
    const report = await asDirectory(lean((spec) => (spec.manifest.rates = null)));
    expectProblem(report, "recording.window_state", "recording.json");
  });

  test("window.end_t is not before window.start_t", async () => {
    const report = await asDirectory(
      lean((spec) => {
        spec.manifest.window.start_t = 3.5;
      }),
    );
    expectProblem(report, "recording.window_order", "recording.json");
  });

  test("build.profile is synthetic exactly when origin is", async () => {
    const report = await asDirectory(lean((spec) => (spec.manifest.origin = "device")));
    expectProblem(report, "recording.build_profile", "recording.json");
  });

  test("detector_versions is null exactly in lean", async () => {
    const report = await asDirectory(
      lean((spec) => {
        spec.manifest.detector_versions = standardSpec().manifest.detector_versions;
      }),
    );
    expectProblem(report, "recording.detector_versions", "recording.json");
  });

  test("the window is at most maxSessionSeconds", async () => {
    const files = lean((spec) => (spec.manifest.window.start_t = 0.5));
    const report = await asDirectory(files, { limits: { maxSessionSeconds: 2 } });
    expectProblem(report, "limits.session_length", "recording.json");
    expectClean(await asDirectory(files, { limits: { maxSessionSeconds: 3 } }));
  });

  test("another recording_version gets one error, described by type", async () => {
    const secret = { lat: 1.2935, lon: 103.8553 };
    const files = recording();
    const report = await asDirectory(
      withRecordingManifest(files, { ...manifestOf(files), recording_version: secret }),
    );
    expect(codes(report)).toEqual(["recording.version"]);
    expect(report.errors[0]?.message).toContain("an object");
    expect(JSON.stringify(report)).not.toContain("103.8553");
  });

  test("an invalid recording.json is a schema error, and its checks are skipped", async () => {
    const files = recording();
    const report = await asDirectory(
      withRecordingManifest(files, { ...manifestOf(files), surprise: true }),
    );
    expect(expectProblem(report, "schema.invalid", "recording.json").message).toContain(
      '"surprise"',
    );
    expect(report.info.checks_skipped).toContain("Checks against recording.json: it is not valid");
  });
});

describe("segments", () => {
  test("a manifest_sha256 needs an end_t", async () => {
    const report = await asDirectory(
      lean((spec) => {
        spec.manifest.segments = [
          {
            capture_id: OTHER_ID,
            manifest_sha256: "0".repeat(64),
            start_t: 2,
            end_t: null,
            frame_offset: 0,
            kept: true,
          },
        ];
      }),
    );
    expectProblem(report, "segment.hash_without_end", "recording.json");
    // A recording directory alone is not an exported set.
    expect(codes(report)).not.toContain("segment.incomplete");
  });

  test("a segment's end_t is not before its start_t, and each is listed once", async () => {
    const set = replaySet((spec) => {
      const segment = spec.manifest.segments[0];
      if (segment === undefined) throw new Error("no segment");
      spec.manifest.segments.push({ ...segment, start_t: 2.9, end_t: 2.5 });
    });
    const report = await asTarFile(set);
    expectProblem(report, "segment.order", "recording.json");
    expectProblem(report, "segment.duplicate", "recording.json");
  });

  test("in an exported set every kept segment has both end_t and manifest_sha256", async () => {
    const set = replaySet((spec) => {
      const segment = spec.manifest.segments[0];
      if (segment !== undefined) segment.manifest_sha256 = null;
    });
    const report = await asTarFile(set);
    expectProblem(report, "segment.incomplete", "recording.json");
  });

  test("each segment's manifest SHA-256 matches its bundle's manifest.json", async () => {
    const set = replaySet((spec) => {
      const segment = spec.manifest.segments[0];
      if (segment !== undefined) segment.manifest_sha256 = "f".repeat(64);
    });
    const report = await validateRecording(writeSetDirectory(set));
    expectProblem(report, "segment.manifest_sha256_mismatch", "recording.json");
  });

  test("a kept segment's bundle is in the set, and every bundle has a kept segment", async () => {
    const set = replaySet();
    const missing = await asTarFile({ recording: set.recording, bundles: new Map() });
    expectProblem(missing, "segment.bundle_missing", "recording.json");
    const unlisted = await asTarFile({ recording: recording(), bundles: set.bundles });
    expectProblem(unlisted, "segment.bundle_not_listed", `${BUNDLE_DIR}/`);
  });

  test("an invalid bundle makes the set invalid, with the bundle's own report", async () => {
    const set = replaySet();
    const bundle = new Map(set.bundles.get(BUNDLE_DIR));
    bundle.set("poses.jsonl", text("{}\n"));
    const report = await asTarFile({
      recording: set.recording,
      bundles: new Map([[BUNDLE_DIR, bundle]]),
    });
    expect(report.valid).toBe(false);
    expectProblem(report, "bundle.invalid", `${BUNDLE_DIR}/`);
    expect(report.bundles[0]?.report.valid).toBe(false);
  });
});

describe("the set's layout", () => {
  test("a set directory holds only the recording and bundles", async () => {
    const root = writeSetDirectory(replaySet());
    writeFileSync(join(root, "notes.txt"), "hello");
    const report = await validateRecording(root);
    expectProblem(report, "path.outside_set", "notes.txt");
  });

  test("a set without a recording is invalid", async () => {
    const root = writeSetDirectory(replaySet());
    rmSync(join(root, REC_DIR), { recursive: true });
    const report = await validateRecording(root);
    expectProblem(report, "set.no_recording", null);
  });

  test("a second recording in a tar is outside the set", async () => {
    const set = replaySet();
    const tar = setTar(set);
    const second = setTar(alone(recording()), `rec-${OTHER_ID}`);
    // Join the two tars, dropping the first one's end-of-archive marker.
    const joined = new Uint8Array(tar.length - 1024 + second.length);
    joined.set(tar.subarray(0, tar.length - 1024));
    joined.set(second, tar.length - 1024);
    const report = await validateRecording(writeTemporaryFile("two.tar", joined));
    expectProblem(report, "path.outside_set", `rec-${OTHER_ID}`);
  });
});

describe("lines", () => {
  test("each event kind's detail is what RECORDING_EVENT_DETAILS allows", async () => {
    const report = await asDirectory(
      lean((spec) => {
        spec.events[3] = { t: 2.6, kind: "thermal", detail: "warm" };
        spec.events[0] = { t: 2, kind: "recording_opened", detail: "x" };
      }),
    );
    expect(expectProblem(report, "events.detail", "events.jsonl", 4).message).toBe(
      "The detail of a thermal event must be a thermal state (RECORDING_EVENT_DETAILS)",
    );
    expectProblem(report, "events.detail", "events.jsonl", 1);
  });

  test("actions.jsonl never logs the recorder's plumbing", async () => {
    const report = await asDirectory(
      lean((spec) => {
        const first = spec.actions[0];
        if (first !== undefined) spec.actions[0] = { ...first, call: "exportRecording" };
      }),
    );
    expectProblem(report, "actions.plumbing_call", "actions.jsonl", 1);
  });

  test("args, result and value are JSON text; the too-large marker is a warning", async () => {
    const report = await asDirectory(
      lean((spec) => {
        const [first, second] = spec.actions;
        if (first === undefined || second === undefined) throw new Error("no actions");
        spec.actions[0] = { ...first, args: "[{" };
        spec.actions[1] = { ...second, result: '{"omitted":"too_large","bytes":70000}' };
        const value = spec.boundary[2];
        if (value !== undefined) spec.boundary[2] = { ...value, value: "not json" };
      }),
    );
    expectProblem(report, "json_text.invalid", "actions.jsonl", 1);
    expectProblem(report, "json_text.invalid", "boundary.jsonl", 3);
    const warning = expectProblem(report, "json_text.too_large", "actions.jsonl", 2);
    expect(warning.severity).toBe("warning");
    expect(warning.message).not.toContain("70000");

    const markerOnly = await asDirectory(
      lean((spec) => {
        const value = spec.boundary[0];
        if (value !== undefined) {
          spec.boundary[0] = { ...value, value: '{"bytes":20000,"omitted":"too_large"}' };
        }
      }),
    );
    expect(markerOnly.valid).toBe(true);
    expect(codes(markerOnly)).toEqual(["json_text.too_large"]);
  });

  test("exactly one of a boundary line's value and binary is set, binary named by seq", async () => {
    const report = await asDirectory(
      lean((spec) => {
        const [first, second] = spec.boundary;
        if (first === undefined || second === undefined) throw new Error("no boundary lines");
        spec.boundary[0] = { ...first, value: null };
        spec.boundary[1] = { ...second, binary: "boundary/000002.f32" };
      }),
    );
    expectProblem(report, "boundary.value_binary", "boundary.jsonl", 1);
    expectProblem(report, "boundary.binary_path", "boundary.jsonl", 2);
    expectProblem(report, "boundary.binary_missing", "boundary/000002.f32");
    expectProblem(report, "boundary.unexpected_file", "boundary/000001.f32");
  });

  test("a binary result is a whole number of float32 values", async () => {
    const report = await asDirectory(
      relisted(recording(), { "boundary/000001.f32": new Uint8Array(5) }),
    );
    expectProblem(report, "boundary.binary_size", "boundary/000001.f32");
  });

  test("the attitude's norm is within 1e-3 of 1", async () => {
    const report = await asDirectory(
      lean((spec) => {
        const sample = spec.motion[2];
        if (sample !== undefined) sample.attitude = [0, 0, 0, 0.99];
      }),
    );
    expectProblem(report, "motion.attitude_norm", "motion.jsonl", 3);
  });

  test("heading is null in an arbitrary reference frame", async () => {
    const withHeading = (spec: RecordingSpec) => {
      const sample = spec.motion[4];
      if (sample !== undefined) sample.heading = 41.5;
    };
    const report = await asDirectory(lean(withHeading));
    expectProblem(report, "motion.heading_arbitrary", "motion.jsonl", 5);
    const north = await asDirectory(
      lean((spec) => {
        withHeading(spec);
        spec.manifest.motion = { reference_frame: "xMagneticNorthZVertical" };
      }),
    );
    expectClean(north);
  });

  test("motion.jsonl is empty exactly when motion is null", async () => {
    const empty = await asDirectory(lean((spec) => (spec.motion = [])));
    expectProblem(empty, "motion.file_state", "motion.jsonl");
    const unavailable = await asDirectory(lean((spec) => (spec.manifest.motion = null)));
    expectProblem(unavailable, "motion.file_state", "motion.jsonl");
    const both = await asDirectory(
      lean((spec) => {
        spec.manifest.motion = null;
        spec.motion = [];
      }),
    );
    expectClean(both);
  });

  test("t, frame and seq order", async () => {
    const report = await asDirectory(
      lean((spec) => {
        const [imu0, imu1] = spec.imu;
        if (imu0 !== undefined && imu1 !== undefined) imu1.t = imu0.t;
        const frame = spec.frames[3];
        if (frame !== undefined) frame.frame = 122;
        const anchor = spec.anchors[3];
        if (anchor !== undefined) anchor.t = 2.4;
        const boundary = spec.boundary[2];
        if (boundary !== undefined) boundary.seq = 1;
      }),
    );
    expectProblem(report, "order.t", "imu.jsonl", 2);
    expectProblem(report, "order.frame", "frames.jsonl", 4);
    expectProblem(report, "order.t", "anchors.jsonl", 4);
    expectProblem(report, "order.seq", "boundary.jsonl", 3);
    // Equal times are fine where t only never decreases (events at the opening).
    expect(problems(report).filter((problem) => problem.file === "events.jsonl")).toEqual([]);
  });

  test("nothing is outside the window", async () => {
    const report = await asDirectory(
      lean((spec) => {
        spec.imu.unshift({ t: 1.9, accel: [0, -9.8, 0], gyro: [0, 0, 0] });
        spec.telemetry.push({ ...(spec.telemetry[0] as (typeof spec.telemetry)[number]), t: 3.5 });
      }),
    );
    const before = expectProblem(report, "window.outside", "imu.jsonl", 1);
    expect(before.message).toBe(
      "t is before window.start_t: nothing from before the recording opened is written",
    );
    expectProblem(report, "window.outside", "telemetry.jsonl", 2);
  });
});

describe("anchor and mesh history", () => {
  test("an anchor's first line is an add", async () => {
    const report = await asDirectory(
      lean((spec) => {
        const first = spec.anchors[0];
        if (first !== undefined) first.op = "update";
      }),
    );
    expectProblem(report, "history.first_not_add", "anchors.jsonl", 1);
  });

  test("transform is null exactly for remove; frame only on keyframe anchors", async () => {
    const report = await asDirectory(
      lean((spec) => {
        const removed = spec.anchors[4];
        if (removed !== undefined)
          removed.transform = removed.transform ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        const marked = spec.anchors[0];
        if (marked !== undefined) marked.frame = 120;
      }),
    );
    expectProblem(report, "history.null_fields", "anchors.jsonl", 5);
    expectProblem(report, "anchors.frame", "anchors.jsonl", 1);
  });

  test("capture_id only on final lines, and only a segment's", async () => {
    const report = await asDirectory(
      lean((spec) => {
        const first = spec.anchors[0];
        if (first !== undefined) first.capture_id = OTHER_ID;
        const final = spec.anchors[5];
        if (final !== undefined) final.capture_id = OTHER_ID;
      }),
    );
    expectProblem(report, "history.capture_id_not_final", "anchors.jsonl", 1);
    expectProblem(report, "history.capture_id_unknown", "anchors.jsonl", 6);
  });

  test("final lines are at window.end_t, and only after closes that take a final sample", async () => {
    const early = await asDirectory(
      lean((spec) => {
        const final = spec.anchors[5];
        if (final !== undefined) final.t = 2.95;
      }),
    );
    expectProblem(early, "history.final_not_at_end", "anchors.jsonl", 6);
    const stopped = await asDirectory(
      lean((spec) => {
        spec.manifest.window.ended = "stop";
        spec.events[4] = { t: END_T, kind: "recording_closed", detail: "stop" };
      }),
    );
    expectProblem(stopped, "history.final_unexpected", "anchors.jsonl", 6);
    expectProblem(stopped, "history.final_unexpected", "mesh/history.jsonl", 5);
  });

  test("mesh lines have their block fields exactly unless they are a remove", async () => {
    const report = await asDirectory(
      editLines<MeshHistoryLine>(recording(), "mesh/history.jsonl", (lines) => {
        const removed = lines[3];
        if (removed !== undefined) removed.offset = 0;
        const added = lines[0];
        if (added !== undefined) added.faces = null;
      }),
    );
    expectProblem(report, "history.null_fields", "mesh/history.jsonl", 4);
    expectProblem(report, "history.null_fields", "mesh/history.jsonl", 1);
  });

  test("each block lies inside history.bin, without overlapping another", async () => {
    const files = recording();
    const bin = files.get("mesh/history.bin") as Uint8Array;
    const cut = await asDirectory(
      relisted(files, { "mesh/history.bin": bin.subarray(0, bin.length - 3) }),
    );
    expectProblem(cut, "mesh.block_outside_bin", "mesh/history.jsonl", 5);
    const overlapping = await asDirectory(
      editLines<MeshHistoryLine>(files, "mesh/history.jsonl", (lines) => {
        const second = lines[1];
        if (second !== undefined) second.offset = 0;
      }),
    );
    expectProblem(overlapping, "mesh.block_overlap", "mesh/history.jsonl");
  });

  test("each block inflates to 12 bytes a vertex plus 13 a face", async () => {
    const report = await asDirectory(
      editLines<MeshHistoryLine>(recording(), "mesh/history.jsonl", (lines) => {
        const first = lines[0];
        if (first !== undefined) first.vertices = 5;
      }),
    );
    expect(expectProblem(report, "mesh.block_invalid", "mesh/history.jsonl", 1).message).toBe(
      "The block inflates to 74 bytes, not 86 (12 a vertex for 5, 13 a face for 2)",
    );
  });

  test("a block that isn't DEFLATE, or has bytes after its stream, is invalid", async () => {
    const files = recording();
    const bin = (files.get("mesh/history.bin") as Uint8Array).slice();
    bin.fill(0xff, 0, 4);
    const garbage = await asDirectory(relisted(files, { "mesh/history.bin": bin }));
    expect(expectProblem(garbage, "mesh.block_invalid", "mesh/history.jsonl", 1).message).toBe(
      "The block is not a complete raw DEFLATE stream",
    );
    const padded = await asDirectory(
      editLines<MeshHistoryLine>(files, "mesh/history.jsonl", (lines) => {
        // Line 1's block, read one byte longer: the first byte of line 2's block follows it.
        const first = lines[0];
        const second = lines[1];
        if (first?.bytes != null && second?.offset != null && second.bytes != null) {
          first.bytes += 1;
          second.offset += 1;
          second.bytes -= 1;
        }
      }),
    );
    expect(expectProblem(padded, "mesh.block_invalid", "mesh/history.jsonl", 1).message).toBe(
      "1 bytes of the block follow the end of its DEFLATE stream",
    );
  });

  test("each face's indices are below the vertex count, and classifications 0 to 7", async () => {
    const report = await asDirectory(
      lean((spec) => {
        spec.mesh = [
          {
            t: 2,
            anchor: "3a8c1e57-9d02-4f6b-b4e3-7c5d0a2f9e81",
            op: "add",
            final: false,
            geometry: {
              vertices: [
                [0, 0, 0],
                [1, 0, 0],
                [1, 0, -1],
              ],
              faces: [[0, 1, 3, 2]],
            },
          },
          {
            t: 2.5,
            anchor: "c4f07b2d-61e8-4a39-9e5c-0d8b3a6f1e27",
            op: "add",
            final: false,
            geometry: {
              vertices: [
                [0, 0, 0],
                [1, 0, 0],
                [1, 0, -1],
              ],
              faces: [[0, 1, 2, 9]],
            },
          },
        ];
      }),
    );
    expect(expectProblem(report, "mesh.vertex_index", "mesh/history.jsonl", 1).message).toBe(
      "Face 0 refers to a vertex beyond the block's 3 vertices",
    );
    expectProblem(report, "mesh.classification", "mesh/history.jsonl", 2);
  });

  test("a block over maxMeshBlockBytes is not inflated", async () => {
    const report = await asDirectory(recording(), { limits: { maxMeshBlockBytes: 60 } });
    expectProblem(report, "limits.mesh_block", "mesh/history.jsonl", 1);
    // The wall piece's block (3 vertices, 1 face: 49 bytes) is still checked.
    expect(report.info.mesh_inflated_bytes).toBe(49);
  });
});

describe("limits and parsing", () => {
  test("a line longer than maxJsonlLineBytes is reported by line", async () => {
    const files = recording();
    const actions = new TextDecoder().decode(files.get("actions.jsonl")).split("\n");
    const long = `{"t":2.5,"call":"addTag","args":"${"x".repeat(70_000)}","result":null,"error":null}`;
    const report = await asDirectory(
      relisted(files, { "actions.jsonl": text([actions[0], long, actions[1], ""].join("\n")) }),
    );
    const problem = expectProblem(report, "limits.line_length", "actions.jsonl", 2);
    expect(problem.message).toBe("Longer than 65536 bytes (maxJsonlLineBytes)");
    expect(report.valid).toBe(false);
  });

  test("a line that isn't JSON, or fails its schema, is reported by line", async () => {
    const files = recording();
    const events = new TextDecoder().decode(files.get("events.jsonl"));
    const report = await asDirectory(
      relisted(files, {
        "events.jsonl": text(`${events}{"t":3,"kind":"nap","detail":null}\nnot json\n`),
      }),
    );
    expectProblem(report, "schema.invalid", "events.jsonl", 6);
    expectProblem(report, "json.invalid", "events.jsonl", 7);
  });

  test("a file over its size limit is not read", async () => {
    const report = await asDirectory(recording(), { limits: { maxJsonlBytes: 1000 } });
    expectProblem(report, "limits.file_size", "frames.jsonl");
  });

  test("a recording larger than maxRecordingBytes is reported", async () => {
    const report = await asTarFile(alone(recording()), { limits: { maxRecordingBytes: 2000 } });
    expectProblem(report, "limits.recording_size", null);
    const directory = await asDirectory(recording(), { limits: { maxRecordingBytes: 2000 } });
    expectProblem(directory, "limits.recording_size");
  });

  test("limits must be positive integers", async () => {
    await expect(asDirectory(recording(), { limits: { maxEntries: 0 } })).rejects.toThrow(
      TypeError,
    );
    await expect(asDirectory(recording(), { partBytes: 1.5 })).rejects.toThrow(TypeError);
  });
});

describe("export parts", () => {
  const PART_BYTES = 4096;

  function partsOf(set: ReplaySet = replaySet()) {
    return exportParts(setTar(set), PART_BYTES);
  }

  test("a set split into parts validates as its tar, without a joined file", async () => {
    const exported = partsOf();
    expect(exported.parts.parts.length).toBeGreaterThan(2);
    const report = await validateRecordingParts(writePartsDirectory(exported), {
      partBytes: PART_BYTES,
    });
    expectClean(report);
    expect(report.source).toBe("parts");
    expect(report.info.parts).toBe(exported.parts.parts.length);
    expect(report.info.mesh_inflated_bytes).toBeGreaterThan(0);
  });

  test("a part whose bytes changed fails its hash and the tar's", async () => {
    const exported = partsOf();
    const part = exported.files.get("0001.part") as Uint8Array;
    // A byte inside a member's padding, so the tar still reads: only the hashes can tell.
    const changed = part.slice();
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 0x20;
    exported.files.set("0001.part", changed);
    const report = await validateRecordingParts(writePartsDirectory(exported), {
      partBytes: PART_BYTES,
    });
    expect(report.valid).toBe(false);
    expectProblem(report, "parts.sha256_mismatch", "0001.part");
    expectProblem(report, "parts.tar_sha256_mismatch", "parts.json");
    expect(
      problems(report).filter((problem) => problem.code === "parts.sha256_mismatch"),
    ).toHaveLength(1);
  });

  test("a missing part stops the tar from being read", async () => {
    const exported = partsOf();
    exported.files.delete("0002.part");
    const report = await validateRecordingParts(writePartsDirectory(exported), {
      partBytes: PART_BYTES,
    });
    expectProblem(report, "parts.missing", "0002.part");
    expect(report.info.checks_skipped).toEqual(["The tar: a part is missing"]);
  });

  test("parts.json's names, sizes and recording_id", async () => {
    const exported = partsOf();
    const [first, second] = exported.parts.parts;
    if (first === undefined || second === undefined) throw new Error("too few parts");
    const document = {
      ...exported.parts,
      recording_id: OTHER_ID,
      tar_bytes: exported.parts.tar_bytes + 1,
      parts: [
        { ...first, bytes: first.bytes - 1 },
        { ...second, name: "0005.part" },
        ...exported.parts.parts.slice(2),
      ],
    };
    exported.files.set("0005.part", exported.files.get("0001.part") as Uint8Array);
    const report = await validateRecordingParts(
      writePartsDirectory({ parts: document, files: exported.files }),
      { partBytes: PART_BYTES },
    );
    expectProblem(report, "parts.names", "parts.json");
    expectProblem(report, "parts.part_size", "parts.json");
    expectProblem(report, "parts.tar_bytes", "parts.json");
    expectProblem(report, "parts.bytes_mismatch", "0000.part");
    expectProblem(report, "parts.recording_id_mismatch", "parts.json");
  });

  test("without a valid parts.json nothing is read", async () => {
    const exported = partsOf();
    const root = writePartsDirectory(exported);
    rmSync(join(root, "parts.json"));
    const missing = await validateRecordingParts(root, { partBytes: PART_BYTES });
    expect(codes(missing)).toEqual(["file.missing"]);
    const invalid = await validateRecordingParts(
      writePartsDirectory({ parts: { ...exported.parts, extra: 1 }, files: exported.files }),
      { partBytes: PART_BYTES },
    );
    expect(codes(invalid)).toEqual(["schema.invalid"]);
  });
});

describe("hostile input", () => {
  /**
   * Validates the recording's tar and returns the report and the time taken in milliseconds. The
   * bounds are loose (a test machine may be busy): they catch time that grows with the square of
   * the input, which takes minutes here.
   */
  async function timed(files: RecordingFiles) {
    const path = writeTemporaryFile("hostile.tar", setTar(alone(files)));
    const started = performance.now();
    const report = await validateRecording(path);
    return { report, ms: performance.now() - started };
  }

  test("a JSONL file of millions of bad lines stops being parsed after 100", async () => {
    const { report, ms } = await timed(
      relisted(recording(), { "imu.jsonl": text("\n".repeat(4_000_000)) }),
    );
    expect(report.omitted).toEqual([{ code: "json.invalid", file: "imu.jsonl", count: 80 }]);
    expect(report.info.checks_skipped).toContain(
      "imu.jsonl after line 100: 100 lines are invalid, so the rest is not parsed",
    );
    expect(ms).toBeLessThan(2000);
  });

  test("tens of thousands of index lines over one block are checked in linear time", async () => {
    const files = recording();
    const lines = new TextDecoder().decode(files.get("mesh/history.jsonl")).split("\n");
    const first = JSON.parse(lines[0] as string) as MeshHistoryLine;
    const many = Array.from({ length: 30_000 }, (_, i) => ({
      ...first,
      op: i === 0 ? "add" : "update",
      t: 2 + i / 100_000,
    }));
    const { report, ms } = await timed(relisted(files, { "mesh/history.jsonl": jsonl(many) }));
    expectProblem(report, "mesh.block_overlap", "mesh/history.jsonl");
    expect(ms).toBeLessThan(3000);
  });

  test("a deflate bomb is never inflated past the block's size", async () => {
    const bomb = deflateRawSync(new Uint8Array(32 * 1024 * 1024));
    const files = editLines<MeshHistoryLine>(
      relisted(recording(), { "mesh/history.bin": bomb }),
      "mesh/history.jsonl",
      (lines) => {
        lines.splice(0, lines.length, {
          ...(lines[0] as MeshHistoryLine),
          offset: 0,
          bytes: bomb.length,
          vertices: 1000,
          faces: 0,
        });
      },
    );
    const { report, ms } = await timed(files);
    expect(expectProblem(report, "mesh.block_invalid", "mesh/history.jsonl", 1).message).toContain(
      "longer than any DEFLATE stream of 12000 bytes",
    );
    expect(ms).toBeLessThan(2000);
    const tight = editLines<MeshHistoryLine>(files, "mesh/history.jsonl", (lines) => {
      const only = lines[0];
      if (only !== undefined) only.vertices = Math.ceil(bomb.length / 12);
    });
    const { report: inflated, ms: inflatedMs } = await timed(tight);
    expect(expectProblem(inflated, "mesh.block_invalid", "mesh/history.jsonl", 1).message).toMatch(
      /^The block inflates to more than \d+ bytes/,
    );
    expect(inflatedMs).toBeLessThan(2000);
  });

  test("messages never echo values from the recording", async () => {
    const report = await asDirectory(
      lean((spec) => {
        const frame = spec.frames[2];
        if (frame !== undefined) {
          frame.transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1234.5678, 1.4, -0.24, 1];
          frame.t = 2.2;
          (frame as unknown as Record<string, unknown>)["planted"] = 8765.4321;
        }
        const fix = spec.location?.[0];
        if (fix !== undefined) fix.t = 1.2345678;
        const event = spec.events[3];
        if (event !== undefined) event.detail = "secretdetail";
      }),
    );
    expectProblem(report, "schema.invalid", "frames.jsonl", 3);
    expectProblem(report, "window.outside", "location.jsonl", 1);
    expectProblem(report, "events.detail", "events.jsonl", 4);
    const json = JSON.stringify(report);
    for (const value of ["1234.5678", "8765.4321", "1.2345678", "secretdetail", "103.8553"]) {
      expect(json).not.toContain(value);
    }
  });

  test("the bundles' reports it carries never echo values either", async () => {
    const set = replaySet(undefined, (spec) => {
      spec.anchors[0].facing = [0, 0.1234567, -0.9876543];
    });
    const root = writeSetDirectory(set);
    const report = await validateRecording(root);
    expectProblem(report, "bundle.invalid", `${BUNDLE_DIR}/`);
    expect(report.bundles[0]?.report.errors.map((problem) => problem.code)).toContain(
      "anchors.facing",
    );
    const length = Math.hypot(0.1234567, -0.9876543);
    const outputs = [JSON.stringify(report), formatRecordingReport(report, "set")];
    for (const value of ["1234", "0.12", "9876", "0.98", length.toFixed(4), length.toFixed(3)]) {
      for (const output of outputs) expect(output, value).not.toContain(value);
    }
  });
});

describe("documentation", () => {
  test("README.md lists every problem code with its severity", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    for (const [code, info] of Object.entries(RECORDING_PROBLEM_CODES)) {
      expect(readme, code).toContain(`| \`${code}\` | ${info.severity} |`);
    }
  });
});
