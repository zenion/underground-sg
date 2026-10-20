#if USG_RECORDER
// The recording window (ADR 0010, "When a recording runs"; docs/session-recording.md): when a
// session's recording opens, when it closes, and how it is cut back. Nothing outside the window
// is written, so the recorder asks `accepts(t:)` before writing a sample. Sessions start and
// stop at a public anchor, so the window opens at the first start-anchor mark and, when the
// session just stops, keeps only what ends at an end anchor plus the margin.
//
// Times are seconds since the ARKit session started. Positions are metres in the session frame.
//
// | State     | Event                                | Next                                      |
// | --------- | ------------------------------------ | ----------------------------------------- |
// | waiting   | start mark at t                      | open(t)                                   |
// | waiting   | end mark                             | waiting (no change)                       |
// | waiting   | `stop` or `close`                    | discarded                                 |
// | open      | end mark                             | open; the mark is the last end anchor     |
// | open      | end mark with End the session here   | closing(deadline: t + endMarginS)         |
// | open      | still for idleTimeoutS               | closed(end: t, idle)                      |
// | open      | open for maxSessionS                 | closed(end: start + maxSessionS, limit)   |
// | open      | `close(reason)`                      | closed(end: t, reason)                    |
// | open      | `stop` with an end anchor            | closed(end: min(t, end + margin), stop) * |
// | open      | `stop` without an end anchor         | discarded                                 |
// | closing   | the deadline                         | closed(end: deadline, end_anchor)         |
// | closing   | idle or limit before the deadline    | closed(end: as above, idle or limit)      |
// | closing   | `close(reason)` before the deadline  | closed(end: t, reason)                    |
// | closing   | `stop` before the deadline           | closed(end: t, end_anchor)                |
// | closing   | any mark                             | closing (no change)                       |
// | closed    | anything                             | closed (no change)                        |
// | discarded | anything                             | discarded (no change)                     |
//
// * trimmed when the cut dropped a tail. Before handling a mark, `close` or `stop`, the window
// first applies the deadline and the limit as `observe` would have, so a late call never
// stretches the window past either. `accepts` already applies the limit while the window is open
// or closing, since it is known from the start. `recover` discards a cut-off recording that has
// no end anchor or nothing written after its start.

/// The window's settings. The idle timeout and the margin are open points the Phase 1 spike
/// settles (docs/session-recording.md, "Open points").
public struct RecorderWindowConfig: Equatable, Sendable {
  /// Seconds kept after the last end anchor: after End the session here, and when a stopped or
  /// cut-off recording is cut back.
  public var endMarginS: Double
  /// Seconds without movement before the recording closes as idle.
  public var idleTimeoutS: Double
  /// Moving less than this many metres from where the phone last moved doesn't count as
  /// movement, so ARKit's jitter and a phone held still never reset the idle timeout.
  public var idleRadiusM: Double
  /// The longest window, `maxSessionSeconds` in docs/session-recording.md.
  public var maxSessionS: Double

  public init(endMarginS: Double, idleTimeoutS: Double, idleRadiusM: Double, maxSessionS: Double) {
    precondition(endMarginS >= 0 && idleTimeoutS > 0 && idleRadiusM > 0 && maxSessionS > 0)
    self.endMarginS = endMarginS
    self.idleTimeoutS = idleTimeoutS
    self.idleRadiusM = idleRadiusM
    self.maxSessionS = maxSessionS
  }

  /// Starting values: a 5 s margin, 5 minutes idle within half a metre (so a wait at a gate
  /// doesn't close a leg), and 30 minutes at
  /// most. The spike sets the real ones. A `dense` recording passes `maxSessionS` 600.
  public static let provisional = RecorderWindowConfig(
    endMarginS: 5, idleTimeoutS: 300, idleRadiusM: 0.5, maxSessionS: 1800)
}

/// Why a recording closed: `window.ended` in recording.json and the `recording_closed` event.
/// The raw values are the format's.
public enum WindowEndReason: String, CaseIterable, Sendable {
  /// End the session here, a margin after the end anchor.
  case endAnchor = "end_anchor"
  /// The session stopped while the window was open.
  case stop
  /// No movement for the idle timeout.
  case idle
  /// The app left the foreground, a locked screen included.
  case background
  case heat
  case disk
  /// A recording limit: the longest session, or a size limit.
  case limit
  /// Cut off, found at the next launch.
  case interrupted
}

/// Which kind of anchor the owner marked.
public enum AnchorMarkRole: Sendable {
  case start
  case end
}

/// Where the window is. Holds times only: the module writes them to recording.json, and
/// never logs them.
public enum RecorderWindowState: Equatable, Sendable {
  /// No start anchor yet; nothing is recorded.
  case waiting
  case open(startT: Double)
  /// End the session here was chosen; the window closes at `deadlineT`.
  case closing(startT: Double, deadlineT: Double)
  /// `trimmed` is true when the tail after the last end anchor plus the margin was cut off.
  case closed(startT: Double, endT: Double, reason: WindowEndReason, trimmed: Bool)
  /// Nothing of the session is kept: it never opened, or it didn't end at an end anchor.
  case discarded
}

public struct RecorderWindow: Sendable {
  public let config: RecorderWindowConfig
  public private(set) var state: RecorderWindowState = .waiting
  /// The last end anchor marked while the window was open. The module keeps it with the
  /// recording, so `recover` can cut back a recording found cut off at the next launch.
  public private(set) var lastEndAnchorT: Double?
  /// Where the phone last moved, and when. Idle counts from here.
  private var idleReference: (position: (x: Double, y: Double, z: Double), t: Double)?

  public init(config: RecorderWindowConfig = .provisional) {
    self.config = config
  }

  /// True while samples are being written: open or closing.
  public var isRecording: Bool {
    switch state {
    case .open, .closing: true
    case .waiting, .closed, .discarded: false
    }
  }

  /// The owner marked an anchor at `t`. The first start anchor opens the window. An end anchor
  /// while open becomes the last end anchor, and with `endSessionHere` the window closes
  /// `endMarginS` later. An end anchor before any start anchor opens nothing, and marks after
  /// End the session here change nothing.
  public mutating func markAnchor(t: Double, role: AnchorMarkRole, endSessionHere: Bool = false) {
    expire(at: t)
    switch (state, role) {
    case (.waiting, .start):
      state = .open(startT: t)
    case (.open(let startT), .end):
      // A mark from before the window opened can't end it.
      guard t >= startT else { return }
      lastEndAnchorT = t
      if endSessionHere {
        state = .closing(startT: startT, deadlineT: t + config.endMarginS)
      }
    default:
      break
    }
  }

  /// The phone is at `position` at `t`. Call it with each frame, or at least once a second,
  /// while the session runs: it closes the window at the End the session here deadline, at the
  /// longest session and after the idle timeout, whichever comes first.
  public mutating func observe(t: Double, position: (x: Double, y: Double, z: Double)) {
    expire(at: t)
    guard let startT = state.liveStartT else { return }
    if let reference = idleReference {
      if distance(position, reference.position) > config.idleRadiusM {
        idleReference = (position, t)
      } else if t - reference.t >= config.idleTimeoutS {
        state = .closed(startT: startT, endT: t, reason: .idle, trimmed: false)
      }
    } else {
      // The first position seen since the window opened.
      idleReference = (position, t)
    }
  }

  /// Closes the window at `t` for `background`, `heat`, `disk`, `limit` or `interrupted`. A
  /// window that never opened is discarded. `endAnchor`, `stop` and `idle` are ignored: they
  /// come only from `markAnchor`, `stop` and `observe`, and a wrong call mustn't crash a walk.
  public mutating func close(at t: Double, reason: WindowEndReason) {
    switch reason {
    case .endAnchor, .stop, .idle: return
    case .background, .heat, .disk, .limit, .interrupted: break
    }
    expire(at: t)
    switch state {
    case .waiting:
      state = .discarded
    case .open(let startT), .closing(let startT, _):
      state = .closed(startT: startT, endT: t, reason: reason, trimmed: false)
    case .closed, .discarded:
      break
    }
  }

  /// The session stopped at `t`. An open window is cut back to its last end anchor plus the
  /// margin; without an end anchor the walk didn't end at a public anchor, so nothing of it is
  /// kept. A closing window closes as End the session here, at `t` if that comes first.
  public mutating func stop(at t: Double) {
    expire(at: t)
    switch state {
    case .waiting:
      state = .discarded
    case .closing(let startT, _):
      state = .closed(startT: startT, endT: t, reason: .endAnchor, trimmed: false)
    case .open(let startT):
      guard let lastEnd = lastEndAnchorT else {
        state = .discarded
        return
      }
      let cut = lastEnd + config.endMarginS
      state = .closed(startT: startT, endT: min(t, cut), reason: .stop, trimmed: cut < t)
    case .closed, .discarded:
      break
    }
  }

  /// The window of a recording found cut off at the next launch, from what the module kept: it
  /// is cut back to its last end anchor plus the margin, or discarded without one. Its last
  /// lines may be partial, so it always counts as trimmed. `lastWrittenT` is the time of the
  /// last complete line on disk. A recording with nothing written after its start is discarded:
  /// its window would hold nothing, or end before it starts.
  public static func recover(
    startT: Double, lastEndAnchorT: Double?, lastWrittenT: Double,
    config: RecorderWindowConfig = .provisional
  ) -> RecorderWindowState {
    guard let lastEnd = lastEndAnchorT, lastEnd >= startT else { return .discarded }
    let endT = min(lastWrittenT, lastEnd + config.endMarginS, startT + config.maxSessionS)
    guard endT > startT else { return .discarded }
    return .closed(startT: startT, endT: endT, reason: .interrupted, trimmed: true)
  }

  /// Whether a sample at `t` belongs in the window as known now. Samples are written only when
  /// this holds, so nothing from before the start anchor or after the close reaches the files.
  /// The longest session is fixed when the window opens, so an open or closing window already
  /// refuses samples past it, even between frames before `observe` closes the window.
  public func accepts(t: Double) -> Bool {
    switch state {
    case .waiting, .discarded:
      false
    case .open(let startT):
      t >= startT && t <= startT + config.maxSessionS
    case .closing(let startT, let deadlineT):
      t >= startT && t <= min(deadlineT, startT + config.maxSessionS)
    case .closed(let startT, let endT, _, _):
      t >= startT && t <= endT
    }
  }

  /// Closes the window at the End the session here deadline or the longest session, if `t` has
  /// reached either, whichever comes first (the deadline on a tie).
  private mutating func expire(at t: Double) {
    guard let startT = state.liveStartT else { return }
    let limitT = startT + config.maxSessionS
    if case .closing(_, let deadlineT) = state, t >= deadlineT, deadlineT <= limitT {
      state = .closed(startT: startT, endT: deadlineT, reason: .endAnchor, trimmed: false)
    } else if t >= limitT {
      state = .closed(startT: startT, endT: limitT, reason: .limit, trimmed: false)
    }
  }
}

extension RecorderWindowState {
  /// The start of an open or closing window.
  fileprivate var liveStartT: Double? {
    switch self {
    case .open(let startT), .closing(let startT, _): startT
    case .waiting, .closed, .discarded: nil
    }
  }
}

private func distance(
  _ a: (x: Double, y: Double, z: Double), _ b: (x: Double, y: Double, z: Double)
) -> Double {
  let dx = a.x - b.x
  let dy = a.y - b.y
  let dz = a.z - b.z
  return (dx * dx + dy * dy + dz * dz).squareRoot()
}

#endif
