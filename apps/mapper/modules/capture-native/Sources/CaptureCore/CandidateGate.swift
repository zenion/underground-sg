/// When a frame becomes a candidate (ADR 0010, "Keyframes are a subset of candidates"). It runs in
/// every capture, with record mode on or off: a frame is a candidate when the phone has moved or
/// turned enough since the last candidate, no faster than the candidate rate, and `markAnchor`
/// and `addTag` force one. Keyframes are later chosen only from candidates, so a recording can
/// re-run the live choice exactly.
public struct CandidateGateConfig: Equatable, Sendable {
  /// Metres moved since the last candidate.
  public var minTranslationM: Double
  /// Degrees turned since the last candidate.
  public var minRotationDeg: Double
  /// At most this many candidates a second, forced ones aside.
  public var maxRateHz: Double

  public init(minTranslationM: Double, minRotationDeg: Double, maxRateHz: Double) {
    precondition(minTranslationM > 0 && minRotationDeg > 0 && maxRateHz > 0)
    self.minTranslationM = minTranslationM
    self.minRotationDeg = minRotationDeg
    self.maxRateHz = maxRateHz
  }

  /// ADR 0010's starting values (about 0.15 m, 5° and 5 Hz). The spike sets the real ones from
  /// measured heat, drops and sizes.
  public static let provisional = CandidateGateConfig(
    minTranslationM: 0.15, minRotationDeg: 5, maxRateHz: 5)
}

/// Why a frame became a candidate.
public enum CandidateTrigger: String, Equatable, Sendable {
  /// The first frame with normal tracking.
  case first
  case moved
  case turned
  /// `markAnchor` or `addTag` asked for it.
  case forced
}

public struct CandidateGate: Sendable {
  public let config: CandidateGateConfig
  private var last: (t: Double, transform: WorldTransform)?
  private var forcePending = false

  public init(config: CandidateGateConfig = .provisional) {
    self.config = config
  }

  /// Makes the next offered frame a candidate whatever its motion, rate or tracking.
  public mutating func force() {
    forcePending = true
  }

  /// Offers the frame at `t` (seconds) with the camera's `transform`. Returns why it is a
  /// candidate, or nil when it isn't one. Without normal tracking the pose can't be trusted, so
  /// only a forced frame gets through.
  public mutating func offer(t: Double, transform: WorldTransform, trackingNormal: Bool)
    -> CandidateTrigger?
  {
    if forcePending {
      forcePending = false
      last = (t, transform)
      return .forced
    }
    guard trackingNormal else { return nil }
    guard let previous = last else {
      last = (t, transform)
      return .first
    }
    // A small tolerance: frame times are multiples of the frame interval in floating point, and
    // 12 frames at 60 Hz must count as the 0.2 s of 5 Hz.
    guard t - previous.t >= 1 / config.maxRateHz - 1e-6 else { return nil }
    let trigger: CandidateTrigger
    if transform.distance(to: previous.transform) >= config.minTranslationM {
      trigger = .moved
    } else if transform.rotationDegrees(to: previous.transform) >= config.minRotationDeg {
      trigger = .turned
    } else {
      return nil
    }
    last = (t, transform)
    return trigger
  }
}
