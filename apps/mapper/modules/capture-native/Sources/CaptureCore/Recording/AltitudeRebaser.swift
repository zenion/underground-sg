#if USG_RECORDER
/// altitude.jsonl's `relative_m` is metres since the first sample written (design 3.1), but Core
/// Motion's `relativeAltitude` counts from when the altimeter started, which is before the
/// recording opened. This moves the zero to the first sample it is given, so the caller passes
/// only samples inside the window. Never absolute altitude.
public struct AltitudeRebaser: Sendable {
  /// Samples dropped because their `t` didn't increase (altitude.jsonl's must).
  public private(set) var droppedNonIncreasing = 0
  private var baseM: Double?
  private var lastT = -Double.infinity

  public init() {}

  /// The line for a sample about to be written, or nil (counted) when its `t` doesn't increase.
  /// `relative_m` is rounded to the millimetre, far below the barometer's resolution, so the
  /// subtraction's last binary digits don't lengthen every line.
  public mutating func line(_ sample: AltitudeSample) -> PendingLine? {
    guard sample.t.isFinite, sample.t > lastT else {
      droppedNonIncreasing += 1
      return nil
    }
    lastT = sample.t
    let base = baseM ?? sample.relativeAltitudeM
    baseM = base
    var relative = ((sample.relativeAltitudeM - base) * 1000).rounded() / 1000
    if relative == 0 { relative = 0 }
    return .altitude(t: sample.t, relativeM: relative, pressureKpa: sample.pressureKpa)
  }
}
#endif
