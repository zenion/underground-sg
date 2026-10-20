#if USG_RECORDER
import Foundation

/// The window a recovered recording gets.
public struct RecoveredWindow: Equatable, Sendable {
  public let close: WindowClose
  /// recording.json's `closed`: true when the journal says the recorder closed it (design D2),
  /// false when recovery cut it back.
  public let closed: Bool

  /// Lines with `"final": true` go: a cut-back recording has no final sample (design 12).
  public var removesFinalLines: Bool { !closed }
}

/// What recovery at launch does with one recording (design 3.1 and 7.7). It only ever removes:
/// lines past the window, the final sample of a cut-back recording, or the whole recording.
public enum RecoveryPlan: Equatable, Sendable {
  /// The recorder closed it (a journaled `closed{}`): rehash, write recording.json with
  /// `closed: true`, protect, delete the journal.
  case finishClean(RecoveredWindow)
  /// Cut off: cut back to the last journaled end anchor plus the margin, as `interrupted` and
  /// trimmed, with `closed: false`; then as `finishClean`.
  case cut(RecoveredWindow)
  /// Delete the directory and the journal.
  case discard
  /// recording.json is already final: only protect the files and delete any journal.
  case sweepOnly

  /// The plan from the journal (nil when there is none) and recording.json's bytes (nil when
  /// missing). `lastWrittenT` is the latest `t` of a valid line across the files, from
  /// RecoveryScan, or nil when nothing was written.
  ///
  /// - No journal (design D3): a recording.json whose `window.ended` is set was finished, so
  ///   only the protection sweep runs; a null `ended` or an unreadable file means the open was
  ///   never journaled, so it goes.
  /// - A `discard` record wins, then `manifest` (finished but for the sweep), then `closed{}`.
  /// - Otherwise the recording was cut off: `RecorderWindow.recover` with the journaled start,
  ///   the last journaled end anchor and the margin the session ran with. Without an end anchor,
  ///   or with nothing written after the start, it goes.
  public static func make(
    journal: JournalSummary?, recordingJson: Data?, lastWrittenT: Double?
  ) -> RecoveryPlan {
    guard let journal else {
      return windowEnded(recordingJson) ? .sweepOnly : .discard
    }
    if journal.discarded { return .discard }
    if journal.manifestWritten { return .sweepOnly }
    guard let open = journal.open else { return .discard }
    if let closed = journal.closed {
      return .finishClean(
        RecoveredWindow(
          close: WindowClose(
            startT: open.startT, endT: closed.endT, reason: closed.reason,
            trimmed: closed.trimmed, finalSample: closed.finalSample),
          closed: true))
    }
    guard let lastWrittenT else { return .discard }
    let config = RecorderWindowConfig(
      endMarginS: max(0, open.marginS), idleTimeoutS: max(open.idleS, 1),
      idleRadiusM: RecorderWindowConfig.provisional.idleRadiusM, maxSessionS: max(open.maxS, 1))
    let state = RecorderWindow.recover(
      startT: open.startT, lastEndAnchorT: journal.lastEndT, lastWrittenT: lastWrittenT,
      config: config)
    guard case .closed(let startT, let endT, let reason, let trimmed) = state else {
      return .discard
    }
    return .cut(
      RecoveredWindow(
        close: WindowClose(
          startT: startT, endT: endT, reason: reason, trimmed: trimmed, finalSample: false),
        closed: false))
  }

  private static func windowEnded(_ recordingJson: Data?) -> Bool {
    guard let recordingJson,
      let manifest = try? JSONDecoder().decode(RecordingManifest.self, from: recordingJson)
    else { return false }
    return manifest.window.ended != nil
  }
}
#endif
