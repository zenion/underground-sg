import Foundation
import Testing

@testable import CaptureCore

@Suite struct StageTimerTests {
  @Test func stagesAreTheKeysOfTheGeneratedTimings() throws {
    let names = Set(Stage.allCases.map(\.rawValue))
    let timings = StageTimings(
      blur: 1, copy: 1, depth: 1, detect: 1, encode: 1, gate: 1, sharpness: 1, write: 1)
    let timingKeys = try JSONSerialization.jsonObject(with: JSONEncoder().encode(timings))
    #expect(Set((timingKeys as? [String: Any])?.keys.map { $0 } ?? []) == names)
    let one = StagePercentile(p50: 1, p95: 2)
    let percentiles = StagePercentiles(
      blur: one, copy: one, depth: one, detect: one, encode: one, gate: one, sharpness: one,
      write: one)
    let percentileKeys = try JSONSerialization.jsonObject(
      with: JSONEncoder().encode(percentiles))
    #expect(Set((percentileKeys as? [String: Any])?.keys.map { $0 } ?? []) == names)
  }

  @Test func nearestRankOnKnownSamples() {
    let hundred = (1...100).map(Double.init)
    #expect(nearestRank(hundred, percent: 50) == 50)
    #expect(nearestRank(hundred, percent: 95) == 95)
    let twenty = (1...20).map(Double.init)
    #expect(nearestRank(twenty, percent: 50) == 10)
    #expect(nearestRank(twenty, percent: 95) == 19)
    let three: [Double] = [2, 4, 9]
    #expect(nearestRank(three, percent: 50) == 4)
    #expect(nearestRank(three, percent: 95) == 9)
    #expect(nearestRank([7], percent: 50) == 7)
    #expect(nearestRank([7], percent: 95) == 7)
  }

  @Test func percentilesOfOneSecond() {
    var timer = StageTimer()
    // 20 blurs at 25 Hz, 1 ms to 20 ms in shuffled order.
    for i in 0..<20 {
      let ms = Double((i * 7) % 20 + 1)
      timer.add(.blur, ms: ms, at: 10 + Double(i) * 0.04)
    }
    timer.add(.gate, ms: 0.3, at: 10.5)
    let result = timer.percentiles(at: 10.8)
    #expect(result[.blur] == StagePercentileValue(p50: 10, p95: 19))
    #expect(result[.gate] == StagePercentileValue(p50: 0.3, p95: 0.3))
    #expect(Set(result.keys) == [.blur, .gate])
  }

  @Test func windowIsHalfOpen() {
    var timer = StageTimer(windowS: 1)
    timer.add(.encode, ms: 100, at: 5)
    timer.add(.encode, ms: 1, at: 5.5)
    timer.add(.encode, ms: 2, at: 6)
    // (5, 6]: the sample at exactly 5 has left the window, the one at 6 is in it.
    #expect(timer.percentiles(at: 6) == [.encode: StagePercentileValue(p50: 1, p95: 2)])
    // (5.5, 6.5]: only the last.
    #expect(timer.percentiles(at: 6.5) == [.encode: StagePercentileValue(p50: 2, p95: 2)])
    // Nothing left: the stage is left out.
    #expect(timer.percentiles(at: 7.5).isEmpty)
  }

  @Test func aQueryBehindTheLatestSampleAnswersAsOfThatSample() {
    var timer = StageTimer()
    timer.add(.write, ms: 3, at: 0.3)
    timer.add(.write, ms: 50, at: 1.5)
    timer.add(.gate, ms: 1, at: 1.4)
    // Adding at 1.5 dropped the sample at 0.3, so (0.2, 1.2] can't be answered: the query is
    // taken as 1.5, the window as (0.5, 1.5], and every stage is read over that same window.
    let expected: [Stage: StagePercentileValue] = [
      .write: StagePercentileValue(p50: 50, p95: 50),
      .gate: StagePercentileValue(p50: 1, p95: 1),
    ]
    #expect(timer.percentiles(at: 1.2) == expected)
    #expect(timer.percentiles(at: 1.5) == expected)
  }

  @Test func nonFiniteQueriesGiveNothingAndDropNothing() {
    var timer = StageTimer()
    timer.add(.depth, ms: 8, at: 1)
    #expect(timer.percentiles(at: .infinity).isEmpty)
    #expect(timer.percentiles(at: -.infinity).isEmpty)
    #expect(timer.percentiles(at: .nan).isEmpty)
    #expect(timer.percentiles(at: 1) == [.depth: StagePercentileValue(p50: 8, p95: 8)])
  }

  @Test func badTimesAreIgnored() {
    var timer = StageTimer()
    timer.add(.detect, ms: -1, at: 1)
    timer.add(.detect, ms: .nan, at: 1)
    timer.add(.detect, ms: .infinity, at: 1)
    timer.add(.detect, ms: 4, at: .nan)
    #expect(timer.percentiles(at: 1).isEmpty)
    timer.add(.detect, ms: 0, at: 1)
    #expect(timer.percentiles(at: 1) == [.detect: StagePercentileValue(p50: 0, p95: 0)])
  }

  @Test func longRunsKeepOnlyTheWindow() {
    var timer = StageTimer()
    // Ten minutes of every stage at 60 Hz. Every frame takes 1000 ms except the last second's,
    // which take 1...60 ms, so a sample kept past its window shows in p50 and p95.
    let frames = 36_000
    for frame in 0..<frames {
      let t = Double(frame) / 60
      let ms = frame < frames - 60 ? 1000 : Double(frame % 60 + 1)
      for stage in Stage.allCases {
        timer.add(stage, ms: ms, at: t)
      }
    }
    // The buffers stay about a window (60 samples) plus the compaction threshold (256) long.
    for stage in Stage.allCases {
      #expect(timer.retainedCount(stage) <= 60 + 257)
    }
    let result = timer.percentiles(at: (Double(frames - 1) + 0.5) / 60)
    #expect(result.count == Stage.allCases.count)
    #expect(result.values.allSatisfy { $0 == StagePercentileValue(p50: 30, p95: 57) })
    for stage in Stage.allCases {
      #expect(timer.retainedCount(stage) <= 60 + 257)
    }
  }
}
