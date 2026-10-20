import Foundation
import Testing

@testable import CaptureCore

private func text(_ data: Data) -> String {
  String(decoding: data, as: UTF8.self)
}

/// Significant digits in a number's text: "0.0012", "-1.25e-07" and "120.0" have 2, 3 and 2.
private func significantDigits(_ text: String) -> Int {
  let mantissa = text.split(separator: "e")[0].filter(\.isNumber)
  return mantissa.drop { $0 == "0" }.reversed().drop { $0 == "0" }.count
}

@Suite struct LineEncoderTests {
  let encoder = LineEncoder()

  @Test func sortsKeysAndEndsWithANewline() throws {
    let line = try encoder.line(RecordingEventLine(detail: "fair", kind: .thermal, t: 140.1))
    #expect(text(line) == #"{"detail":"fair","kind":"thermal","t":140.1}"# + "\n")
  }

  @Test func leavesSlashesUnescaped() throws {
    let file = RecordingFile(
      bytes: 1024, path: "mesh/history.bin", sha256: String(repeating: "a", count: 64))
    let line = try encoder.line(file)
    #expect(text(line).contains(#""path":"mesh/history.bin""#))
  }

  @Test func writesNilRequiredFieldsAsNull() throws {
    // window.end_t and window.ended are required, and null while the recording is open.
    let window = RecordingWindow(endT: nil, ended: nil, startT: 3.2, trimmed: false)
    #expect(
      text(try encoder.line(window))
        == #"{"end_t":null,"ended":null,"start_t":3.2,"trimmed":false}"# + "\n")
  }

  @Test func leavesOutNilOptionalFields() throws {
    // A stage that didn't run is left out of ms.
    let ms = StageTimings(
      blur: nil, copy: nil, depth: nil, detect: nil, encode: nil, gate: 0.02, sharpness: nil,
      write: nil)
    #expect(text(try encoder.line(ms)) == #"{"gate":0.02}"# + "\n")
  }

  @Test func writesADocumentOnOneLine() throws {
    let parts = ExportParts(
      parts: [
        ExportPart(bytes: 1_048_576, name: "0000.part", sha256: String(repeating: "b", count: 64))
      ],
      recordingID: "5d0c6f1e-3b7a-4f7e-9c51-2a8e4b6d1f03", recordingVersion: 1,
      tarBytes: 1_048_576, tarSha256: String(repeating: "b", count: 64))
    let document = text(try encoder.document(parts))
    #expect(document.hasSuffix("}\n"))
    #expect(document.filter { $0 == "\n" }.count == 1)
  }

  @Test func refusesNonFiniteNumbers() {
    #expect(throws: LineEncodingError.nonFinite) {
      try encoder.line(AltitudeLine(pressureKpa: .nan, relativeM: 0, t: 1))
    }
    #expect(throws: LineEncodingError.nonFinite) {
      try encoder.line(AltitudeLine(pressureKpa: 101.38, relativeM: -.infinity, t: 1))
    }
    #expect(throws: LineEncodingError.nonFinite) {
      try encoder.line(ImuLine(accel: [0, Double(shortest: Float.nan), 0], gyro: [0, 0, 0], t: 1))
    }
  }

  @Test func refusesALineOverTheLimit() throws {
    func action(_ argsLength: Int) -> ActionLine {
      ActionLine(
        args: String(repeating: "a", count: argsLength), call: "addTag", error: nil, result: nil,
        t: 1)
    }
    // Everything but the args text, newline excluded.
    let overhead = try encoder.line(action(0)).count - 1
    let fits = LineEncoder.maxLineBytes - overhead
    #expect(try encoder.line(action(fits)).count == LineEncoder.maxLineBytes + 1)
    #expect(throws: LineEncodingError.tooLong(bytes: LineEncoder.maxLineBytes + 1)) {
      try encoder.line(action(fits + 1))
    }
  }

  @Test func shortestDoubleRoundTripsAndPrintsShort() throws {
    let named: [Float] = [
      0, -0.0, 1, -1, 0.1, -0.5, 0.866025, 0.99802673, -9.80665, 1445.2, 123456.79, 16_777_216,
      1e-7, -3.5e-12, 4.2e30, Float.leastNonzeroMagnitude, -Float.leastNonzeroMagnitude,
      Float.leastNormalMagnitude, Float.greatestFiniteMagnitude, -Float.greatestFiniteMagnitude,
      Float.ulpOfOne,
    ]
    // And a sweep across every exponent, both signs, by stepping through the bit patterns.
    let swept = stride(from: UInt32(0), to: 0x7F80_0000, by: 0x0001_9A3B).flatMap {
      [Float(bitPattern: $0), -Float(bitPattern: $0)]
    }
    for value in named + swept {
      let widened = Double(shortest: value)
      #expect(Float(widened) == value)
      // A float32 needs at most 9 significant digits; the plain widening often needs 17.
      #expect(significantDigits(widened.description) <= 9)
    }
    #expect(swept.count > 10_000)
    #expect(Double(shortest: 0.866025 as Float).description == "0.866025")
    #expect(Double(0.866025 as Float).description == "0.8660249710083008")
    #expect(Double(shortest: 1445.2 as Float) == 1445.2)
    let line = try encoder.line(RefinedKeyframeLine(frame: 1, transform: [0.866025, -0.5].map {
      Double(shortest: $0 as Float)
    }))
    #expect(text(line) == #"{"frame":1,"transform":[0.866025,-0.5]}"# + "\n")
  }

  @Test func shortestDoubleFallsBackWhenTheShortTextRoundsTwice() {
    // 7.038531e-26 is this float's shortest text, but text to Double to Float rounds twice and
    // lands one ulp off, though the text read straight as a Float is exact. An exhaustive sweep
    // of the positive floats found only this one; the exact widening is longer but loses nothing.
    for value in [Float(bitPattern: 0x15AE_43FD), Float(bitPattern: 0x95AE_43FD)] {
      #expect(Float(value.description) == value)
      #expect(Float(Double(value.description)!) != value)
      #expect(Float(Double(shortest: value)) == value)
      #expect(Double(shortest: value) == Double(value))
    }
  }

  @Test func shortestDoubleKeepsNonFiniteValues() {
    #expect(Double(shortest: Float.nan).isNaN)
    #expect(Double(shortest: Float.infinity) == .infinity)
    #expect(Double(shortest: -Float.infinity) == -.infinity)
  }
}

// MARK: - Golden files

/// Byte-exact files the encoder must reproduce, which packages/contracts/test/swift-goldens.test.ts
/// validates against the JSON Schemas: together they prove that what Swift writes, the schemas
/// accept. With UPDATE_GOLDENS=1 the tests write the files instead of comparing them.
private let goldenDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  .appendingPathComponent("Golden")
private let updatingGoldens = ProcessInfo.processInfo.environment["UPDATE_GOLDENS"] == "1"

private func checkGolden(_ file: String, _ data: Data) throws {
  let url = goldenDirectory.appendingPathComponent(file)
  if updatingGoldens {
    try FileManager.default.createDirectory(at: goldenDirectory, withIntermediateDirectories: true)
    try data.write(to: url)
    return
  }
  let expected = try Data(contentsOf: url)
  guard data != expected else { return }
  let got = data.split(separator: 0x0A, omittingEmptySubsequences: false)
  let want = expected.split(separator: 0x0A, omittingEmptySubsequences: false)
  let firstDifference = zip(got, want).enumerated().first { $0.element.0 != $0.element.1 }
  let line = (firstDifference?.offset ?? min(got.count, want.count)) + 1
  Issue.record(
    "Golden/\(file) differs at line \(line); rerun with UPDATE_GOLDENS=1 if the change is meant")
}

/// The module writes ARKit's float32 matrices through Double(shortest:).
private func written(_ transform: WorldTransform) -> [Double] {
  transform.m.map { Double(shortest: $0) }
}

private func written(_ values: [Float]) -> [Double] {
  values.map { Double(shortest: $0) }
}

/// A lean walk along the Exit G passage at 1.2 m/s, yawed slightly: synthetic, in the session
/// frame, so no venue recording is needed.
private func walkPose(_ t: Double) -> [Double] {
  written(.yaw(0.0628, x: 0.4, y: 0.02, z: -1.2 * t))
}

private let recordingID = "5d0c6f1e-3b7a-4f7e-9c51-2a8e4b6d1f03"
private let captureID = "8f9585da-8554-4b8a-ba4e-0f390ccd3802"
private let meshAnchorID = "0b4e2d8f-61a7-4c3e-9d25-7f1a8c6e3b90"
private let secondMeshAnchorID = "5e8b2c41-0d7a-4b93-8f16-2a9c7d3e6b05"
private let keyframeAnchorID = "c3a1e9d2-7b54-4f08-a6e1-93d2b8f04c17"
private let digest = "3f2a9c4e8b1d7f6a0c5e2b9d4a7f1c8e6b3d0a9f5c2e7b4d1a8f6c3e0b9d2a7f"
private let intrinsics = written([1445.2, 1445.2, 958.4, 721.9])
private let gateOnly = StageTimings(
  blur: nil, copy: nil, depth: nil, detect: nil, encode: nil, gate: 0.02, sharpness: nil,
  write: nil)

private let closedRecording = RecordingManifest(
  arkit: ArkitConfiguration(
    frameSemantics: [.smoothedSceneDepth], sceneReconstruction: .meshWithClassification,
    videoFormat: ArVideoFormat(fps: 60, height: 1440, width: 1920), worldAlignment: .gravity),
  build: RecordingBuild(
    appVersion: "0.1.0", easBuildID: nil, gitCommit: "e191db7c0a4b5d6e7f8091a2b3c4d5e6f7081920",
    profile: .synthetic),
  clocks: RecordingClocks(
    mediaTimeS: 81234.5, systemUptimeS: 81234.5, wallClock: "2026-10-20T08:15:02.104+08:00"),
  closed: true,
  detectorVersions: nil,
  deviceModel: "iPhone18,2",
  files: [
    "actions.jsonl", "altitude.jsonl", "anchors.jsonl", "events.jsonl", "frames.jsonl",
    "imu.jsonl", "location.jsonl", "mesh/history.bin", "mesh/history.jsonl", "motion.jsonl",
    "telemetry.jsonl",
  ].map { RecordingFile(bytes: 1024, path: $0, sha256: digest) },
  motion: MotionConfiguration(referenceFrame: .xArbitraryCorrectedZVertical),
  origin: .synthetic,
  osVersion: "iOS 26.7",
  profile: .lean,
  rates: RecordingRates(
    candidatesHz: 4.1, framesHz: 59.6, imuHz: 99.8, meshIntervalS: 5.02, motionHz: 99.8),
  recordingID: recordingID,
  recordingVersion: 1,
  segments: [
    RecordingSegment(
      captureID: captureID, endT: 211.4, frameOffset: 0, kept: true, manifestSha256: digest,
      startT: 3.2)
  ],
  sessionStartedAt: "2026-10-20T08:15:02+08:00",
  venues: ["36632586-e1fa-4e10-800a-81acf0eab09a", "dabbc03c-39d9-4947-8dbc-b2aa0c42e5d2"],
  window: RecordingWindow(endT: 412.8, ended: .endAnchor, startT: 3.2, trimmed: false))

/// recording.json as first written, when the recording opens.
private let openRecording = RecordingManifest(
  arkit: closedRecording.arkit, build: closedRecording.build, clocks: closedRecording.clocks,
  closed: false, detectorVersions: nil, deviceModel: closedRecording.deviceModel, files: [],
  motion: nil, origin: .synthetic, osVersion: closedRecording.osVersion, profile: .lean, rates: nil,
  recordingID: recordingID, recordingVersion: 1,
  segments: [
    RecordingSegment(
      captureID: captureID, endT: nil, frameOffset: 0, kept: true, manifestSha256: nil,
      startT: 3.2)
  ],
  sessionStartedAt: closedRecording.sessionStartedAt, venues: closedRecording.venues,
  window: RecordingWindow(endT: nil, ended: nil, startT: 3.2, trimmed: false))

@Suite struct GoldenTests {
  let encoder = LineEncoder()

  private func lines<T: Encodable>(_ values: [T]) throws -> Data {
    var data = Data()
    for value in values { data.append(try encoder.line(value)) }
    return data
  }

  @Test func recordingManifest() throws {
    try checkGolden("RecordingManifest.json", try encoder.document(closedRecording))
    // The open form is written the same way; its nulls are checked here, not in a golden.
    let open = text(try encoder.document(openRecording))
    #expect(open.contains(#""rates":null"#))
    #expect(open.contains(#""window":{"end_t":null,"ended":null,"start_t":3.2,"trimmed":false}"#))
    #expect(open.contains(#""detector_versions":null"#))
  }

  @Test func frameLines() throws {
    let exposure = FrameExposure(durationS: 0.0166, offsetEv: 0)
    try checkGolden(
      "RecordingFrameLine.jsonl",
      try lines([
        // A candidate the lean profile doesn't keep.
        RecordingFrameLine(
          candidate: .droppedProfile, exposure: exposure, frame: 1203, gap: 0,
          intrinsics: intrinsics,
          light: LightEstimate(intensityLM: 840.5, temperatureK: 4210), mapping: .extending,
          ms: gateOnly, sharpness: nil, t: 23.415, tracking: "normal",
          transform: walkPose(23.415)),
        // Not a candidate, and no light estimate.
        RecordingFrameLine(
          candidate: nil, exposure: exposure, frame: 1204, gap: 0, intrinsics: intrinsics,
          light: nil, mapping: .extending, ms: gateOnly, sharpness: nil, t: 23.432,
          tracking: "normal", transform: walkPose(23.432)),
        // Tracking limited after a skipped frame.
        RecordingFrameLine(
          candidate: nil, exposure: FrameExposure(durationS: 0.0083, offsetEv: -0.5), frame: 1206,
          gap: 1, intrinsics: intrinsics, light: nil, mapping: .limited, ms: gateOnly,
          sharpness: nil, t: 23.465, tracking: "limited:excessiveMotion",
          transform: walkPose(23.465)),
      ]))
  }

  @Test func motionLines() throws {
    let field = MagneticField(accuracy: .medium, field: [12.4, -31.2, -18.9])
    try checkGolden(
      "MotionLine.jsonl",
      try lines([
        MotionLine(
          attitude: [0.0123, -0.7012, 0.0087, 0.7128], gravity: [0.05, -9.79, -0.52],
          heading: 41.5, magnetic: field, rotation: [0.01, -0.03, 0.002], t: 23.418,
          userAccel: [0.12, 0.31, -0.08]),
        MotionLine(
          attitude: [0.0124, -0.7011, 0.0088, 0.7129], gravity: [0.06, -9.79, -0.51],
          heading: nil, magnetic: MagneticField(accuracy: .uncalibrated, field: [0, 0, 0]),
          rotation: [0.011, -0.029, 0.002], t: 23.428, userAccel: [0.11, 0.3, -0.07]),
      ]))
  }

  @Test func altitudeLines() throws {
    try checkGolden(
      "AltitudeLine.jsonl",
      try lines([
        AltitudeLine(pressureKpa: 101.43, relativeM: 0, t: 3.4),
        AltitudeLine(pressureKpa: 101.38, relativeM: -4.82, t: 23.5),
      ]))
  }

  @Test func anchorHistoryLines() throws {
    try checkGolden(
      "AnchorHistoryLine.jsonl",
      try lines([
        AnchorHistoryLine(
          anchor: keyframeAnchorID, captureID: nil, anchorHistoryLineFinal: false, frame: 1203,
          kind: .keyframe, op: .add, t: 25, transform: walkPose(23.415)),
        AnchorHistoryLine(
          anchor: meshAnchorID, captureID: nil, anchorHistoryLineFinal: false, frame: nil,
          kind: .mesh, op: .update, t: 25,
          transform: written(.yaw(-0.0314, x: 0.1, y: -1.4, z: -27.5))),
        AnchorHistoryLine(
          anchor: meshAnchorID, captureID: nil, anchorHistoryLineFinal: false, frame: nil,
          kind: .mesh, op: .remove, t: 30, transform: nil),
        // The final sample at window.end_t, for the segment open then.
        AnchorHistoryLine(
          anchor: keyframeAnchorID, captureID: captureID, anchorHistoryLineFinal: true,
          frame: 1203, kind: .keyframe, op: .update, t: 412.8, transform: walkPose(23.415)),
      ]))
  }

  @Test func eventLines() throws {
    try checkGolden(
      "RecordingEventLine.jsonl",
      try lines([
        RecordingEventLine(detail: nil, kind: .recordingOpened, t: 3.2),
        RecordingEventLine(detail: "fair", kind: .thermal, t: 140.1),
        RecordingEventLine(detail: "fewer_candidates", kind: .degradation, t: 140.1),
        RecordingEventLine(detail: nil, kind: .relocalizationBegan, t: 210.4),
        RecordingEventLine(detail: "102", kind: .sessionFailed, t: 210.4),
        RecordingEventLine(detail: "end_anchor", kind: .recordingClosed, t: 412.8),
      ]))
  }

  @Test func actionLines() throws {
    try checkGolden(
      "ActionLine.jsonl",
      try lines([
        ActionLine(
          args: #"[{"role":"start","kind":"floor_point"}]"#, call: "markAnchor", error: nil,
          result: #"{"frame":192,"hit":[0.31,-1.42,-0.9],"normal":[0,1,0]}"#, t: 3.2),
        ActionLine(
          args: #"[{"type":"node","kind":"door","name":null}]"#, call: "addTag",
          error: "ERR_TRACKING_LIMITED", result: nil, t: 23.47),
      ]))
  }

  @Test func telemetryLines() throws {
    let idle = StagePercentiles(
      blur: nil, copy: nil, depth: nil, detect: nil, encode: nil,
      gate: StagePercentile(p50: 0.02, p95: 0.05), sharpness: nil, write: nil)
    try checkGolden(
      "TelemetryLine.jsonl",
      try lines([
        TelemetryLine(
          candidatesBlurred: 0, candidatesDropped: 0, cpu: 143.2, freeDiskMB: 182_340,
          memoryMB: 612.4, queue: 0, stageMS: idle, t: 24, thermal: .nominal),
        TelemetryLine(
          candidatesBlurred: 0, candidatesDropped: 87, cpu: 151.8, freeDiskMB: 182_311.5,
          memoryMB: 640, queue: 2, stageMS: idle, t: 140, thermal: .fair),
      ]))
  }

  @Test func meshHistoryLines() throws {
    try checkGolden(
      "MeshHistoryLine.jsonl",
      try lines([
        MeshHistoryLine(
          anchor: meshAnchorID, bytes: 48_211, captureID: nil, faces: 5840,
          meshHistoryLineFinal: false, offset: 0, op: .add, t: 25,
          transform: written(.yaw(-0.0314, x: 0.1, y: -1.4, z: -27.5)), vertices: 3120),
        MeshHistoryLine(
          anchor: meshAnchorID, bytes: nil, captureID: nil, faces: nil,
          meshHistoryLineFinal: false, offset: nil, op: .remove, t: 30, transform: nil,
          vertices: nil),
        // The final snapshot at window.end_t, for the segment open then.
        MeshHistoryLine(
          anchor: secondMeshAnchorID, bytes: 51_007, captureID: captureID, faces: 6012,
          meshHistoryLineFinal: true, offset: 48_211, op: .add, t: 412.8,
          transform: written(.yaw(0.02, x: 0.4, y: -1.4, z: -31.2)), vertices: 3266),
      ]))
  }

  @Test func exportParts() throws {
    let parts = ExportParts(
      parts: [
        ExportPart(bytes: 16_777_216, name: "0000.part", sha256: digest),
        ExportPart(bytes: 1_048_576, name: "0001.part", sha256: digest),
      ],
      recordingID: recordingID, recordingVersion: 1, tarBytes: 17_825_792, tarSha256: digest)
    try checkGolden("ExportParts.json", try encoder.document(parts))
  }

  @Test func bundleLines() throws {
    try checkGolden(
      "ImuLine.jsonl",
      try lines([
        ImuLine(accel: [0.12, -9.71, -1.05], gyro: [0.012, -0.034, 0.005], t: 23.414),
        ImuLine(accel: [0.15, -9.69, -1.02], gyro: [0.011, -0.031, 0.004], t: 23.424),
      ]))
    // A fix in the street area at Esplanade MRT Exit F.
    try checkGolden(
      "GnssLine.jsonl",
      try lines([GnssLine(hAccuracyM: 4.8, lat: 1.2934, lon: 103.8557, t: 171.35)]))
    try checkGolden(
      "PoseLine.jsonl",
      try lines([
        PoseLine(
          frame: 0, intrinsics: intrinsics, keyframe: true, t: 3.2, tracking: "normal",
          transform: walkPose(3.2)),
        PoseLine(
          frame: 1, intrinsics: intrinsics, keyframe: false, t: 3.217,
          tracking: "limited:initializing", transform: walkPose(3.217)),
      ]))
    try checkGolden(
      "BlurLine.jsonl",
      try lines([
        BlurLine(boxes: [], frame: 0),
        BlurLine(
          boxes: [
            BlurBox(h: 112, kind: .face, w: 96, x: 1204, y: 388),
            BlurBox(h: 150, kind: .personHead, w: 132, x: 1188, y: 352),
            BlurBox(h: 104, kind: .screen, w: 180, x: 402, y: 905),
          ], frame: 58),
      ]))
  }
}
