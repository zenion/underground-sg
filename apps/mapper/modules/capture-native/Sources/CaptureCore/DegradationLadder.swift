/// The phone's thermal state, as ProcessInfo.thermalState reports it. Telemetry and the `thermal`
/// event write the raw value.
public enum DeviceThermal: String, CaseIterable, Sendable {
  case nominal
  case fair
  case serious
  case critical
}

/// The recording profile chosen for a session (ADR 0010, "What a recording holds"). Recording off
/// is no profile at all, so it is not a case here.
public enum RecordProfile: String, CaseIterable, Sendable {
  /// Poses, sensors, the mesh history and the traces. No images, so no extra candidates.
  case lean
  /// `lean` plus the extra candidates, blurred like keyframes.
  case standard
  /// `standard` with a denser mesh history and more candidates.
  case dense
}

/// One step down the recorder's ladder (ADR 0010, "Degradation"). The order is fixed and is the
/// order of the cases: each step gives up more of the recording. The raw value is the
/// `degradation` event's detail.
public enum DegradationStep: String, CaseIterable, Comparable, Sendable {
  /// Fewer extra candidates: the first thing given up, since they are the heaviest stream.
  case fewerCandidates = "fewer_candidates"
  /// No more mesh history snapshots.
  case noMeshHistory = "no_mesh_history"
  /// The recording closes. The capture itself goes on.
  case noRecording = "no_recording"

  public static func < (lhs: DegradationStep, rhs: DegradationStep) -> Bool {
    lhs.order < rhs.order
  }

  var order: Int {
    switch self {
    case .fewerCandidates: 0
    case .noMeshHistory: 1
    case .noRecording: 2
    }
  }
}

/// The free-disk floors of the ladder, in bytes.
public struct DegradationConfig: Equatable, Sendable {
  /// Below this much free disk the recorder stops the mesh history.
  public var meshFloorBytes: Int64
  /// Below this much free disk the recording closes. Lower than `meshFloorBytes`, so the mesh
  /// history goes first.
  public var stopFloorBytes: Int64

  public init(meshFloorBytes: Int64, stopFloorBytes: Int64) {
    precondition(stopFloorBytes >= 0 && meshFloorBytes >= stopFloorBytes)
    self.meshFloorBytes = meshFloorBytes
    self.stopFloorBytes = stopFloorBytes
  }

  /// Provisional floors (2 GiB and 1 GiB). The spike sets the real ones from measured sizes and
  /// heat, as it does the profiles' rates.
  public static let provisional = DegradationConfig(
    meshFloorBytes: 2 << 30, stopFloorBytes: 1 << 30)
}

/// The recorder's degradation ladder (ADR 0010, "Degradation"). Under heat or low disk the
/// recorder steps down in a fixed order, first fewer extra candidates, then no mesh history, then
/// no recording, and writes each step as a `degradation` event. Only the recording gives way: the
/// candidate gate, poses, IMU, the bundle's keyframes and the blur detectors never change for it.
///
/// The rules are provisional until the spike measures heat and sizes:
/// - `serious` heat steps to `fewerCandidates`. A `lean` recording keeps no candidates, so for it
///   the step is `noMeshHistory`.
/// - `critical` heat steps to `noRecording`.
/// - Free disk below `meshFloorBytes` steps to `noMeshHistory`, below `stopFloorBytes` to
///   `noRecording`.
///
/// A later step brings every earlier one with it, in order (a `lean` recording never enters
/// `fewerCandidates`). Steps are never left within a session, even when the phone cools or disk is
/// freed: a recording that changes back and forth is harder to read than one that only steps down.
public struct DegradationLadder: Sendable {
  public let profile: RecordProfile
  public let config: DegradationConfig
  /// The steps entered so far, in order.
  public private(set) var steps: [DegradationStep] = []

  public init(profile: RecordProfile, config: DegradationConfig = .provisional) {
    self.profile = profile
    self.config = config
  }

  /// Checks the phone's state, at telemetry's rate or on a thermal change. Returns the steps newly
  /// entered, in order, for the recorder to apply and write as events; empty when nothing changed.
  public mutating func update(thermal: DeviceThermal, freeDiskBytes: Int64) -> [DegradationStep] {
    guard let target = target(thermal: thermal, freeDiskBytes: freeDiskBytes) else { return [] }
    let entered = DegradationStep.allCases.filter { step in
      step <= target && applies(step) && !steps.contains(step)
    }
    steps.append(contentsOf: entered)
    return entered
  }

  /// Whether the recording still writes extra candidates at its profile's rate. False for `lean`,
  /// which keeps none, and from `fewerCandidates` on.
  public var keepsCandidates: Bool {
    profile != .lean && !steps.contains(.fewerCandidates)
  }

  /// Whether the recording still writes mesh history snapshots.
  public var keepsMeshHistory: Bool { !steps.contains(.noMeshHistory) }

  /// Whether the recording is still open.
  public var keepsRecording: Bool { !steps.contains(.noRecording) }

  /// The furthest step the current state calls for, or nil for none.
  func target(thermal: DeviceThermal, freeDiskBytes: Int64) -> DegradationStep? {
    var target: DegradationStep?
    func raise(to step: DegradationStep) {
      if target.map({ step > $0 }) ?? true { target = step }
    }
    switch thermal {
    case .nominal, .fair: break
    case .serious: raise(to: profile == .lean ? .noMeshHistory : .fewerCandidates)
    case .critical: raise(to: .noRecording)
    }
    if freeDiskBytes < config.stopFloorBytes {
      raise(to: .noRecording)
    } else if freeDiskBytes < config.meshFloorBytes {
      raise(to: .noMeshHistory)
    }
    return target
  }

  /// A `lean` recording has no extra candidates to give up.
  func applies(_ step: DegradationStep) -> Bool {
    !(profile == .lean && step == .fewerCandidates)
  }
}
