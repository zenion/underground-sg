#if USG_RECORDER
/// Pairs the accelerometer and the gyro, which Core Motion delivers as two streams at about
/// 100 Hz each, into imu.jsonl's samples (design 3.1). Each accelerometer sample takes the gyro
/// sample nearest in time, within `toleranceS`, and the pair is stamped with the accelerometer's
/// `t`. The nearest gyro sample may arrive just after the accelerometer's, so an accelerometer
/// sample waits until a gyro sample at or after its `t` has come, or until newer accelerometer
/// samples push it out of the short queue (a stalled gyro).
///
/// Samples whose `t` doesn't increase within their own stream are dropped and counted, so the
/// pairs come out strictly increasing, as imu.jsonl needs. An accelerometer sample with no gyro
/// sample within the tolerance is dropped and counted too.
public struct ImuPairer: Sendable {
  /// The furthest apart, in seconds, an accelerometer and a gyro sample may be to pair.
  public let toleranceS: Double
  /// Samples dropped because their `t` didn't increase.
  public private(set) var droppedNonIncreasing = 0
  /// Accelerometer samples dropped without a gyro sample to pair with.
  public private(set) var droppedUnpaired = 0

  /// Accelerometer samples waiting for the gyro sample after them, oldest first.
  private var waiting: [(t: Double, g: SIMD3<Double>)] = []
  /// The latest gyro samples, oldest first; enough to cover the tolerance at 100 Hz and more.
  private var gyros: [(t: Double, rate: SIMD3<Double>)] = []
  private var lastAccelT = -Double.infinity
  private var lastGyroT = -Double.infinity

  /// How many samples of each stream are held: a few tens of milliseconds at 100 Hz.
  static let capacity = 8

  public init(toleranceS: Double = 0.005) {
    precondition(toleranceS >= 0)
    self.toleranceS = toleranceS
  }

  /// An accelerometer sample, in g. Returns the pairs this completes, oldest first.
  public mutating func accelerometer(t: Double, g: SIMD3<Double>) -> [ImuSample] {
    guard t.isFinite, t > lastAccelT else {
      droppedNonIncreasing += 1
      return []
    }
    lastAccelT = t
    waiting.append((t, g))
    var paired = resolve(final: false)
    // A gyro stream that stalls mustn't hold accelerometer samples forever.
    while waiting.count > Self.capacity {
      paired += pair(waiting.removeFirst())
    }
    return paired
  }

  /// A gyro sample, in rad/s. Returns the pairs this completes, oldest first.
  public mutating func gyro(t: Double, rate: SIMD3<Double>) -> [ImuSample] {
    guard t.isFinite, t > lastGyroT else {
      droppedNonIncreasing += 1
      return []
    }
    lastGyroT = t
    gyros.append((t, rate))
    if gyros.count > Self.capacity { gyros.removeFirst(gyros.count - Self.capacity) }
    return resolve(final: false)
  }

  /// Pairs what is still waiting with the gyro samples there are, when the streams stop.
  public mutating func flush() -> [ImuSample] {
    resolve(final: true)
  }

  /// Pairs the waiting accelerometer samples whose nearest gyro sample is known: one has come at
  /// or after their `t`, so no later one can be nearer.
  private mutating func resolve(final: Bool) -> [ImuSample] {
    var paired: [ImuSample] = []
    while let first = waiting.first, final || lastGyroT >= first.t {
      waiting.removeFirst()
      paired += pair(first)
    }
    return paired
  }

  /// The pair for one accelerometer sample, or nothing (counted) without a gyro sample near it.
  private mutating func pair(_ accel: (t: Double, g: SIMD3<Double>)) -> [ImuSample] {
    var nearest: (t: Double, rate: SIMD3<Double>)?
    for gyro in gyros where abs(gyro.t - accel.t) <= toleranceS {
      // Ties go to the earlier gyro sample, which comes first.
      if nearest.map({ abs(gyro.t - accel.t) < abs($0.t - accel.t) }) ?? true { nearest = gyro }
    }
    guard let nearest else {
      droppedUnpaired += 1
      return []
    }
    return [ImuSample(t: accel.t, accelG: accel.g, gyro: nearest.rate)]
  }
}
#endif
