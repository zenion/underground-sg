import Testing

@testable import CaptureCore

/// Synthetic walks in the session frame: from Exit F's street door down to the B1 passage and
/// along it at 1.2 m/s, with stops. Times are seconds since the session started.
private typealias Position = (x: Double, y: Double, z: Double)

private let origin: Position = (0, 0, 0)

/// Walking along the passage (−z) at 1.2 m/s from `fromT`.
private func walking(_ t: Double, fromT: Double = 0) -> Position {
  (0, 0, -1.2 * (t - fromT))
}

/// Observes once a second from `from` through `through`, stopping once the window has closed.
private func observeEachSecond(
  _ window: inout RecorderWindow, from: Int, through: Int, position: (Double) -> Position
) {
  for second in from...through {
    let t = Double(second)
    window.observe(t: t, position: position(t))
    if !window.isRecording { return }
  }
}

/// The generated enum, switched over exhaustively: a new case in the schema fails to compile
/// here until WindowEndReason has it too.
private func mirrored(_ ended: RecordingEnded) -> WindowEndReason? {
  switch ended {
  case .background, .disk, .endAnchor, .heat, .idle, .interrupted, .limit, .stop:
    WindowEndReason(rawValue: ended.rawValue)
  }
}

@Suite struct RecorderWindowTests {
  @Test func reasonsMatchTheFormat() {
    let generated: [RecordingEnded] = [
      .background, .disk, .endAnchor, .heat, .idle, .interrupted, .limit, .stop,
    ]
    #expect(generated.allSatisfy { mirrored($0) != nil })
    #expect(WindowEndReason.allCases.count == generated.count)
    for reason in WindowEndReason.allCases {
      #expect(RecordingEnded(rawValue: reason.rawValue) != nil)
    }
    #expect(WindowEndReason.endAnchor.rawValue == "end_anchor")
  }

  @Test func provisionalValues() {
    let config = RecorderWindowConfig.provisional
    #expect(config.endMarginS == 5)
    #expect(config.idleTimeoutS == 300)
    #expect(config.idleRadiusM == 0.5)
    #expect(config.maxSessionS == 1800)
  }

  @Test func waitsForTheFirstStartAnchor() {
    var window = RecorderWindow()
    #expect(window.state == .waiting)
    #expect(!window.isRecording)
    #expect(!window.accepts(t: 0))
    // Observing before the window opens changes nothing.
    window.observe(t: 1, position: origin)
    #expect(window.state == .waiting)

    window.markAnchor(t: 12, role: .start)
    #expect(window.state == .open(startT: 12))
    #expect(window.isRecording)
    #expect(!window.accepts(t: 11.999))
    #expect(window.accepts(t: 12))
    #expect(window.accepts(t: 500))

    // A second start anchor doesn't move the start.
    window.markAnchor(t: 40, role: .start)
    #expect(window.state == .open(startT: 12))
  }

  @Test func anEndAnchorBeforeAnyStartOpensNothing() {
    var window = RecorderWindow()
    window.markAnchor(t: 3, role: .end, endSessionHere: true)
    #expect(window.state == .waiting)
    #expect(window.lastEndAnchorT == nil)
    window.markAnchor(t: 8, role: .start)
    #expect(window.state == .open(startT: 8))
    // The early end mark doesn't count when the session stops.
    window.stop(at: 60)
    #expect(window.state == .discarded)
  }

  @Test func marksAtTheSameTime() {
    var window = RecorderWindow()
    window.markAnchor(t: 10, role: .start)
    window.markAnchor(t: 10, role: .end, endSessionHere: true)
    #expect(window.state == .closing(startT: 10, deadlineT: 15))
    #expect(window.lastEndAnchorT == 10)
  }

  @Test func onlyTheLastEndAnchorCounts() {
    var window = RecorderWindow()
    window.markAnchor(t: 0, role: .start)
    window.markAnchor(t: 100, role: .end)
    window.markAnchor(t: 200, role: .end)
    #expect(window.state == .open(startT: 0))
    #expect(window.lastEndAnchorT == 200)
    window.stop(at: 400)
    #expect(window.state == .closed(startT: 0, endT: 205, reason: .stop, trimmed: true))
    #expect(!window.isRecording)
    #expect(window.accepts(t: 205))
    #expect(!window.accepts(t: 205.001))
  }

  @Test func stopExactlyAtTheMarginKeepsEverything() {
    var window = RecorderWindow()
    window.markAnchor(t: 0, role: .start)
    window.markAnchor(t: 300, role: .end)
    window.stop(at: 305)
    #expect(window.state == .closed(startT: 0, endT: 305, reason: .stop, trimmed: false))
  }

  @Test func stopWithinTheMarginEndsAtTheStop() {
    var window = RecorderWindow()
    window.markAnchor(t: 0, role: .start)
    window.markAnchor(t: 300, role: .end)
    window.stop(at: 302)
    #expect(window.state == .closed(startT: 0, endT: 302, reason: .stop, trimmed: false))
  }

  @Test func stopWithoutAnEndAnchorKeepsNothing() {
    var open = RecorderWindow()
    open.markAnchor(t: 0, role: .start)
    open.stop(at: 90)
    #expect(open.state == .discarded)
    #expect(!open.accepts(t: 45))

    var waiting = RecorderWindow()
    waiting.stop(at: 90)
    #expect(waiting.state == .discarded)
  }

  @Test func endTheSessionHereClosesAtTheDeadline() {
    var window = RecorderWindow()
    window.markAnchor(t: 0, role: .start)
    observeEachSecond(&window, from: 0, through: 40) { walking($0) }
    window.markAnchor(t: 40.5, role: .end, endSessionHere: true)
    #expect(window.state == .closing(startT: 0, deadlineT: 45.5))
    #expect(window.isRecording)
    #expect(window.accepts(t: 0))
    #expect(window.accepts(t: 45.5))
    #expect(!window.accepts(t: 45.501))
    #expect(!window.accepts(t: -0.001))

    window.observe(t: 45, position: walking(45))
    #expect(window.state == .closing(startT: 0, deadlineT: 45.5))
    window.observe(t: 46, position: walking(46))
    #expect(window.state == .closed(startT: 0, endT: 45.5, reason: .endAnchor, trimmed: false))
  }

  @Test func marksAfterEndTheSessionHereChangeNothing() {
    var window = RecorderWindow()
    window.markAnchor(t: 0, role: .start)
    window.markAnchor(t: 50, role: .end, endSessionHere: true)
    window.markAnchor(t: 51, role: .end, endSessionHere: true)
    window.markAnchor(t: 52, role: .start)
    #expect(window.state == .closing(startT: 0, deadlineT: 55))
    #expect(window.lastEndAnchorT == 50)

    window.observe(t: 56, position: origin)
    let closed = RecorderWindowState.closed(
      startT: 0, endT: 55, reason: .endAnchor, trimmed: false)
    #expect(window.state == closed)
    window.markAnchor(t: 57, role: .start)
    window.markAnchor(t: 58, role: .end, endSessionHere: true)
    window.observe(t: 59, position: walking(59))
    window.stop(at: 60)
    window.close(at: 61, reason: .heat)
    #expect(window.state == closed)
  }

  @Test func stopWhileClosing() {
    var early = RecorderWindow()
    early.markAnchor(t: 0, role: .start)
    early.markAnchor(t: 50, role: .end, endSessionHere: true)
    early.stop(at: 52)
    #expect(early.state == .closed(startT: 0, endT: 52, reason: .endAnchor, trimmed: false))

    // No frame was observed past the deadline before the stop.
    var late = RecorderWindow()
    late.markAnchor(t: 0, role: .start)
    late.markAnchor(t: 50, role: .end, endSessionHere: true)
    late.stop(at: 70)
    #expect(late.state == .closed(startT: 0, endT: 55, reason: .endAnchor, trimmed: false))
  }

  @Test func closeForOtherReasons() {
    var open = RecorderWindow()
    open.markAnchor(t: 0, role: .start)
    open.close(at: 120, reason: .background)
    #expect(open.state == .closed(startT: 0, endT: 120, reason: .background, trimmed: false))

    var closing = RecorderWindow()
    closing.markAnchor(t: 0, role: .start)
    closing.markAnchor(t: 100, role: .end, endSessionHere: true)
    closing.close(at: 103, reason: .heat)
    #expect(closing.state == .closed(startT: 0, endT: 103, reason: .heat, trimmed: false))

    // At or after the deadline it closed as End the session here.
    var atDeadline = RecorderWindow()
    atDeadline.markAnchor(t: 0, role: .start)
    atDeadline.markAnchor(t: 100, role: .end, endSessionHere: true)
    atDeadline.close(at: 105, reason: .disk)
    #expect(atDeadline.state == .closed(startT: 0, endT: 105, reason: .endAnchor, trimmed: false))

    var waiting = RecorderWindow()
    waiting.close(at: 5, reason: .interrupted)
    #expect(waiting.state == .discarded)
    waiting.markAnchor(t: 6, role: .start)
    #expect(waiting.state == .discarded)

    var twice = RecorderWindow()
    twice.markAnchor(t: 0, role: .start)
    twice.close(at: 30, reason: .limit)
    twice.close(at: 40, reason: .background)
    #expect(twice.state == .closed(startT: 0, endT: 30, reason: .limit, trimmed: false))
  }

  @Test func closeIgnoresTheReasonsOfOtherCalls() {
    var window = RecorderWindow()
    window.markAnchor(t: 0, role: .start)
    for reason in [WindowEndReason.endAnchor, .stop, .idle] {
      window.close(at: 30, reason: reason)
    }
    #expect(window.state == .open(startT: 0))

    var waiting = RecorderWindow()
    waiting.close(at: 30, reason: .stop)
    #expect(waiting.state == .waiting)
  }

  /// A fixed idle timeout, so these tests don't follow the provisional values.
  private let idle180 = RecorderWindowConfig(
    endMarginS: 5, idleTimeoutS: 180, idleRadiusM: 0.5, maxSessionS: 1800)

  @Test func idleClosesAfterTheTimeout() {
    var window = RecorderWindow(config: idle180)
    window.markAnchor(t: 10, role: .start)
    // Standing at the street door, ARKit jitter of 0.3 m: never out of the 0.5 m sphere.
    observeEachSecond(&window, from: 10, through: 400) { t in
      (Int(t) % 2 == 0 ? 0.3 : 0, 0, 0)
    }
    #expect(window.state == .closed(startT: 10, endT: 190, reason: .idle, trimmed: false))
    #expect(!window.accepts(t: 191))
  }

  @Test func movementResetsTheIdleTimeout() {
    var window = RecorderWindow(config: idle180)
    window.markAnchor(t: 0, role: .start)
    // Walks for 60 s, stands for 170 s, steps 0.6 m, stands again.
    observeEachSecond(&window, from: 0, through: 1000) { t in
      if t <= 60 { return walking(t) }
      let stop = walking(60)
      return t < 230 ? stop : (stop.x + 0.6, stop.y, stop.z)
    }
    // Idle counts from the step at 230.
    #expect(window.state == .closed(startT: 0, endT: 410, reason: .idle, trimmed: false))
  }

  @Test func idleWhileClosing() {
    let config = RecorderWindowConfig(
      endMarginS: 120, idleTimeoutS: 60, idleRadiusM: 0.5, maxSessionS: 1800)
    var window = RecorderWindow(config: config)
    window.markAnchor(t: 0, role: .start)
    observeEachSecond(&window, from: 0, through: 30) { walking($0) }
    window.markAnchor(t: 30, role: .end, endSessionHere: true)
    observeEachSecond(&window, from: 31, through: 200) { _ in walking(30) }
    #expect(window.state == .closed(startT: 0, endT: 90, reason: .idle, trimmed: false))

    // With the provisional margin the deadline comes first.
    var short = RecorderWindow()
    short.markAnchor(t: 0, role: .start)
    short.markAnchor(t: 30, role: .end, endSessionHere: true)
    observeEachSecond(&short, from: 30, through: 400) { _ in origin }
    #expect(short.state == .closed(startT: 0, endT: 35, reason: .endAnchor, trimmed: false))
  }

  @Test func theLongestSession() {
    var window = RecorderWindow()
    window.markAnchor(t: 20, role: .start)
    // Pacing up and down the passage, so never idle.
    observeEachSecond(&window, from: 20, through: 3000) { t in
      (0, 0, Int(t) % 2 == 0 ? 0 : -1.2)
    }
    #expect(window.state == .closed(startT: 20, endT: 1820, reason: .limit, trimmed: false))

    let dense = RecorderWindowConfig(
      endMarginS: 5, idleTimeoutS: 180, idleRadiusM: 0.5, maxSessionS: 600)
    var short = RecorderWindow(config: dense)
    short.markAnchor(t: 0, role: .start)
    observeEachSecond(&short, from: 0, through: 3000) { walking($0) }
    #expect(short.state == .closed(startT: 0, endT: 600, reason: .limit, trimmed: false))
  }

  @Test func theLimitWhileClosing() {
    var window = RecorderWindow()
    window.markAnchor(t: 0, role: .start)
    window.markAnchor(t: 1798, role: .end, endSessionHere: true)
    #expect(window.state == .closing(startT: 0, deadlineT: 1803))
    window.observe(t: 1801, position: origin)
    #expect(window.state == .closed(startT: 0, endT: 1800, reason: .limit, trimmed: false))
  }

  @Test func acceptsStopsAtTheLimitBeforeTheNextObserve() {
    // IMU samples at 100 Hz arrive between frames: the last observe was before the limit.
    var open = RecorderWindow()
    open.markAnchor(t: 0, role: .start)
    open.observe(t: 1799.9, position: origin)
    #expect(open.state == .open(startT: 0))
    #expect(open.accepts(t: 1800))
    #expect(!open.accepts(t: 1800.001))
    #expect(!open.accepts(t: 1800.5))

    // The End the session here deadline falls after the limit: the limit still bounds it.
    var closing = RecorderWindow()
    closing.markAnchor(t: 0, role: .start)
    closing.markAnchor(t: 1798, role: .end, endSessionHere: true)
    #expect(closing.state == .closing(startT: 0, deadlineT: 1803))
    #expect(closing.accepts(t: 1800))
    #expect(!closing.accepts(t: 1801))
    closing.observe(t: 1801, position: origin)
    #expect(closing.state == .closed(startT: 0, endT: 1800, reason: .limit, trimmed: false))
  }

  @Test func lateCallsNeverPassTheLimit() {
    var closed = RecorderWindow()
    closed.markAnchor(t: 0, role: .start)
    closed.close(at: 2000, reason: .background)
    #expect(closed.state == .closed(startT: 0, endT: 1800, reason: .limit, trimmed: false))

    var stopped = RecorderWindow()
    stopped.markAnchor(t: 0, role: .start)
    stopped.stop(at: 2000)
    #expect(stopped.state == .closed(startT: 0, endT: 1800, reason: .limit, trimmed: false))

    var marked = RecorderWindow()
    marked.markAnchor(t: 0, role: .start)
    marked.markAnchor(t: 1900, role: .end, endSessionHere: true)
    #expect(marked.state == .closed(startT: 0, endT: 1800, reason: .limit, trimmed: false))
    #expect(marked.lastEndAnchorT == nil)
  }

  @Test func recoverACutOffRecording() {
    let config = RecorderWindowConfig.provisional
    #expect(
      RecorderWindow.recover(startT: 4, lastEndAnchorT: 600, lastWrittenT: 900, config: config)
        == .closed(startT: 4, endT: 605, reason: .interrupted, trimmed: true))
    // Cut off within the margin: it ends at the last line written.
    #expect(
      RecorderWindow.recover(startT: 4, lastEndAnchorT: 600, lastWrittenT: 602, config: config)
        == .closed(startT: 4, endT: 602, reason: .interrupted, trimmed: true))
    #expect(
      RecorderWindow.recover(startT: 4, lastEndAnchorT: nil, lastWrittenT: 900, config: config)
        == .discarded)
    #expect(
      RecorderWindow.recover(startT: 4, lastEndAnchorT: 2, lastWrittenT: 900, config: config)
        == .discarded)
  }

  @Test func recoverWithNothingWrittenAfterTheStart() {
    let config = RecorderWindowConfig.provisional
    // Killed after the start and an end mark, before any line after the start was flushed.
    #expect(
      RecorderWindow.recover(startT: 100, lastEndAnchorT: 150, lastWrittenT: 90, config: config)
        == .discarded)
    #expect(
      RecorderWindow.recover(startT: 100, lastEndAnchorT: 150, lastWrittenT: 100, config: config)
        == .discarded)
    #expect(
      RecorderWindow.recover(startT: 100, lastEndAnchorT: 150, lastWrittenT: 100.5, config: config)
        == .closed(startT: 100, endT: 100.5, reason: .interrupted, trimmed: true))
  }
}
