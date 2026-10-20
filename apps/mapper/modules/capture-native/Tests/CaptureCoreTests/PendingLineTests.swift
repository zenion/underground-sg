#if USG_RECORDER
import Foundation
import Testing

@testable import CaptureCore

// The encoders from the typed samples to lines. Each golden test rebuilds a Golden/ file, which
// swift-goldens.test.ts validates against the schemas, from the samples the module would hand
// over, so the unit conversions, the shortest decimals and the explicit nulls are what the
// schemas accept.

private let goldenDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  .appendingPathComponent("Golden")

private func golden(_ file: String) throws -> String {
  let data = try Data(contentsOf: goldenDirectory.appendingPathComponent(file))
  return String(decoding: data, as: UTF8.self)
}

private func text(_ lines: [PendingLine]) throws -> String {
  let encoder = LineEncoder()
  return try lines.map { String(decoding: try $0.encode(encoder), as: UTF8.self) }.joined()
}

private func uuid(_ text: String) -> UUID { UUID(uuidString: text)! }

private let captureID = uuid("8f9585da-8554-4b8a-ba4e-0f390ccd3802")
private let meshAnchorID = uuid("0b4e2d8f-61a7-4c3e-9d25-7f1a8c6e3b90")
private let secondMeshAnchorID = uuid("5e8b2c41-0d7a-4b93-8f16-2a9c7d3e6b05")
private let keyframeAnchorID = uuid("c3a1e9d2-7b54-4f08-a6e1-93d2b8f04c17")

/// The lean walk along the Exit G passage that the goldens use.
private func walkPose(_ t: Double) -> WorldTransform {
  .yaw(0.0628, x: 0.4, y: 0.02, z: -1.2 * t)
}

/// m/s² as the g Core Motion would report.
private func g(_ x: Double, _ y: Double, _ z: Double) -> SIMD3<Double> {
  SIMD3(x, y, z) / standardGravity
}

private func frame(
  _ index: Int, t: Double, candidate: CandidateMark?, light: SIMD2<Float>?,
  tracking: TrackingCode = .normal, mapping: MappingCode = .extending,
  exposure: (Double, Float) = (0.0166, 0)
) -> FrameSample {
  FrameSample(
    frame: index, t: t, camera: walkPose(t), intrinsics: SIMD4(1445.2, 1445.2, 958.4, 721.9),
    tracking: tracking, mapping: mapping, exposureDurationS: exposure.0,
    exposureOffsetEV: exposure.1, light: light, fps: 60, candidate: candidate, gateMs: 0.02)
}

private func motion(t: Double, heading: Double) -> MotionSample {
  MotionSample(
    t: t, attitude: SIMD4(0.0123, -0.7012, 0.0087, 0.7128), gravityG: g(0.05, -9.79, -0.52),
    userAccelG: g(0.12, 0.31, -0.08), rotation: SIMD3(0.01, -0.03, 0.002),
    magneticField: SIMD3(12.4, -31.2, -18.9), magneticAccuracy: .medium, heading: heading)
}

private let MiB = 1_048_576.0

@Suite struct PendingLineGoldenTests {
  @Test func frameLines() throws {
    let lines: [PendingLine] = [
      .frame(
        frame(1203, t: 23.415, candidate: .dropped(.profile), light: SIMD2(840.5, 4210)), gap: 0),
      .frame(frame(1204, t: 23.432, candidate: nil, light: nil), gap: 0),
      .frame(
        frame(
          1206, t: 23.465, candidate: nil, light: nil, tracking: .limited(.excessiveMotion),
          mapping: .limited, exposure: (0.0083, -0.5)),
        gap: framesSkipped(previousT: 23.432, t: 23.465, fps: 60)),
    ]
    #expect(try text(lines) == golden("RecordingFrameLine.jsonl"))
    #expect(lines.allSatisfy { $0.file == .frames })
  }

  @Test func motionLines() throws {
    let second = MotionSample(
      t: 23.428, attitude: SIMD4(0.0124, -0.7011, 0.0088, 0.7129), gravityG: g(0.06, -9.79, -0.51),
      userAccelG: g(0.11, 0.3, -0.07), rotation: SIMD3(0.011, -0.029, 0.002),
      magneticField: SIMD3(0, 0, 0), magneticAccuracy: .uncalibrated, heading: -1)
    let lines: [PendingLine] = [
      .motion(motion(t: 23.418, heading: 41.5), frame: .xMagneticNorthZVertical),
      // Core Motion's negative heading means none.
      .motion(second, frame: .xMagneticNorthZVertical),
    ]
    #expect(try text(lines) == golden("MotionLine.jsonl"))
  }

  @Test func altitudeLines() throws {
    var rebaser = AltitudeRebaser()
    let lines = [
      rebaser.line(AltitudeSample(t: 3.4, relativeAltitudeM: 12.5, pressureKpa: 101.43)),
      rebaser.line(AltitudeSample(t: 23.5, relativeAltitudeM: 7.68, pressureKpa: 101.38)),
    ].compactMap { $0 }
    #expect(try text(lines) == golden("AltitudeLine.jsonl"))
  }

  @Test func anchorLines() throws {
    let meshPose = WorldTransform.yaw(-0.0314, x: 0.1, y: -1.4, z: -27.5)
    let lines: [PendingLine] = [
      .anchor(
        AnchorChange(
          t: 25, id: keyframeAnchorID, kind: .keyframe, op: .add, transform: walkPose(23.415),
          frame: 1203), final: false, captureID: nil),
      // A capture id on a line that isn't final is never written.
      .anchor(
        AnchorChange(
          t: 25, id: meshAnchorID, kind: .mesh, op: .update, transform: meshPose, frame: nil),
        final: false, captureID: captureID),
      .anchor(
        AnchorChange(t: 30, id: meshAnchorID, kind: .mesh, op: .remove, transform: nil, frame: nil),
        final: false, captureID: nil),
      .anchor(
        AnchorChange(
          t: 412.8, id: keyframeAnchorID, kind: .keyframe, op: .update,
          transform: walkPose(23.415), frame: 1203), final: true, captureID: captureID),
    ]
    #expect(try text(lines) == golden("AnchorHistoryLine.jsonl"))
  }

  @Test func eventLines() throws {
    let lines: [PendingLine] = [
      .event(.recordingOpened, t: 3.2), .event(.thermal(.fair), t: 140.1),
      .event(.degradation(.fewerCandidates), t: 140.1), .event(.relocalizationBegan, t: 210.4),
      .event(.sessionFailed(code: 102), t: 210.4), .event(.recordingClosed(.endAnchor), t: 412.8),
    ]
    #expect(try text(lines) == golden("RecordingEventLine.jsonl"))
  }

  @Test func actionLines() throws {
    let lines: [PendingLine] = [
      .action(
        .markAnchor, t: 3.2, args: #"[{"role":"start","kind":"floor_point"}]"#,
        result: #"{"frame":192,"hit":[0.31,-1.42,-0.9],"normal":[0,1,0]}"#, error: nil),
      .action(
        .addTag, t: 23.47, args: #"[{"type":"node","kind":"door","name":null}]"#, result: nil,
        error: "ERR_TRACKING_LIMITED"),
    ]
    #expect(try text(lines) == golden("ActionLine.jsonl"))
  }

  @Test func telemetryLines() throws {
    let idle: [Stage: StagePercentileValue] = [.gate: StagePercentileValue(p50: 0.02, p95: 0.05)]
    let lines: [PendingLine] = [
      .telemetry(
        TelemetrySample(
          t: 24, thermal: .nominal, memoryBytes: Int64((612.4 * MiB).rounded()), cpuPercent: 143.2,
          freeDiskBytes: Int64(182_340 * MiB), queue: 0, candidatesBlurred: 0,
          candidatesDropped: 0, stageMs: idle)),
      .telemetry(
        TelemetrySample(
          t: 140, thermal: .fair, memoryBytes: Int64(640 * MiB), cpuPercent: 151.8,
          freeDiskBytes: Int64(182_311.5 * MiB), queue: 2, candidatesBlurred: 0,
          candidatesDropped: 87, stageMs: idle)),
    ]
    #expect(try text(lines) == golden("TelemetryLine.jsonl"))
  }

  @Test func meshHistoryLines() throws {
    let lines: [PendingLine] = [
      PendingLine.meshBlock(
        t: 25, anchor: meshAnchorID, op: .add,
        transform: .yaw(-0.0314, x: 0.1, y: -1.4, z: -27.5), vertices: 3120, faces: 5840,
        final: false, captureID: nil
      ).placed(offset: 0, bytes: 48_211),
      .meshRemove(t: 30, anchor: meshAnchorID, final: false, captureID: nil),
      PendingLine.meshBlock(
        t: 412.8, anchor: secondMeshAnchorID, op: .add,
        transform: .yaw(0.02, x: 0.4, y: -1.4, z: -31.2), vertices: 3266, faces: 6012,
        final: true, captureID: captureID
      ).placed(offset: 48_211, bytes: 51_007),
    ]
    #expect(try text(lines) == golden("MeshHistoryLine.jsonl"))
  }

  @Test func imuAndLocation() throws {
    let imu: [PendingLine] = [
      .imu(ImuSample(t: 23.414, accelG: g(0.12, -9.71, -1.05), gyro: SIMD3(0.012, -0.034, 0.005))),
      .imu(ImuSample(t: 23.424, accelG: g(0.15, -9.69, -1.02), gyro: SIMD3(0.011, -0.031, 0.004))),
    ]
    #expect(try text(imu) == golden("ImuLine.jsonl"))
    // A fix in the street area at Esplanade MRT Exit F.
    let fix = GnssFix(t: 171.35, lat: 1.2934, lon: 103.8557, horizontalAccuracyM: 4.8)
    #expect(try text([.location(fix)]) == golden("GnssLine.jsonl"))
  }
}

@Suite struct PendingLineTests {
  let encoder = LineEncoder()

  private func line(_ pending: PendingLine) throws -> String {
    String(decoding: try pending.encode(encoder), as: UTF8.self)
  }

  @Test func theFilesAreTheLayoutsPaths() {
    #expect(
      RecordingFilePath.allCases.map(\.rawValue) == [
        "frames.jsonl", "imu.jsonl", "motion.jsonl", "altitude.jsonl", "anchors.jsonl",
        "events.jsonl", "actions.jsonl", "telemetry.jsonl", "location.jsonl", "boundary.jsonl",
        "mesh/history.jsonl", "mesh/history.bin",
      ])
  }

  @Test func headingIsNullInTheArbitraryFrames() throws {
    for frame in MotionFrame.allCases {
      let written = try line(.motion(motion(t: 1, heading: 41.5), frame: frame))
      #expect(written.contains(#""heading":null"#) == frame.isArbitrary)
    }
    let full = try line(.motion(motion(t: 1, heading: 360), frame: .xTrueNorthZVertical))
    #expect(full.contains(#""heading":0,"#))
    let none = try line(.motion(motion(t: 1, heading: .nan), frame: .xTrueNorthZVertical))
    #expect(none.contains(#""heading":null"#))
  }

  @Test func theAttitudeIsWrittenAsReported() throws {
    var sample = motion(t: 1, heading: 0)
    sample.attitude = SIMD4(0, 0, 0, 1.000_000_3)
    #expect(try line(.motion(sample, frame: .xArbitraryZVertical)).contains("[0,0,0,1.0000003]"))
  }

  @Test func trackingAndCandidatesUseTheFormatsText() {
    #expect(TrackingCode.normal.text == "normal")
    #expect(TrackingCode.notAvailable.text == "notAvailable")
    #expect(TrackingCode.limited(.insufficientFeatures).text == "limited:insufficientFeatures")
    #expect(CandidateMark.keyframe.text == "keyframe")
    for reason in DropReason.allCases {
      #expect(CandidateStatus(rawValue: CandidateMark.dropped(reason).text) != nil)
    }
    for mapping in MappingCode.allCases {
      #expect(WorldMappingStatus(rawValue: mapping.rawValue) != nil)
    }
    for frame in MotionFrame.allCases {
      #expect(MotionReferenceFrame(rawValue: frame.rawValue) != nil)
    }
  }

  @Test func anInvalidErrorCodeIsNeverWrittenAsGiven() throws {
    let written = try line(
      .action(.stop, t: 2, args: "[]", result: nil, error: "failed at 1.2934, 103.8557"))
    #expect(written.contains(#""error":"ERR_INVALID_CODE""#))
    #expect(!written.contains("1.2934"))
  }

  @Test func jsonTextOverItsBoundIsReplacedByTheMarker() throws {
    let args = "\"" + String(repeating: "a", count: JsonText.maxCodePoints) + "\""
    let written = try line(.action(.addTag, t: 2, args: args, result: "null", error: nil))
    #expect(written.contains(#""args":"{\"omitted\":\"too_large\",\"bytes\":16386}""#))
    #expect(written.contains(#""result":"null""#))
  }

  @Test func aLineOverTheLimitGivesUpItsLongerJsonTextFirst() throws {
    // Each text fits its own bound in code points, but 4 bytes each takes the line past 64 KiB.
    let emoji = "\u{1F687}"
    let long = "\"" + String(repeating: emoji, count: 10_000) + "\""
    let shorter = "\"" + String(repeating: emoji, count: 8000) + "\""
    let written = try line(.action(.markAnchor, t: 2, args: long, result: shorter, error: nil))
    #expect(written.contains(#""args":"{\"omitted\":\"too_large\",\"bytes\":40002}""#))
    #expect(written.contains(shorter.dropFirst().dropLast()))

    let longest = "\"" + String(repeating: emoji, count: JsonText.maxCodePoints - 2) + "\""
    let both = try line(.action(.markAnchor, t: 2, args: longest, result: longest, error: nil))
    #expect(both.contains(#""args":"{\"omitted\":\"too_large\",\"bytes\":65530}""#))
    #expect(both.contains(#""result":"{\"omitted\":\"too_large\",\"bytes\":65530}""#))
  }

  @Test func aMeshBlockMustBePlacedBeforeItIsEncoded() throws {
    let unplaced = PendingLine.meshBlock(
      t: 25, anchor: meshAnchorID, op: .update, transform: .identity, vertices: 3, faces: 1,
      final: false, captureID: nil)
    #expect(throws: PendingLineError.unplacedMeshBlock) { try unplaced.encode(encoder) }
    #expect(try line(unplaced.placed(offset: 1 << 33, bytes: 9)).contains(#""offset":8589934592"#))
    // Placing a remove, or a line that isn't the mesh history's, changes nothing.
    let remove = PendingLine.meshRemove(t: 30, anchor: meshAnchorID, final: true, captureID: nil)
    #expect(try line(remove.placed(offset: 4, bytes: 9)) == line(remove))
    let event = PendingLine.event(.screenshot, t: 3)
    #expect(try line(event.placed(offset: 4, bytes: 9)) == line(event))
  }

  @Test func aBoundaryLineIsWrittenAsItCame() throws {
    var window = RecorderWindow()
    window.markAnchor(t: 3.2, role: .start)
    let raw = #"{"binary":null,"kind":"status","seq":0,"t":3.25,"value":"{\"fps\":60}"}"#
    let checked = try BoundaryLineCheck.check(raw, window: window, lastSeq: nil).get()
    let pending = PendingLine.boundary(checked)
    #expect(pending.file == .boundary)
    #expect(pending.t == 3.25)
    #expect(try line(pending) == raw + "\n")
  }

  @Test func aNonFiniteValueIsRefused() {
    let sample = TelemetrySample(
      t: 1, thermal: .nominal, memoryBytes: 0, cpuPercent: .nan, freeDiskBytes: 0, queue: 0,
      candidatesBlurred: 0, candidatesDropped: 0, stageMs: [:])
    #expect(throws: LineEncodingError.nonFinite) {
      try PendingLine.telemetry(sample).encode(encoder)
    }
  }
}
#endif
