/// A stage of the keyframe and candidate pipeline that `frames.jsonl`'s `ms` times
/// (docs/session-recording.md). The raw values are the keys of `ms` and of telemetry's `stage_ms`.
public enum Stage: String, CaseIterable, Sendable {
  /// The candidate gate.
  case gate
  /// Copying the frame's data out of the ARFrame.
  case copy
  /// The pre-blur sharpness score.
  case sharpness
  /// The face, person and screen detectors.
  case detect
  case blur
  /// The JPEG.
  case encode
  /// The depth and confidence PNGs.
  case depth
  /// Writing the files.
  case write
}

/// A stage's median and 95th percentile time, in milliseconds.
public struct StagePercentileValue: Equatable, Sendable {
  public var p50: Double
  public var p95: Double

  public init(p50: Double, p95: Double) {
    self.p50 = p50
    self.p95 = p95
  }
}

/// Per-stage times over a sliding window, for telemetry's `stage_ms` once a second
/// (docs/session-recording.md). The spike reads them to see which stage heat or load slows down.
/// Times are seconds since the ARKit session started, never decreasing, and a query never looks
/// back past the latest sample: as with RateMeter, adding a sample drops what has left its window.
public struct StageTimer: Sendable {
  public let windowS: Double
  private var samples: [Stage: Samples] = [:]
  /// The latest sample's time, so a query that falls behind it answers as of that time.
  private var latestT = -Double.infinity

  public init(windowS: Double = 1) {
    precondition(windowS > 0 && windowS.isFinite)
    self.windowS = windowS
  }

  /// Records that `stage` took `ms` milliseconds for the frame at `t`. A negative or non-finite
  /// time is a clock error, not a measurement, so it is ignored.
  public mutating func add(_ stage: Stage, ms: Double, at t: Double) {
    guard ms.isFinite, ms >= 0, t.isFinite else { return }
    latestT = max(latestT, t)
    samples[stage, default: Samples()].append(t: t, ms: ms, cutoff: t - windowS)
  }

  /// The nearest-rank median and 95th percentile of each stage's samples in `(t - windowS, t]`.
  /// A stage with no samples there is left out, as telemetry leaves out a stage that didn't run.
  /// A `t` behind the latest sample is taken as that sample's time: the samples before it may
  /// already be gone, so an earlier window can't be answered honestly. A non-finite `t` is a clock
  /// error: it gives nothing and drops nothing.
  public mutating func percentiles(at t: Double) -> [Stage: StagePercentileValue] {
    guard t.isFinite else { return [:] }
    let end = max(t, latestT)
    var out: [Stage: StagePercentileValue] = [:]
    for stage in Stage.allCases {
      guard var buffer = samples[stage] else { continue }
      buffer.drop(before: end - windowS)
      samples[stage] = buffer
      let values = buffer.values.sorted()
      guard !values.isEmpty else { continue }
      out[stage] = StagePercentileValue(
        p50: nearestRank(values, percent: 50), p95: nearestRank(values, percent: 95))
    }
    return out
  }

  /// How many samples `stage`'s buffer holds, dropped ones not yet compacted included. For the
  /// tests of the memory bound.
  func retainedCount(_ stage: Stage) -> Int {
    samples[stage]?.times.count ?? 0
  }
}

/// The nearest-rank percentile of sorted, non-empty values: the smallest value with at least
/// `percent` of the values at or below it. Integer maths, so 95% of 100 is rank 95, not 96.
func nearestRank(_ sorted: [Double], percent: Int) -> Double {
  let rank = max(1, (percent * sorted.count + 99) / 100)
  return sorted[rank - 1]
}

/// One stage's samples, oldest first, with a head index so dropping is cheap (as RateMeter does).
private struct Samples: Sendable {
  var times: [Double] = []
  var ms: [Double] = []
  var head = 0

  mutating func append(t: Double, ms value: Double, cutoff: Double) {
    times.append(t)
    ms.append(value)
    drop(before: cutoff)
  }

  mutating func drop(before cutoff: Double) {
    while head < times.count && times[head] <= cutoff { head += 1 }
    // Compact now and then, so the buffer stays about one window long.
    if head > 256 && head * 2 > times.count {
      times.removeFirst(head)
      ms.removeFirst(head)
      head = 0
    }
  }

  /// The samples still in the window. None is later than the query, which never falls behind
  /// the latest sample.
  var values: ArraySlice<Double> { ms[head...] }
}
