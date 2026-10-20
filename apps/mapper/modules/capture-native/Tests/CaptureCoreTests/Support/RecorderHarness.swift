#if USG_RECORDER
import Foundation
import Testing

@testable import CaptureCore

// A scripted session for RecorderCore: frames along the Raffles City link at walking pace,
// anchors the test sets, and a MemorySink that every command goes to. All values are made up.

/// A corridor venue id, synthetic.
let corridorVenue = "36632586-e1fa-4e10-800a-81acf0eab09a"

func testUUID(_ n: Int) -> UUID {
  let digits = String(n, radix: 16)
  return UUID(
    uuidString: "00000000-0000-4000-8000-" + String(repeating: "0", count: 12 - digits.count)
      + digits)!
}

/// A device grant, as the walk build gets one.
func walkGrant() -> RecordingGrant {
  guard
    case .granted(let grant) = RecordPermission.decide(
      profile: .lean, facts: .walk, venues: [corridorVenue], freeDiskBytes: 64 << 30)
  else { preconditionFailure("the walk build is granted") }
  return grant
}

func deviceManifestBase(
  motion: MotionFrame? = .xMagneticNorthZVertical, altimeter: AltimeterStatus = .available
) -> ManifestBase {
  ManifestBase(
    origin: .device, appVersion: "0.1.0", gitCommit: "e191db7c0a4b5d6e7f8091a2b3c4d5e6f7081920",
    easBuildID: "7a1c9e52-4b3d-4f8a-9c6e-1d2b3a4c5e6f", deviceModel: "iPhone18,2",
    osVersion: "iOS 26.7",
    clock: SessionClock(
      uptime: 81_234.5, media: 81_234.5, wall: Date(timeIntervalSince1970: 1_792_455_302.104)),
    arkit: .lean, motionFrame: motion, altimeter: altimeter)
}

let recordingUUID = UUID(uuidString: "5d0c6f1e-3b7a-4f7e-9c51-2a8e4b6d1f03")!

/// A small window config for tests: a 5 s margin, idle after 3 s, 120 s at most.
let testWindow = RecorderWindowConfig(
  endMarginS: 5, idleTimeoutS: 3, idleRadiusM: 0.5, maxSessionS: 120)

final class Harness {
  let core: RecorderCore
  let sink = MemorySink(digest: sha256Hex, deflate: storedDeflate)
  /// Every command the core gave, in order.
  private(set) var commands: [SinkCommand] = []
  /// Every geometry request the core made.
  private(set) var requests: [GeometryRequest] = []
  var anchors: [AnchorSnapshot] = []
  var geometry: [UUID: MeshGeometry] = [:]
  /// Metres a second along −z; 0 stands still.
  var speed = 1.2
  private var frameIndex = 0
  private var position = SIMD3<Double>(0, 1.4, 0)
  private var lastT: Double?

  init(
    config: RecorderConfig = RecorderConfig(window: testWindow),
    motion: MotionFrame? = .xMagneticNorthZVertical, altimeter: AltimeterStatus = .available
  ) {
    core = RecorderCore(
      grant: walkGrant(), id: recordingUUID, config: config,
      manifestBase: deviceManifestBase(motion: motion, altimeter: altimeter))
  }

  func read(_ request: GeometryRequest) -> AnchorReading {
    requests.append(request)
    let wanted: Set<UUID>? =
      switch request {
      case .none: []
      case .anchors(let ids): Set(ids)
      case .everyMeshAnchor: nil
      }
    return AnchorReading(
      anchors: anchors, geometry: geometry.filter { wanted?.contains($0.key) ?? true })
  }

  /// Gives the commands to the sink, and tells the core once the sink finished.
  @discardableResult
  func run(_ new: [SinkCommand]) -> [SinkCommand] {
    commands += new
    sink.apply(new)
    if sink.state == .finished { core.finalizeCompleted() }
    return new
  }

  func sample(_ t: Double, index: Int? = nil, candidate: CandidateMark? = nil) -> FrameSample {
    FrameSample(
      frame: index ?? frameIndex, t: t,
      camera: .yaw(0, x: position.x, y: position.y, z: position.z),
      intrinsics: SIMD4(1445.2, 1445.2, 958.4, 721.9), tracking: .normal, mapping: .extending,
      exposureDurationS: 0.0166, exposureOffsetEV: 0, light: SIMD2(820, 4500), fps: 60,
      candidate: candidate, gateMs: 0.02)
  }

  /// One frame at `t`, the phone having moved at `speed` since the last.
  @discardableResult
  func frame(_ t: Double, index: Int? = nil, candidate: CandidateMark? = nil) -> [SinkCommand] {
    if let lastT { position.z -= speed * (t - lastT) }
    lastT = t
    let s = sample(t, index: index, candidate: candidate)
    frameIndex = (index ?? frameIndex) + 1
    return run(core.frame(s, position: position, readAnchors: read))
  }

  /// Frames at 60 Hz from `from` up to and including `to`.
  @discardableResult
  func frames(from: Double, to: Double) -> [SinkCommand] {
    var out: [SinkCommand] = []
    var i = (from * 60).rounded()
    while i / 60 <= to + 1e-9 {
      out += frame(micro(i / 60))
      i += 1
    }
    return out
  }

  /// A frame at `t` and a mark handled on it.
  @discardableResult
  func mark(
    _ role: AnchorMarkRole, at t: Double, streetFacing: Bool = false, endSessionHere: Bool = false
  ) -> [SinkCommand] {
    frame(t)
    return run(
      core.mark(
        MarkInput(role: role, streetFacing: streetFacing, endSessionHere: endSessionHere),
        readAnchors: read))
  }

  /// `stop`, handled on a frame at `t`.
  @discardableResult
  func stop(at t: Double) -> [SinkCommand] {
    frame(t)
    return run(core.stopRequested(frameT: t, readAnchors: read))
  }

  @discardableResult
  func imu(_ ts: [Double]) -> [SinkCommand] {
    run(core.imu(ts.map { ImuSample(t: $0, accelG: SIMD3(0, -1, 0), gyro: SIMD3(0, 0, 0.01)) }))
  }

  @discardableResult
  func motion(_ ts: [Double]) -> [SinkCommand] {
    run(
      core.motion(
        ts.map {
          MotionSample(
            t: $0, attitude: SIMD4(0, 0, 0, 1), gravityG: SIMD3(0, 0, -1),
            userAccelG: SIMD3(0, 0, 0), rotation: SIMD3(0, 0, 0),
            magneticField: SIMD3(12.5, -31.25, -18.75), magneticAccuracy: .high, heading: 90)
        }))
  }

  @discardableResult
  func telemetry(_ t: Double, thermal: DeviceThermal = .nominal, freeDisk: Int64 = 100 << 30)
    -> [SinkCommand]
  {
    run(
      core.telemetry(
        TelemetrySample(
          t: t, thermal: thermal, memoryBytes: 300 << 20, cpuPercent: 80, freeDiskBytes: freeDisk,
          queue: 0, candidatesBlurred: 0, candidatesDropped: 0, stageMs: [:])))
  }

  /// A boundary line as TypeScript serialises it.
  static func boundaryLine(t: Double, seq: Int, kind: String = "status") -> String {
    #"{"binary":null,"kind":""# + kind + #"","seq":"# + String(seq) + #","t":"# + String(t)
      + #","value":"{\"tracking\":\"normal\"}"}"#
  }

  // MARK: Reading back

  func lines(_ path: String) -> [Data] {
    guard let data = sink.file(path) else { return [] }
    return data.split(separator: 0x0A, omittingEmptySubsequences: false).dropLast().map {
      Data($0)
    }
  }

  func decode<T: Decodable>(_ path: String, as type: T.Type) throws -> [T] {
    try lines(path).map { try JSONDecoder().decode(T.self, from: $0) }
  }

  func manifest() throws -> RecordingManifest {
    try JSONDecoder().decode(RecordingManifest.self, from: #require(sink.recordingJson))
  }

  var finalizeOrder: CloseOrder? {
    for command in commands.reversed() {
      if case .finalize(let order) = command { return order }
    }
    return nil
  }

  var stopSessionCount: Int {
    commands.filter { if case .stopSession = $0 { true } else { false } }.count
  }
}

/// To the microsecond, as SessionClock rounds every `t`.
func micro(_ value: Double) -> Double {
  let rounded = (value * 1e6).rounded() / 1e6
  return rounded == 0 ? 0 : rounded
}

/// A floor strip with `faces` triangles.
func stripGeometry(faces: Int) -> MeshGeometry {
  let quads = (faces + 1) / 2
  var vertices: [Float] = []
  for k in 0...quads { vertices += [Float(k) * 0.5, 0, -1, Float(k) * 0.5, 0, 1] }
  var indices: [UInt32] = []
  for k in 0..<quads {
    let a = UInt32(2 * k)
    indices += [a, a + 1, a + 2, a + 1, a + 3, a + 2]
  }
  indices = Array(indices.prefix(3 * faces))
  return MeshGeometry(
    vertices: vertices, faces: .uint32(indices), classes: [UInt8](repeating: 2, count: faces))
}

// MARK: - The files against the schemas' shapes

/// Every line of every file decoded with its generated type and encoded again: the same bytes
/// mean the line has exactly the type's fields, explicit nulls included, so it has the shape the
/// JSON Schema gives (the generated types come from the schemas). boundary.jsonl, which
/// TypeScript writes, is checked for its five fields. Returns the number of lines checked.
@discardableResult
func checkShapes(_ sink: MemorySink) throws -> Int {
  let encoder = LineEncoder()
  var checked = 0
  func roundTrip<T: Codable>(_ type: T.Type, _ path: String) throws {
    let data = try #require(sink.file(path))
    #expect(data.isEmpty || data.last == 0x0A, "\(path) ends with a newline")
    for line in data.split(separator: 0x0A) {
      let value = try JSONDecoder().decode(T.self, from: Data(line))
      #expect(try encoder.line(value) == Data(line) + [0x0A], "\(path) line \(checked)")
      checked += 1
    }
  }
  for path in sink.paths {
    switch path {
    case "recording.json":
      let data = try #require(sink.recordingJson)
      let manifest = try JSONDecoder().decode(RecordingManifest.self, from: data)
      #expect(try encoder.document(manifest) == data)
      checked += 1
    case "frames.jsonl": try roundTrip(RecordingFrameLine.self, path)
    case "imu.jsonl": try roundTrip(ImuLine.self, path)
    case "motion.jsonl": try roundTrip(MotionLine.self, path)
    case "altitude.jsonl": try roundTrip(AltitudeLine.self, path)
    case "anchors.jsonl": try roundTrip(AnchorHistoryLine.self, path)
    case "events.jsonl": try roundTrip(RecordingEventLine.self, path)
    case "actions.jsonl": try roundTrip(ActionLine.self, path)
    case "telemetry.jsonl": try roundTrip(TelemetryLine.self, path)
    case "location.jsonl": try roundTrip(GnssLine.self, path)
    case "mesh/history.jsonl": try roundTrip(MeshHistoryLine.self, path)
    case "boundary.jsonl":
      let data = try #require(sink.file(path))
      for line in data.split(separator: 0x0A) {
        let object = try #require(
          try JSONSerialization.jsonObject(with: Data(line)) as? [String: Any])
        #expect(Set(object.keys) == ["t", "seq", "kind", "value", "binary"])
        #expect(object["binary"] is NSNull)
        checked += 1
      }
    case "mesh/history.bin":
      break
    default:
      Issue.record("a file outside the layout: \(path)")
    }
  }
  return checked
}

/// Every line's `t` in every JSONL file, by path.
func lineTimes(_ sink: MemorySink) throws -> [String: [Double]] {
  struct Timed: Decodable { let t: Double }
  var out: [String: [Double]] = [:]
  for path in sink.paths where path.hasSuffix(".jsonl") {
    let data = try #require(sink.file(path))
    out[path] = try data.split(separator: 0x0A).map {
      try JSONDecoder().decode(Timed.self, from: Data($0)).t
    }
  }
  return out
}
#endif
