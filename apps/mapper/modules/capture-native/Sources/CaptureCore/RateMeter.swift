/// Events per second over a sliding window, for the status the module reports at about 5 Hz
/// (frame rate, candidate rate). Times are seconds on any one clock, never decreasing.
public struct RateMeter: Sendable {
  public let window: Double
  private var times: [Double] = []
  private var head = 0

  public init(window: Double = 1) {
    precondition(window > 0)
    self.window = window
  }

  public mutating func tick(_ t: Double) {
    times.append(t)
    drop(before: t - window)
  }

  /// The rate over the window ending at `now`.
  public mutating func rate(at now: Double) -> Double {
    drop(before: now - window)
    return Double(times.count - head) / window
  }

  private mutating func drop(before cutoff: Double) {
    while head < times.count && times[head] <= cutoff { head += 1 }
    // Compact now and then, so the buffer stays about one window long.
    if head > 256 && head * 2 > times.count {
      times.removeFirst(head)
      head = 0
    }
  }
}
