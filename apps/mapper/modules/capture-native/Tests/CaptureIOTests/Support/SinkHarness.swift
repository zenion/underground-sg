#if USG_RECORDER
import CaptureCore
import Foundation

@testable import CaptureIO

// The recorder's files on a temporary directory (design 14): a store over the phone's layout
// there, with the recording FileSecurity fake, a small ballast and plenty of free space, and
// drivers for synthetic sessions that end in the ways the walk can.

/// A phone's Application Support and Documents in a temporary directory.
final class StoreFixture: @unchecked Sendable {
  let directory: TemporaryDirectory
  let security = RecordingFileSecurity()
  let paths: RecordingPaths
  var freeBytes: Int64 = 1 << 40

  init() throws {
    directory = try TemporaryDirectory()
    paths = RecordingPaths(
      applicationSupport: directory.url.appendingPathComponent("Library/Application Support"),
      documents: directory.url.appendingPathComponent("Documents"))
  }

  /// A store as one launch of the app makes it. Each call is a new launch: no busy flags.
  func store() -> RecordingStore {
    RecordingStore(
      paths: paths, security: security, ballastBytes: 1 << 20,
      freeSpace: FreeSpaceProbe { [unowned self] _ in self.freeBytes })
  }

  /// A file's bytes by its path in `rec-<id>/`.
  func file(_ path: String, of id: UUID) -> Data? {
    FileManager.default.contents(
      atPath: paths.recording(id).appendingPathComponent(path).path)
  }

  /// Every file in `rec-<id>/`, by path.
  func files(of id: UUID) -> [String: Data] {
    var out: [String: Data] = [:]
    for file in store().files(in: paths.recording(id)) {
      out[file.path] = self.file(file.path, of: id)
    }
    return out
  }

  func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }

  /// The names in a directory, sorted; none when it doesn't exist.
  func names(_ url: URL) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? []).sorted()
  }
}

/// The same session recorded into a MemorySink with CaptureIO's SHA-256 and DEFLATE: the
/// reference a FileSink's files must equal byte for byte.
func memoryRecording(_ session: SyntheticSession) -> MemorySink {
  let core = session.makeRecorder()
  let sink = MemorySink(digest: { Sha256Stream.hex(of: $0) }, deflate: Deflate.raw)
  session.drive(core) { sink.apply($0) }
  sink.boundaryWaitExpired()
  return sink
}

/// How a scripted session ends.
enum Ending {
  /// The synthetic session as made: End the session here at the end mark.
  case endTheSessionHere
  /// The end mark without End the session here, then `stop` at `stopT`: cut back on disk.
  case stop(at: Double)
}

/// Drives `session` into `apply` as the module would, with the session's end changed to
/// `ending`, ticking `tick` every `tickS` of frame time (never for nil). Boundary lines are left
/// out, so a foreground close waits for its flush until the caller expires it. Returns the core.
@discardableResult
func driveScripted(
  _ session: SyntheticSession, ending: Ending, tickS: Double?,
  apply: ([SinkCommand]) -> Void, tick: () -> Void
) -> RecorderCore {
  let core = session.makeRecorder()
  var lastFrameT = 0.0
  var nextTick = 0.0
  for step in session.steps() {
    var commands: [SinkCommand] = []
    var stopNow = false
    switch step {
    case .frame(let sample, let position):
      lastFrameT = sample.t
      commands = core.frame(sample, position: position) { session.reading(at: sample.t, $0) }
      if case .stop(let stopT) = ending, sample.t >= stopT { stopNow = true }
    case .mark(var mark):
      if case .stop = ending { mark.endSessionHere = false }
      let t = lastFrameT
      commands = core.mark(mark) { session.reading(at: t, $0) }
    case .imu(let batch): commands = core.imu(batch)
    case .motion(let batch): commands = core.motion(batch)
    case .altitude(let sample): commands = core.altitude(sample)
    case .gnss(let fix): commands = core.gnss(fix)
    case .telemetry(let sample): commands = core.telemetry(sample)
    case .event(let event, let t): commands = core.event(event, t: t)
    case .action(let action): commands = core.action(action)
    case .meshUpdated(let id): core.meshUpdated(id)
    case .meshRemoved(let id): core.meshRemoved(id)
    case .boundaryEvent, .boundaryFlush: break
    }
    apply(commands)
    if stopNow {
      let t = lastFrameT
      apply(core.stopRequested(frameT: t) { session.reading(at: t, $0) })
      break
    }
    if let tickS, lastFrameT >= nextTick {
      tick()
      nextTick = lastFrameT + tickS
    }
    if case .finalizing = core.phase { break }
  }
  return core
}
#endif
