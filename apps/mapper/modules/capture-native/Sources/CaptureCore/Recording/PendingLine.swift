#if USG_RECORDER
import Foundation

/// The files of a recording the recorder appends to, by their paths in `rec-<recording_id>/`
/// (docs/session-recording.md, "Layout"). Not `RecordingFile`: the generated type of a
/// recording.json `files` entry has that name.
public enum RecordingFilePath: String, CaseIterable, Sendable {
  case frames = "frames.jsonl"
  case imu = "imu.jsonl"
  case motion = "motion.jsonl"
  case altitude = "altitude.jsonl"
  case anchors = "anchors.jsonl"
  case events = "events.jsonl"
  case actions = "actions.jsonl"
  case telemetry = "telemetry.jsonl"
  case location = "location.jsonl"
  case boundary = "boundary.jsonl"
  case meshIndex = "mesh/history.jsonl"
  /// The mesh blocks. No line goes here: a `meshIndex` line points into it.
  case meshBin = "mesh/history.bin"
}

/// Why a pending line could not be encoded. No case carries a value from the data.
public enum PendingLineError: Error, Equatable, Sendable {
  /// A mesh-history add or update whose block has no place in history.bin yet.
  case unplacedMeshBlock
}

/// One line on its way to a file (design D9): made on the capture queue from the typed samples,
/// encoded on the I/O queue. It holds the generated Codable value, so what is written is what
/// the schemas describe, and `t` for the writer's watermark and cut-back.
public struct PendingLine: Sendable {
  public let file: RecordingFilePath
  /// The line's session time.
  public let t: Double
  let payload: Payload

  enum Payload: Sendable {
    case frame(RecordingFrameLine)
    case imu(ImuLine)
    case motion(MotionLine)
    case altitude(AltitudeLine)
    case anchor(AnchorHistoryLine)
    case event(RecordingEventLine)
    case action(ActionLine)
    case telemetry(TelemetryLine)
    case location(GnssLine)
    case meshHistory(MeshHistoryLine)
    /// A line already checked and encoded, with its newline: boundary.jsonl's.
    case encoded(Data)
  }

  private init(_ file: RecordingFilePath, t: Double, _ payload: Payload) {
    self.file = file
    self.t = t
    self.payload = payload
  }

  /// The line's bytes, ending in a newline. Numbers that are NaN or infinite throw, and so does
  /// a line over 64 KiB, except an action line, whose JSON text is replaced by the too-large
  /// marker until the line fits (docs/session-recording.md, "JSON text").
  public func encode(_ encoder: LineEncoder) throws -> Data {
    switch payload {
    case .frame(let line): return try encoder.line(line)
    case .imu(let line): return try encoder.line(line)
    case .motion(let line): return try encoder.line(line)
    case .altitude(let line): return try encoder.line(line)
    case .anchor(let line): return try encoder.line(line)
    case .event(let line): return try encoder.line(line)
    case .action(let line): return try encodeAction(line, encoder)
    case .telemetry(let line): return try encoder.line(line)
    case .location(let line): return try encoder.line(line)
    case .meshHistory(let line):
      if line.op != .remove && (line.offset == nil || line.bytes == nil) {
        throw PendingLineError.unplacedMeshBlock
      }
      return try encoder.line(line)
    case .encoded(let data): return data
    }
  }

  /// Each JSON text is within its own bound already, but escaping can still take the line past
  /// 64 KiB. Then the longer of `result` and `args` gives way to the marker, and if that isn't
  /// enough, the other one too.
  private func encodeAction(_ line: ActionLine, _ encoder: LineEncoder) throws -> Data {
    do {
      return try encoder.line(line)
    } catch LineEncodingError.tooLong {}
    let resultFirst = (line.result?.utf8.count ?? 0) >= line.args.utf8.count
    let oneReplaced = resultFirst ? line.replacingResult() : line.replacingArgs()
    do {
      return try encoder.line(oneReplaced)
    } catch LineEncodingError.tooLong {}
    let bothReplaced = resultFirst ? oneReplaced.replacingArgs() : oneReplaced.replacingResult()
    return try encoder.line(bothReplaced)
  }

  /// A frames.jsonl line whose frame is a candidate, for recording.json's `candidates_hz`.
  public var isCandidateFrame: Bool {
    if case .frame(let line) = payload { return line.candidate != nil }
    return false
  }

  /// A mesh-history add or update with its block's place in history.bin, once the writer knows
  /// it. Other lines come back unchanged.
  public func placed(offset: Int64, bytes: Int) -> PendingLine {
    guard case .meshHistory(let line) = payload, line.op != .remove else { return self }
    return PendingLine(
      file, t: t,
      .meshHistory(
        MeshHistoryLine(
          anchor: line.anchor, bytes: bytes, captureID: line.captureID, faces: line.faces,
          meshHistoryLineFinal: line.meshHistoryLineFinal, offset: Int(offset), op: line.op,
          t: line.t, transform: line.transform, vertices: line.vertices)))
  }
}

// MARK: - Encoders, one per line type

/// 1 g in m/s², as the format converts it.
let standardGravity = 9.80665

extension PendingLine {
  /// frames.jsonl. `gap` is `framesSkipped` from the previous line written (0 for the first).
  static func frame(_ s: FrameSample, gap: Int) -> PendingLine {
    let light = s.light.map {
      LightEstimate(intensityLM: Double(shortest: $0.x), temperatureK: Double(shortest: $0.y))
    }
    let line = RecordingFrameLine(
      candidate: s.candidate.flatMap { CandidateStatus(rawValue: $0.text) },
      exposure: FrameExposure(
        durationS: s.exposureDurationS, offsetEv: Double(shortest: s.exposureOffsetEV)),
      frame: s.frame, gap: gap,
      intrinsics: [s.intrinsics.x, s.intrinsics.y, s.intrinsics.z, s.intrinsics.w].map {
        Double(shortest: $0)
      },
      light: light, mapping: WorldMappingStatus(rawValue: s.mapping.rawValue) ?? .notAvailable,
      ms: StageTimings(
        blur: nil, copy: nil, depth: nil, detect: nil, encode: nil, gate: micro(s.gateMs),
        sharpness: nil, write: nil),
      sharpness: nil, t: s.t, tracking: s.tracking.text, transform: written(s.camera))
    return PendingLine(.frames, t: s.t, .frame(line))
  }

  /// imu.jsonl: the bundle's line, acceleration converted from g.
  static func imu(_ s: ImuSample) -> PendingLine {
    PendingLine(
      .imu, t: s.t, .imu(ImuLine(accel: metresPerSecond(s.accelG), gyro: array(s.gyro), t: s.t)))
  }

  /// motion.jsonl. The heading is null in the arbitrary frames and when Core Motion gives none.
  static func motion(_ s: MotionSample, frame: MotionFrame) -> PendingLine {
    var heading: Double? = nil
    if !frame.isArbitrary, s.heading.isFinite, s.heading >= 0 {
      heading = s.heading < 360 ? s.heading : s.heading.truncatingRemainder(dividingBy: 360)
    }
    let line = MotionLine(
      attitude: [s.attitude.x, s.attitude.y, s.attitude.z, s.attitude.w],
      gravity: metresPerSecond(s.gravityG), heading: heading,
      magnetic: MagneticField(
        accuracy: MagneticAccuracy(rawValue: s.magneticAccuracy.rawValue) ?? .uncalibrated,
        field: array(s.magneticField)),
      rotation: array(s.rotation), t: s.t, userAccel: metresPerSecond(s.userAccelG))
    return PendingLine(.motion, t: s.t, .motion(line))
  }

  /// altitude.jsonl, from AltitudeRebaser.
  static func altitude(t: Double, relativeM: Double, pressureKpa: Double) -> PendingLine {
    PendingLine(
      .altitude, t: t,
      .altitude(AltitudeLine(pressureKpa: pressureKpa, relativeM: relativeM, t: t)))
  }

  /// anchors.jsonl. `captureID` is written only on a final line, as the format wants.
  static func anchor(_ c: AnchorChange, final: Bool, captureID: UUID?) -> PendingLine {
    let line = AnchorHistoryLine(
      anchor: c.id.uuidString.lowercased(),
      captureID: final ? captureID.map { $0.uuidString.lowercased() } : nil,
      anchorHistoryLineFinal: final, frame: c.frame,
      kind: AnchorHistoryKind(rawValue: c.kind.rawValue) ?? .mesh,
      op: HistoryOp(rawValue: c.op.rawValue) ?? .update, t: c.t,
      transform: c.transform.map(written))
    return PendingLine(.anchors, t: c.t, .anchor(line))
  }

  /// events.jsonl.
  static func event(_ e: RecordingEvent, t: Double) -> PendingLine {
    PendingLine(.events, t: t, .event(e.line(t: t)))
  }

  /// actions.jsonl. `args` and `result` are JSON text, bounded here; `error` is the call's error
  /// code. A code the format can't hold is written as `ERR_INVALID_CODE`, never as given.
  static func action(
    _ call: SessionCall, t: Double, args: String, result: String?, error: String?
  ) -> PendingLine {
    let line = ActionLine(
      args: JsonText.bounded(args), call: call.rawValue,
      error: error.map { isErrorCode($0) ? $0 : "ERR_INVALID_CODE" },
      result: result.map(JsonText.bounded), t: t)
    return PendingLine(.actions, t: t, .action(line))
  }

  /// telemetry.jsonl. Sizes in MB (2^20 bytes) to a tenth, CPU to a tenth of a percent.
  static func telemetry(_ s: TelemetrySample) -> PendingLine {
    func percentile(_ stage: Stage) -> StagePercentile? {
      s.stageMs[stage].map { StagePercentile(p50: micro($0.p50), p95: micro($0.p95)) }
    }
    let line = TelemetryLine(
      candidatesBlurred: max(0, s.candidatesBlurred),
      candidatesDropped: max(0, s.candidatesDropped),
      // Not max(0, _), which would turn a NaN into 0 rather than let the encoder refuse it.
      cpu: tenth(s.cpuPercent < 0 ? 0 : s.cpuPercent), freeDiskMB: megabytes(s.freeDiskBytes),
      memoryMB: megabytes(s.memoryBytes), queue: max(0, s.queue),
      stageMS: StagePercentiles(
        blur: percentile(.blur), copy: percentile(.copy), depth: percentile(.depth),
        detect: percentile(.detect), encode: percentile(.encode), gate: percentile(.gate),
        sharpness: percentile(.sharpness), write: percentile(.write)),
      t: s.t, thermal: ThermalState(rawValue: s.thermal.rawValue) ?? .nominal)
    return PendingLine(.telemetry, t: s.t, .telemetry(line))
  }

  /// location.jsonl: the bundle's gnss.jsonl line, for a fix GnssWindows returned.
  static func location(_ fix: GnssFix) -> PendingLine {
    PendingLine(
      .location, t: fix.t,
      .location(
        GnssLine(hAccuracyM: fix.horizontalAccuracyM, lat: fix.lat, lon: fix.lon, t: fix.t)))
  }

  /// boundary.jsonl: a line BoundaryLineCheck accepted, written as JavaScript sent it.
  static func boundary(_ line: CheckedBoundaryLine) -> PendingLine {
    PendingLine(.boundary, t: line.t, .encoded(line.bytes))
  }

  /// mesh/history.jsonl: an add or update whose block goes to history.bin. Its place there is
  /// set with `placed(offset:bytes:)` once the writer knows it.
  static func meshBlock(
    t: Double, anchor: UUID, op: AnchorChangeOp, transform: WorldTransform, vertices: Int,
    faces: Int, final: Bool, captureID: UUID?
  ) -> PendingLine {
    precondition(op != .remove, "a remove has no block")
    let line = MeshHistoryLine(
      anchor: anchor.uuidString.lowercased(), bytes: nil,
      captureID: final ? captureID.map { $0.uuidString.lowercased() } : nil, faces: faces,
      meshHistoryLineFinal: final, offset: nil, op: HistoryOp(rawValue: op.rawValue) ?? .update,
      t: t, transform: written(transform), vertices: vertices)
    return PendingLine(.meshIndex, t: t, .meshHistory(line))
  }

  /// mesh/history.jsonl: a removal, which has no block.
  static func meshRemove(t: Double, anchor: UUID, final: Bool, captureID: UUID?) -> PendingLine {
    let line = MeshHistoryLine(
      anchor: anchor.uuidString.lowercased(), bytes: nil,
      captureID: final ? captureID.map { $0.uuidString.lowercased() } : nil, faces: nil,
      meshHistoryLineFinal: final, offset: nil, op: .remove, t: t, transform: nil, vertices: nil)
    return PendingLine(.meshIndex, t: t, .meshHistory(line))
  }
}

extension ActionLine {
  /// The line with `result`, if any, replaced by the too-large marker.
  fileprivate func replacingResult() -> ActionLine {
    ActionLine(
      args: args, call: call, error: error, result: result.map(JsonText.marker(for:)), t: t)
  }

  /// The line with `args` replaced by the too-large marker.
  fileprivate func replacingArgs() -> ActionLine {
    ActionLine(args: JsonText.marker(for: args), call: call, error: error, result: result, t: t)
  }
}

/// ARKit's float32 matrix as the file writes it: each value's shortest decimal.
private func written(_ transform: WorldTransform) -> [Double] {
  transform.m.map { Double(shortest: $0) }
}

private func array(_ v: SIMD3<Double>) -> [Double] {
  [v.x, v.y, v.z]
}

/// g to m/s², to a micro-unit: the product's last binary digits are noise far below the
/// sensor's, and would make every line longer.
private func metresPerSecond(_ g: SIMD3<Double>) -> [Double] {
  [g.x, g.y, g.z].map { micro($0 * standardGravity) }
}

/// To 6 decimals: a millisecond time to the nanosecond, an acceleration to the µm/s².
private func micro(_ value: Double) -> Double {
  guard value.isFinite else { return value }
  let rounded = (value * 1e6).rounded() / 1e6
  return rounded == 0 ? 0 : rounded
}

private func tenth(_ value: Double) -> Double {
  value.isFinite ? (value * 10).rounded() / 10 : value
}

private func megabytes(_ bytes: Int64) -> Double {
  tenth(Double(max(0, bytes)) / 1_048_576)
}

/// The format's error code: 1 to 100 of A-Z, a-z, 0-9, `_`, `.`, `:` and `-`.
private func isErrorCode(_ code: String) -> Bool {
  let bytes = Array(code.utf8)
  return (1...100).contains(bytes.count)
    && bytes.allSatisfy { byte in
      (byte >= UInt8(ascii: "A") && byte <= UInt8(ascii: "Z"))
        || (byte >= UInt8(ascii: "a") && byte <= UInt8(ascii: "z"))
        || (byte >= UInt8(ascii: "0") && byte <= UInt8(ascii: "9"))
        || byte == UInt8(ascii: "_") || byte == UInt8(ascii: ".") || byte == UInt8(ascii: ":")
        || byte == UInt8(ascii: "-")
    }
}
#endif
