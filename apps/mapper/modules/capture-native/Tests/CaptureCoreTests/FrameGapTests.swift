import Foundation
import Testing

@testable import CaptureCore

/// Frame times as ARKit stamps them at 60 fps, some seconds into a session.
private func t60(_ frame: Int) -> Double { 12.345 + Double(frame) / 60 }

@Suite struct FrameGapTests {
  @Test func firstFrameHasNoGap() {
    #expect(framesSkipped(previousT: nil, t: 3.2, fps: 60) == 0)
  }

  @Test func consecutiveFramesSkipNothing() {
    var previous: Double?
    for frame in 0..<6000 {
      let t = t60(frame)
      #expect(framesSkipped(previousT: previous, t: t, fps: 60) == 0)
      previous = t
    }
  }

  @Test func accumulatedTimesSkipNothing() {
    // Times built by adding 1/60 again and again drift in the last bits.
    var t = 100.0
    for _ in 0..<6000 {
      let next = t + 1.0 / 60
      #expect(framesSkipped(previousT: t, t: next, fps: 60) == 0)
      t = next
    }
  }

  @Test func missingFramesAreCounted() {
    #expect(framesSkipped(previousT: t60(10), t: t60(12), fps: 60) == 1)
    #expect(framesSkipped(previousT: t60(10), t: t60(13), fps: 60) == 2)
    #expect(framesSkipped(previousT: t60(0), t: t60(60), fps: 60) == 59)
    #expect(framesSkipped(previousT: t60(0), t: t60(2), fps: 30) == 0)
  }

  @Test func jitterIsRounded() {
    let step = 1.0 / 60
    #expect(framesSkipped(previousT: 1, t: 1 + step * 1.4, fps: 60) == 0)
    #expect(framesSkipped(previousT: 1, t: 1 + step * 0.6, fps: 60) == 0)
    #expect(framesSkipped(previousT: 1, t: 1 + step * 1.6, fps: 60) == 1)
    #expect(framesSkipped(previousT: 1, t: 1 + step * 2.4, fps: 60) == 1)
  }

  @Test func badInputsGiveZero() {
    #expect(framesSkipped(previousT: 2, t: 2, fps: 60) == 0)
    #expect(framesSkipped(previousT: 2, t: 1, fps: 60) == 0)
    #expect(framesSkipped(previousT: .nan, t: 1, fps: 60) == 0)
    #expect(framesSkipped(previousT: 1, t: .infinity, fps: 60) == 0)
    #expect(framesSkipped(previousT: 1, t: 2, fps: 0) == 0)
    #expect(framesSkipped(previousT: 1, t: 2, fps: -60) == 0)
    #expect(framesSkipped(previousT: 0, t: 1e300, fps: 60) == 0)
  }
}
