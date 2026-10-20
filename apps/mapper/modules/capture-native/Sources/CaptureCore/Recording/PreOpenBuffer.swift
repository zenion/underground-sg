#if USG_RECORDER
/// The sensor samples from just before a recording opens (design 3.1 and section 6). The window
/// opens at the start mark's frame, but IMU, motion and altitude samples reach the capture queue
/// in batches, so some with `t` at or after the mark arrive before the mark is handled. This holds
/// the last `spanS` seconds of each stream while the recorder is armed, in memory only, and at
/// open releases those at or after the start. Nothing before the window is ever released.
public struct PreOpenBuffer: Sendable {
  private var imu: Held<ImuSample>
  private var motion: Held<MotionSample>
  private var altitude: Held<AltitudeSample>

  /// `spanS`: seconds of each stream held, counted back from its newest sample. `capacity`: the
  /// most samples held per stream whatever their times, about 2 s at 100 Hz, doubled.
  public init(spanS: Double = 2, capacity: Int = 400) {
    precondition(spanS > 0 && capacity > 0)
    imu = Held(spanS: spanS, capacity: capacity)
    motion = Held(spanS: spanS, capacity: capacity)
    altitude = Held(spanS: spanS, capacity: capacity)
  }

  public mutating func add(_ sample: ImuSample) { imu.add(sample) }
  public mutating func add(_ sample: MotionSample) { motion.add(sample) }
  public mutating func add(_ sample: AltitudeSample) { altitude.add(sample) }

  /// The samples at or after `startT`, in the order they came, and empties the buffer.
  public mutating func release(startT: Double) -> (
    imu: [ImuSample], motion: [MotionSample], altitude: [AltitudeSample]
  ) {
    defer { clear() }
    return (imu.since(startT), motion.since(startT), altitude.since(startT))
  }

  /// Drops everything: the session stopped or was discarded before it opened.
  public mutating func clear() {
    imu.clear()
    motion.clear()
    altitude.clear()
  }

  /// The number of samples held, for the debug figures.
  public var count: Int { imu.samples.count + motion.samples.count + altitude.samples.count }
}

/// One stream's last seconds.
private struct Held<Sample: TimedSample>: Sendable {
  let spanS: Double
  let capacity: Int
  private(set) var samples: [Sample] = []
  private var newestT = -Double.infinity

  init(spanS: Double, capacity: Int) {
    self.spanS = spanS
    self.capacity = capacity
  }

  mutating func add(_ sample: Sample) {
    guard sample.t.isFinite else { return }
    samples.append(sample)
    newestT = max(newestT, sample.t)
    // Samples mostly come in order, so the old ones are at the front.
    let cutoff = newestT - spanS
    if let first = samples.first, first.t < cutoff {
      samples.removeAll { $0.t < cutoff }
    }
    if samples.count > capacity { samples.removeFirst(samples.count - capacity) }
  }

  func since(_ startT: Double) -> [Sample] {
    samples.filter { $0.t >= startT }
  }

  mutating func clear() {
    samples = []
    newestT = -Double.infinity
  }
}
#endif
