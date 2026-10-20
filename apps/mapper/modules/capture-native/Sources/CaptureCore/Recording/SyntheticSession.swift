#if USG_RECORDER
import Foundation

// A generated lean session (design 3.1, D13 and D18): the inputs the module would hand
// RecorderCore on a walk from Esplanade's Exit F down to the B1 junction and along to Exit G, made
// up from a seed. No sensor ever recorded any of it, so what it writes is `origin: synthetic` and
// may be shared (open question Q13). The same seed and length always give the same inputs, so
// the files a sink writes from it are byte for byte the same on every platform.
//
// What it holds: 60 Hz frames with a limited-tracking stretch and a gap; 100 Hz IMU and device
// motion; altitude about 1 Hz; mesh anchors along the path whose geometry grows, one moved and
// one removed; a street-facing start mark at 2 s; GNSS fixes near Exit F (public street
// coordinates, before and after the mark, drifting out of the window's radius); a thermal
// change; telemetry; session calls; boundary lines; and an end mark with End the session here
// 8 s before the end, so the recording closes as end_anchor 5 s later.

/// One input, in the order the module would give it.
public enum SyntheticStep: Sendable {
  case frame(FrameSample, position: SIMD3<Double>)
  /// Handled on the frame just before it.
  case mark(MarkInput)
  case imu([ImuSample])
  case motion([MotionSample])
  case altitude(AltitudeSample)
  case gnss(GnssFix)
  case telemetry(TelemetrySample)
  case event(RecordingEvent, t: Double)
  case action(ActionInput)
  case meshUpdated(UUID)
  case meshRemoved(UUID)
  /// Something JavaScript received at `t`: BoundaryTrace buffers it.
  case boundaryEvent(t: Double, kind: String, value: String)
  /// BoundaryTrace's flush, once a second.
  case boundaryFlush
}

public struct SyntheticSession: Sendable {
  public let seed: UInt64
  public let durationS: Double
  /// The recording's id, from the seed.
  public let recordingID: UUID
  /// When the start mark opens the window.
  public static let startMarkT = 2.0

  /// `durationS` at least 20, so the walk, the gap and the close all fit.
  public init(seed: UInt64 = 1, durationS: Double = 60) {
    precondition(durationS >= 20 && durationS <= 1800)
    self.seed = seed
    self.durationS = durationS
    var random = SplitMix64(seed: seed)
    recordingID = random.uuid()
  }

  /// When the end mark with End the session here comes: 8 s before the end, on a frame.
  public var endMarkT: Double { micro(((durationS - 8) * 60).rounded() / 60) }

  /// The manifest of a synthetic set: no build, device or OS, a fixed clock.
  public var manifestBase: ManifestBase {
    ManifestBase(
      origin: .synthetic, appVersion: "synthetic", gitCommit: nil, easBuildID: nil,
      deviceModel: "synthetic", osVersion: "synthetic",
      clock: SessionClock(
        uptime: 5000, media: 5000.000125, wall: Date(timeIntervalSince1970: 1_792_454_400)),
      arkit: .lean, motionFrame: .xMagneticNorthZVertical)
  }

  /// A recorder for this session, with the synthetic grant only a synthetic session gets: what
  /// it writes is labelled `origin: synthetic`.
  public func makeRecorder(config: RecorderConfig = .lean) -> RecorderCore {
    RecorderCore(
      grant: RecordingGrant(profile: .lean, venues: SyntheticWorld.venues, origin: .synthetic),
      id: recordingID, config: config, manifestBase: manifestBase)
  }

  /// The anchors as the session has them at `t`, with the geometry asked for.
  public func reading(at t: Double, _ request: GeometryRequest) -> AnchorReading {
    world.reading(at: t, request)
  }

  /// Feeds every step to `core` and each step's commands to `apply`, as the module would.
  /// Boundary lines are numbered from 0 when the window opens and lines from before it are
  /// dropped (design D21). After `stopSession` the session is paused, so nothing more comes but
  /// the final boundary flush. The caller tells the core when its sink finished.
  public func drive(_ core: RecorderCore, apply: ([SinkCommand]) -> Void) {
    let world = self.world
    var trace = BoundaryBuffer()
    var lastFrameT = 0.0
    for step in steps() {
      let commands: [SinkCommand]
      switch step {
      case .frame(let sample, let position):
        lastFrameT = sample.t
        commands = core.frame(sample, position: position) { world.reading(at: sample.t, $0) }
      case .mark(let mark):
        let t = lastFrameT
        commands = core.mark(mark) { world.reading(at: t, $0) }
      case .imu(let batch): commands = core.imu(batch)
      case .motion(let batch): commands = core.motion(batch)
      case .altitude(let sample): commands = core.altitude(sample)
      case .gnss(let fix): commands = core.gnss(fix)
      case .telemetry(let sample): commands = core.telemetry(sample)
      case .event(let event, let t): commands = core.event(event, t: t)
      case .action(let action): commands = core.action(action)
      case .meshUpdated(let id):
        core.meshUpdated(id)
        commands = []
      case .meshRemoved(let id):
        core.meshRemoved(id)
        commands = []
      case .boundaryEvent(let t, let kind, let value):
        trace.record(t: t, kind: kind, value: value)
        commands = []
      case .boundaryFlush:
        commands = core.boundary(trace.flush(core: core, upTo: nil), final: false)
      }
      apply(commands)
      if commands.contains(where: { if case .stopSession = $0 { true } else { false } }) {
        break
      }
    }
    if case .finalizing(let close) = core.phase {
      trace.record(t: close.endT, kind: "recording", value: #"{"state":"finalizing"}"#)
      apply(core.boundary(trace.flush(core: core, upTo: close.endT), final: true))
    }
  }

  /// Every input in order: by time, and at one time a frame first, then its mark, then the
  /// session call that mark resolves, then the rest in the order made.
  public func steps() -> [SyntheticStep] {
    var timed: [(t: Double, rank: Int, step: SyntheticStep)] = []
    func add(_ t: Double, _ rank: Int, _ step: SyntheticStep) { timed.append((t, rank, step)) }
    let world = self.world
    var noise = SplitMix64(seed: seed &+ 0x9e37_79b9)

    // Frames at 60 Hz, a 6-frame gap at 30 % of the way.
    let gapStart = Int(durationS * 0.3 * 60)
    var frameIndex = 0
    for i in 0..<Int(durationS * 60) {
      if (gapStart..<(gapStart + 6)).contains(i) { continue }
      let t = micro(Double(i) / 60)
      let (camera, position) = world.camera(at: t)
      let tracking = world.tracking(at: t)
      let moving = t > Self.startMarkT && t < endMarkT
      let isMark = abs(t - Self.startMarkT) < 1e-9 || abs(t - endMarkT) < 1e-9
      let gated = isMark || (tracking == .normal && moving && i % 12 == 0)
      let sample = FrameSample(
        frame: frameIndex, t: t, camera: camera, intrinsics: SIMD4(1445.2, 1445.2, 958.4, 721.9),
        tracking: tracking,
        mapping: t < 1 ? .notAvailable : t < durationS * 0.8 ? .extending : .mapped,
        exposureDurationS: 0.0166, exposureOffsetEV: 0,
        light: tracking == .normal ? SIMD2(Float(820 + noise.unit() * 40), 4500) : nil, fps: 60,
        candidate: gated ? .dropped(.profile) : nil, gateMs: micro(0.015 + noise.unit() * 0.01))
      add(t, 0, .frame(sample, position: position))
      frameIndex += 1
    }

    // The marks, and the calls that resolve on them.
    add(Self.startMarkT, 1, .mark(MarkInput(role: .start, streetFacing: true)))
    add(endMarkT, 1, .mark(MarkInput(role: .end, endSessionHere: true)))
    add(
      0.05, 2,
      .action(
        ActionInput(
          call: .start, t: 0.05, args: #"{"record":"lean","venues":[]}"#,
          result: #"{"recordingId":null}"#, error: nil)))
    add(
      Self.startMarkT, 2,
      .action(
        ActionInput(
          call: .markAnchor, t: Self.startMarkT,
          args:
            #"{"endSessionHere":false,"kind":"floor_point","name":null,"role":"start","streetFacing":true}"#,
          result: #"{"frame":120,"window":"opened"}"#, error: nil)))
    let tagT = micro(durationS * 0.5)
    add(
      tagT, 2,
      .action(
        ActionInput(
          call: .addTag, t: tagT, args: #"{"kind":"junction","name":null,"type":"node"}"#,
          result: #"{"frame":0}"#, error: nil)))
    add(
      endMarkT, 2,
      .action(
        ActionInput(
          call: .markAnchor, t: endMarkT,
          args:
            #"{"endSessionHere":true,"kind":"floor_point","name":null,"role":"end","streetFacing":false}"#,
          result: #"{"window":"closing"}"#, error: nil)))

    // IMU and device motion at 100 Hz, in batches of 10 handed over with their last sample.
    var imu: [ImuSample] = []
    var motion: [MotionSample] = []
    for k in 1..<Int(durationS * 100) {
      let t = micro(Double(k) / 100)
      let yaw = world.yaw(at: t)
      imu.append(
        ImuSample(
          t: t, accelG: SIMD3(noise.unit() * 0.02, -1 + noise.unit() * 0.02, noise.unit() * 0.02),
          gyro: SIMD3(noise.unit() * 0.01, noise.unit() * 0.01, noise.unit() * 0.01)))
      motion.append(
        MotionSample(
          t: t, attitude: SIMD4(0, 0, sin(yaw / 2), cos(yaw / 2)), gravityG: SIMD3(0, 0, -1),
          userAccelG: SIMD3(noise.unit() * 0.01, noise.unit() * 0.01, noise.unit() * 0.01),
          rotation: SIMD3(0, 0, noise.unit() * 0.01), magneticField: SIMD3(12.5, -31.25, -18.75),
          magneticAccuracy: .high, heading: degrees(yaw)))
      if imu.count == 10 {
        add(t, 3, .imu(imu))
        add(t, 3, .motion(motion))
        imu = []
        motion = []
      }
    }

    // Altitude about 1 Hz, from the floor's height.
    for k in 0..<Int(durationS) {
      let t = Double(k) + 0.25
      let y = world.floorY(at: t)
      add(
        t, 3,
        .altitude(
          AltitudeSample(t: t, relativeAltitudeM: 3 + y, pressureKpa: micro(101.3 - y * 0.012))))
    }

    // GNSS at 1 Hz near Exit F for the first 14 s, drifting north about 6.7 m a second, so the
    // fixes from 8 s after the anchor's first fix on fall outside the window's 50 m.
    for k in 0..<14 {
      let t = Double(k) + 0.5
      add(
        t, 3,
        .gnss(
          GnssFix(t: t, lat: 1.29425 + 0.00006 * Double(k), lon: 103.85565, horizontalAccuracyM: 8))
      )
    }

    // Telemetry once a second, and the phone warming to fair halfway.
    let warmT = micro(durationS * 0.5 + 0.3)
    for k in 0..<Int(durationS) {
      let t = Double(k) + 0.5
      add(
        t, 3,
        .telemetry(
          TelemetrySample(
            t: t, thermal: t >= warmT ? .fair : .nominal, memoryBytes: 300 << 20, cpuPercent: 85,
            freeDiskBytes: 100 << 30, queue: 0, candidatesBlurred: 0, candidatesDropped: 0,
            stageMs: [.gate: StagePercentileValue(p50: 0.02, p95: 0.03)])))
    }
    add(warmT, 3, .event(.thermal(.fair), t: warmT))

    // Mesh anchors as ARKit reports them.
    for (t, change) in world.meshChanges() {
      switch change {
      case .updated(let id): add(t, 3, .meshUpdated(id))
      case .removed(let id): add(t, 3, .meshRemoved(id))
      }
    }

    // What JavaScript receives: the status every second, and the window opening.
    add(
      Self.startMarkT, 3,
      .boundaryEvent(t: Self.startMarkT, kind: "recording", value: #"{"state":"open"}"#))
    for k in 0..<Int(durationS) {
      let t = Double(k) + 0.2
      add(t, 3, .boundaryEvent(t: t, kind: "status", value: #"{"fps":60,"tracking":"normal"}"#))
      add(Double(k) + 0.9, 4, .boundaryFlush)
    }

    var order = 0
    return timed.map { item -> (Double, Int, Int, SyntheticStep) in
      order += 1
      return (item.t, item.rank, order, item.step)
    }
    .sorted { ($0.0, $0.1, $0.2) < ($1.0, $1.1, $1.2) }
    .map(\.3)
  }

  var world: SyntheticWorld { SyntheticWorld(seed: seed, durationS: durationS, endMarkT: endMarkT) }
}

/// The walk's geometry: the path, the camera along it, and the anchors.
struct SyntheticWorld: Sendable {
  /// A corridor venue id, fixed like the seed's (open question Q12); synthetic either way.
  static let venues = ["5d6e7f80-1a2b-4c3d-8e9f-a0b1c2d3e4f5"]

  /// Exit F's door, the B1 junction at the foot of the stairs, along the B1 passage, and up to
  /// Exit G, in session metres (y up; the camera is 1.4 m above the floor).
  static let path: [SIMD3<Double>] = [
    SIMD3(0, 0, 0), SIMD3(2, -5, -24), SIMD3(28, -5, -36), SIMD3(30, 0, -58),
  ]

  enum MeshChange {
    case updated(UUID)
    case removed(UUID)
  }

  struct MeshAnchor {
    let id: UUID
    let point: SIMD3<Double>
    let addT: Double
    let removeT: Double?
    /// The 16-bit index path, on every other anchor.
    let shortIndices: Bool
  }

  let durationS: Double
  let endMarkT: Double
  let meshAnchors: [MeshAnchor]
  let startMarkID: UUID
  let endMarkID: UUID
  /// When anchor 0 moves 2 mm without its geometry changing.
  let shiftT: Double

  init(seed: UInt64, durationS: Double, endMarkT: Double) {
    self.durationS = durationS
    self.endMarkT = endMarkT
    var random = SplitMix64(seed: seed &+ 0x51_7cc1)
    startMarkID = random.uuid()
    endMarkID = random.uuid()
    shiftT = micro(durationS * 0.5)
    let length = Self.length
    var anchors: [MeshAnchor] = []
    var arc = 0.0
    var index = 0
    while arc <= length {
      // Seen 10 m ahead of the walker; those within 10 m of the door exist from the start.
      let seenArc = arc - 10
      let addT =
        seenArc <= 0
        ? 0
        : micro(
          SyntheticSession.startMarkT + seenArc / length * (endMarkT - SyntheticSession.startMarkT))
      anchors.append(
        MeshAnchor(
          id: random.uuid(), point: Self.point(atArc: arc), addT: addT,
          removeT: index == 1 ? micro(durationS * 0.6) : nil, shortIndices: index % 2 == 0))
      arc += 6
      index += 1
    }
    meshAnchors = anchors
  }

  static var length: Double {
    zip(path, path.dropFirst()).reduce(0) { $0 + horizontalAndVertical($1.1 - $1.0) }
  }

  static func point(atArc arc: Double) -> SIMD3<Double> {
    var rest = max(0, arc)
    for (a, b) in zip(path, path.dropFirst()) {
      let segment = horizontalAndVertical(b - a)
      if rest <= segment { return a + (b - a) * (rest / segment) }
      rest -= segment
    }
    return path[path.count - 1]
  }

  /// The walker's arc length at `t`: at the door until the start mark, then steadily to Exit G
  /// at the end mark, then still.
  func arc(at t: Double) -> Double {
    let start = SyntheticSession.startMarkT
    let u = min(1, max(0, (t - start) / (endMarkT - start)))
    return u * Self.length
  }

  func floorY(at t: Double) -> Double { Self.point(atArc: arc(at: t)).y }

  /// The walking direction's yaw; still at the ends, looking along the first or last segment.
  func yaw(at t: Double) -> Double {
    let here = Self.point(atArc: arc(at: t))
    let ahead = Self.point(atArc: min(arc(at: t) + 0.5, Self.length))
    var direction = ahead - here
    if direction.x * direction.x + direction.z * direction.z < 1e-9 {
      direction = Self.path[Self.path.count - 1] - Self.path[Self.path.count - 2]
    }
    return atan2(-direction.x, -direction.z)
  }

  func camera(at t: Double) -> (WorldTransform, SIMD3<Double>) {
    let floor = Self.point(atArc: arc(at: t))
    let position = floor + SIMD3(0, 1.4, 0)
    let transform = WorldTransform.yaw(yaw(at: t), x: position.x, y: position.y, z: position.z)
    return (transform, position)
  }

  func tracking(at t: Double) -> TrackingCode {
    if t < 0.5 { return .limited(.initializing) }
    let stretch = durationS * 0.55
    if t >= stretch && t < stretch + 1 { return .limited(.excessiveMotion) }
    return .normal
  }

  /// ARKit's mesh callbacks: each anchor added, then its geometry growing once a second for 5 s;
  /// anchor 0 moved at `shiftT`; anchor 1 removed.
  func meshChanges() -> [(Double, MeshChange)] {
    var changes: [(Double, MeshChange)] = []
    for anchor in meshAnchors {
      for k in 0...5 {
        let t = micro(anchor.addT + Double(k))
        if let removeT = anchor.removeT, t >= removeT { break }
        changes.append((t, .updated(anchor.id)))
      }
      if let removeT = anchor.removeT { changes.append((removeT, .removed(anchor.id))) }
    }
    if let first = meshAnchors.first { changes.append((shiftT, .updated(first.id))) }
    return changes
  }

  func reading(at t: Double, _ request: GeometryRequest) -> AnchorReading {
    var anchors: [AnchorSnapshot] = []
    var geometry: [UUID: MeshGeometry] = [:]
    let wanted: Set<UUID>?
    switch request {
    case .none: wanted = []
    case .anchors(let ids): wanted = Set(ids)
    case .everyMeshAnchor: wanted = nil
    }
    for (index, anchor) in meshAnchors.enumerated() {
      guard anchor.addT <= t, anchor.removeT.map({ t < $0 }) ?? true else { continue }
      let shift = index == 0 && t >= shiftT ? 0.002 : 0
      anchors.append(
        AnchorSnapshot(
          id: anchor.id, kind: .mesh,
          transform: .yaw(0, x: anchor.point.x + shift, y: anchor.point.y, z: anchor.point.z)))
      if wanted?.contains(anchor.id) ?? true {
        geometry[anchor.id] = Self.strip(
          quads: 1 + min(5, Int((t - anchor.addT) + 1e-9)), shortIndices: anchor.shortIndices,
          classified: index % 3 != 2)
      }
    }
    if t >= SyntheticSession.startMarkT {
      anchors.append(AnchorSnapshot(id: startMarkID, kind: .marked, transform: .identity))
    }
    if t >= endMarkT {
      let end = Self.path[Self.path.count - 1]
      anchors.append(
        AnchorSnapshot(
          id: endMarkID, kind: .marked, transform: .yaw(0, x: end.x, y: end.y, z: end.z)))
    }
    return AnchorReading(anchors: anchors, geometry: geometry)
  }

  /// A floor strip of `quads` half-metre quads, two triangles each, classified as floor (2).
  static func strip(quads: Int, shortIndices: Bool, classified: Bool) -> MeshGeometry {
    var vertices: [Float] = []
    for k in 0...quads {
      vertices += [Float(k) * 0.5, 0, -1, Float(k) * 0.5, 0, 1]
    }
    var indices: [UInt32] = []
    for k in 0..<quads {
      let a = UInt32(2 * k)
      indices += [a, a + 1, a + 2, a + 1, a + 3, a + 2]
    }
    return MeshGeometry(
      vertices: vertices,
      faces: shortIndices ? .uint16(indices.map { UInt16($0) }) : .uint32(indices),
      classes: classified ? [UInt8](repeating: 2, count: 2 * quads) : nil)
  }
}

/// BoundaryTrace's part the driver needs (design D21): lines buffered until the window opens,
/// those from before the open dropped, the rest numbered from 0.
private struct BoundaryBuffer {
  private var buffered: [(t: Double, kind: String, value: String)] = []
  private var nextSeq = 0

  mutating func record(t: Double, kind: String, value: String) {
    buffered.append((t, kind, value))
  }

  /// The lines to hand over now. While the recorder is armed they wait, at most 2 s of them.
  mutating func flush(core: RecorderCore, upTo limit: Double?) -> [String] {
    let startT: Double
    switch core.windowState {
    case .waiting:
      if let newest = buffered.last?.t { buffered.removeAll { $0.t < newest - 2 } }
      return []
    case .open(let s), .closing(let s, _), .closed(let s, _, _, _):
      startT = s
    case .discarded:
      buffered = []
      return []
    }
    var out: [String] = []
    for line in buffered where line.t >= startT {
      // The final flush hands over only what is inside the closed window.
      if let limit, line.t > limit { continue }
      out.append(Self.text(t: line.t, seq: nextSeq, kind: line.kind, value: line.value))
      nextSeq += 1
    }
    buffered = []
    return out
  }

  /// The line as TypeScript serialises it: sorted keys, `binary` null.
  static func text(t: Double, seq: Int, kind: String, value: String) -> String {
    let data =
      (try? LineEncoder().line(BoundaryWire(t: t, seq: seq, kind: kind, value: value)))
      ?? Data()
    return String(decoding: data.dropLast(), as: UTF8.self)
  }
}

private struct BoundaryWire: Encodable {
  let t: Double
  let seq: Int
  let kind: String
  let value: String

  enum CodingKeys: String, CodingKey {
    case binary, kind, seq, t, value
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encodeNil(forKey: .binary)
    try container.encode(kind, forKey: .kind)
    try container.encode(seq, forKey: .seq)
    try container.encode(t, forKey: .t)
    try container.encode(value, forKey: .value)
  }
}

/// SplitMix64: a small, fixed generator, so the noise is the same on every platform.
struct SplitMix64: Sendable {
  private var state: UInt64

  init(seed: UInt64) { state = seed }

  mutating func next() -> UInt64 {
    state &+= 0x9e37_79b9_7f4a_7c15
    var z = state
    z = (z ^ (z >> 30)) &* 0xbf58_476d_1ce4_e5b9
    z = (z ^ (z >> 27)) &* 0x94d0_49bb_1331_11eb
    return z ^ (z >> 31)
  }

  /// In [-1, 1), to a micro-unit so lines stay short.
  mutating func unit() -> Double {
    micro(Double(next() >> 11) / Double(1 << 53) * 2 - 1)
  }

  /// A version 4 UUID.
  mutating func uuid() -> UUID {
    let a = next()
    let b = next()
    var bytes =
      (0..<8).map { UInt8(truncatingIfNeeded: a >> (8 * $0)) }
      + (0..<8).map { UInt8(truncatingIfNeeded: b >> (8 * $0)) }
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    return UUID(
      uuid: (
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
      ))
  }
}

private func horizontalAndVertical(_ v: SIMD3<Double>) -> Double {
  (v.x * v.x + v.y * v.y + v.z * v.z).squareRoot()
}

/// To the microsecond, as SessionClock rounds every `t`.
private func micro(_ value: Double) -> Double {
  let rounded = (value * 1e6).rounded() / 1e6
  return rounded == 0 ? 0 : rounded
}

/// Degrees from 0 up to 360, as Core Motion's heading.
private func degrees(_ radians: Double) -> Double {
  let value = (radians * 180 / Double.pi).truncatingRemainder(dividingBy: 360)
  return micro(value < 0 ? value + 360 : value)
}
#endif
