import Foundation
import Testing

@testable import CaptureCore

/// Synthetic camera paths at 60 Hz: walking along the Exit G passage at 1.2 m/s, standing still,
/// turning on the spot. Values are in the session frame, so no real coordinates are needed.
private let frameInterval = 1.0 / 60

private func run(
  _ gate: inout CandidateGate, frames: Int, tracking: (Int) -> Bool = { _ in true },
  forceAt: Set<Int> = [], pose: (Double) -> WorldTransform
) -> [(frame: Int, trigger: CandidateTrigger)] {
  var out: [(Int, CandidateTrigger)] = []
  for frame in 0..<frames {
    if forceAt.contains(frame) { gate.force() }
    let t = Double(frame) * frameInterval
    if let trigger = gate.offer(t: t, transform: pose(t), trackingNormal: tracking(frame)) {
      out.append((frame, trigger))
    }
  }
  return out
}

@Suite struct CandidateGateTests {
  @Test func walkingIsCappedAtTheCandidateRate() {
    var gate = CandidateGate()
    // 1.2 m/s crosses 0.15 m every 7.5 frames, faster than 5 Hz allows: one candidate every
    // 12 frames (0.2 s, 0.24 m).
    let candidates = run(&gate, frames: 600) { t in .yaw(0, z: -1.2 * t) }
    #expect(candidates.first?.frame == 0)
    #expect(candidates.first?.trigger == .first)
    #expect(candidates.count == 50)
    let gaps = zip(candidates.dropFirst(), candidates).map { $0.frame - $1.frame }
    #expect(gaps.allSatisfy { $0 == 12 })
    #expect(candidates.dropFirst().allSatisfy { $0.trigger == .moved })
  }

  @Test func slowWalkingIsGatedByDistance() {
    var gate = CandidateGate()
    // 0.29 m/s: 0.15 m takes 31.03 frames, so every 32nd frame. (A speed that lands exactly on
    // the threshold would make each step a coin toss in float32.)
    let candidates = run(&gate, frames: 321) { t in .yaw(0, x: 0.29 * t) }
    #expect(candidates.map(\.frame) == Array(stride(from: 0, through: 320, by: 32)))
  }

  @Test func standingStillGivesOnlyTheFirst() {
    var gate = CandidateGate()
    let candidates = run(&gate, frames: 300) { _ in .yaw(0.3, x: 2, y: 1.5, z: -4) }
    #expect(candidates.map(\.frame) == [0])
  }

  @Test func turningOnTheSpotIsGatedByAngle() {
    var gate = CandidateGate()
    // 9.5°/s: 5° takes 31.6 frames, so every 32nd frame.
    let candidates = run(&gate, frames: 193) { t in .yaw(t * 9.5 * Double.pi / 180) }
    #expect(candidates.map(\.frame) == Array(stride(from: 0, through: 192, by: 32)))
    #expect(candidates.dropFirst().allSatisfy { $0.trigger == .turned })
  }

  @Test func forcedFramesIgnoreMotionRateAndTracking() {
    var gate = CandidateGate()
    let candidates = run(
      &gate, frames: 120, tracking: { $0 < 60 }, forceAt: [3, 4, 90]
    ) { _ in .identity }
    #expect(candidates.map(\.frame) == [0, 3, 4, 90])
    #expect(candidates.map(\.trigger) == [.first, .forced, .forced, .forced])
  }

  @Test func limitedTrackingGivesNoCandidates() {
    var gate = CandidateGate()
    // Tracking is limited for the first second; the first candidate comes when it is normal.
    let candidates = run(&gate, frames: 120, tracking: { $0 >= 60 }) { t in .yaw(0, z: -1.2 * t) }
    #expect(candidates.first?.frame == 60)
    #expect(candidates.first?.trigger == .first)
  }

  @Test func aForcedFrameRestartsTheMotionAndRateCount() {
    var gate = CandidateGate()
    let candidates = run(&gate, frames: 40, forceAt: [10]) { t in .yaw(0, z: -1.2 * t) }
    // 0, then forced at 10, then 12 frames after the forced one.
    #expect(candidates.map(\.frame) == [0, 10, 22, 34])
  }
}

@Suite struct WorldTransformTests {
  @Test func distanceAndRotation() {
    let a = WorldTransform.yaw(0, x: 1, y: 2, z: 3)
    let b = WorldTransform.yaw(Double.pi / 2, x: 4, y: 6, z: 3)
    #expect(abs(a.distance(to: b) - 5) < 1e-6)
    #expect(abs(a.rotationDegrees(to: b) - 90) < 1e-3)
    #expect(a.rotationDegrees(to: a) == 0)
    #expect(abs(WorldTransform.identity.rotationDegrees(to: .yaw(Double.pi)) - 180) < 1e-3)
  }
}

@Suite struct RateMeterTests {
  @Test func countsOverTheWindow() {
    var meter = RateMeter(window: 1)
    for frame in 0..<600 { meter.tick(Double(frame) / 60) }
    #expect(meter.rate(at: 599.0 / 60) == 60)
    // Half a second later, half the window is empty.
    #expect(meter.rate(at: 599.0 / 60 + 0.5) == 30)
    #expect(meter.rate(at: 100) == 0)
  }
}
