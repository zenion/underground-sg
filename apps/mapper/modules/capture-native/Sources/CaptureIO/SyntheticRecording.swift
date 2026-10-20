#if USG_RECORDER
import CaptureCore
import Foundation

/// A SyntheticSession recorded through RecorderCore into a FileSink, as the module's host will
/// drive a real session (design D13 and D18): the commands applied in order, the watermark
/// flush every `tickS` and a checkpoint every `checkpointS` of session time, the sink's notices
/// passed back to the core, and the final boundary flush, or its wait expiring. The self-test
/// and capture-synth record through it; what it writes is `origin: synthetic`.
public enum SyntheticRecording {
  /// Records `session` and returns its recorder, closed when the sink finished. `observe` sees
  /// the sink after every step. With `interruptAtT`, the app "dies" at the first frame at or
  /// after that time: the sink is abandoned as a crash would leave it, and nothing more is
  /// written, so recovery has something to finish.
  @discardableResult
  public static func record(
    _ session: SyntheticSession, into sink: FileSink, tickS: Double = 1,
    checkpointS: Double = 5, interruptAtT: Double? = nil, observe: (FileSink) -> Void = { _ in }
  ) -> RecorderCore {
    let core = session.makeRecorder()
    var nextTick = -Double.infinity
    var nextCheckpoint = -Double.infinity
    var interrupted = false
    func handle(_ notices: [SinkNotice]) {
      for notice in notices {
        switch notice {
        case .closeRequested(let reason):
          handle(sink.apply(core.sinkLimitReached(reason)))
        case .finalized:
          core.finalizeCompleted()
        case .stopSession, .awaitingBoundary, .deleted, .failed:
          break
        }
      }
    }
    session.drive(core) { commands in
      guard !interrupted else { return }
      handle(sink.apply(commands))
      if let t = sink.latestFrameT {
        if let interruptAtT, t >= interruptAtT {
          sink.abandon()
          interrupted = true
          return
        }
        if t >= nextTick {
          handle(sink.tick())
          nextTick = t + tickS
        }
        if t >= nextCheckpoint {
          handle(sink.checkpoint())
          nextCheckpoint = t + checkpointS
        }
      }
      observe(sink)
    }
    if !interrupted && sink.state == .awaitingBoundary { handle(sink.boundaryWaitExpired()) }
    return core
  }
}
#endif
