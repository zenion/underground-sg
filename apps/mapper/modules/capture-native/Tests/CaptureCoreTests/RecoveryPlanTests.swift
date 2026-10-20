#if USG_RECORDER
import Foundation
import Testing

@testable import CaptureCore

// RecoveryPlan for every journal shape (design 3.1 and 7.7), D3's rules for a recording without
// a journal, and recovery end to end on a MemorySink's files cut off mid-recording.

private let open = JournalOpen(
  id: recordingUUID, startT: 3.2, profile: .lean, marginS: 5, idleS: 300, maxS: 1800)

private func recordingJson(ended: WindowEndReason?) throws -> Data {
  let opening = try RecordingDocuments.opening(
    id: recordingUUID, base: deviceManifestBase(), profile: .lean, venues: [], startT: 3.2)
  guard let ended else { return opening }
  return try RecordingDocuments.closed(
    opening: opening,
    window: WindowClose(startT: 3.2, endT: 50, reason: ended, trimmed: false, finalSample: false),
    rates: nil, files: [], closed: true)
}

@Suite struct RecoveryPlanTests {
  @Test func withoutAJournalAFinishedRecordingIsOnlySwept() throws {
    // D3: a recovered recording is never deleted at a later launch.
    for ended in [WindowEndReason.interrupted, .endAnchor, .background] {
      #expect(
        RecoveryPlan.make(
          journal: nil, recordingJson: try recordingJson(ended: ended), lastWrittenT: 40)
          == .sweepOnly)
    }
  }

  @Test func withoutAJournalAnUnfinishedOrUnreadableRecordingGoes() throws {
    #expect(
      RecoveryPlan.make(
        journal: nil, recordingJson: try recordingJson(ended: nil), lastWrittenT: 40) == .discard)
    #expect(
      RecoveryPlan.make(journal: nil, recordingJson: Data("{\"window\":".utf8), lastWrittenT: 40)
        == .discard)
    #expect(RecoveryPlan.make(journal: nil, recordingJson: nil, lastWrittenT: nil) == .discard)
  }

  @Test func aDiscardRecordWinsThenTheManifestThenClosed() {
    let closed = JournalRecord.closed(
      JournalClosed(endT: 40, reason: .stop, trimmed: true, finalSample: false))
    #expect(
      RecoveryPlan.make(
        journal: JournalSummary([.open(open), closed, .manifest, .discard]), recordingJson: nil,
        lastWrittenT: 40) == .discard)
    #expect(
      RecoveryPlan.make(
        journal: JournalSummary([.open(open), closed, .manifest, .protectionPending]),
        recordingJson: nil, lastWrittenT: 40) == .sweepOnly)
    #expect(
      RecoveryPlan.make(
        journal: JournalSummary([.open(open), .end(t: 35), closed]), recordingJson: nil,
        lastWrittenT: 41)
        == .finishClean(
          RecoveredWindow(
            close: WindowClose(
              startT: 3.2, endT: 40, reason: .stop, trimmed: true, finalSample: false),
            closed: true)))
  }

  @Test func aJournaledCloseKeepsItsFinalSample() throws {
    let summary = JournalSummary([
      .open(open), .end(t: 30), .closing(deadline: 35),
      .closed(
        JournalClosed(endT: 34.983333, reason: .endAnchor, trimmed: false, finalSample: true)),
    ])
    guard
      case .finishClean(let window) = RecoveryPlan.make(
        journal: summary, recordingJson: nil, lastWrittenT: 34.983333)
    else {
      Issue.record("a journaled close finishes cleanly")
      return
    }
    #expect(window.closed)
    #expect(window.close.finalSample)
    #expect(!window.removesFinalLines)
    #expect(!window.removesClosedEvent)
  }

  @Test func aCutOffRecordingIsCutBackToTheLastEndAnchorPlusTheMargin() {
    let summary = JournalSummary([
      .open(open), .end(t: 20), .checkpoint(JournalCheckpoint(seq: 3, sizes: [:], binBytes: 0)),
      .end(t: 30),
    ])
    let cut = RecoveryPlan.make(journal: summary, recordingJson: nil, lastWrittenT: 48)
    let expected = RecoveredWindow(
      close: WindowClose(
        startT: 3.2, endT: 35, reason: .interrupted, trimmed: true, finalSample: false),
      closed: false)
    #expect(cut == .cut(expected))
    #expect(expected.removesFinalLines)
    #expect(expected.removesClosedEvent)
    // Written up to before the margin ended: cut at the last line.
    #expect(
      RecoveryPlan.make(journal: summary, recordingJson: nil, lastWrittenT: 32)
        == .cut(
          RecoveredWindow(
            close: WindowClose(
              startT: 3.2, endT: 32, reason: .interrupted, trimmed: true, finalSample: false),
            closed: false)))
  }

  @Test func theMarginIsTheOneTheSessionRanWith() {
    var wide = open
    wide.marginS = 8
    let plan = RecoveryPlan.make(
      journal: JournalSummary([.open(wide), .end(t: 30)]), recordingJson: nil, lastWrittenT: 60)
    guard case .cut(let window) = plan else {
      Issue.record("cut")
      return
    }
    #expect(window.close.endT == 38)
  }

  @Test func withoutAnEndAnchorOrAnythingWrittenItGoes() {
    #expect(
      RecoveryPlan.make(
        journal: JournalSummary([.open(open)]), recordingJson: nil, lastWrittenT: 40) == .discard)
    // An end anchor from before the start doesn't count.
    #expect(
      RecoveryPlan.make(
        journal: JournalSummary([.open(open), .end(t: 2)]), recordingJson: nil, lastWrittenT: 40)
        == .discard)
    #expect(
      RecoveryPlan.make(
        journal: JournalSummary([.open(open), .end(t: 20)]), recordingJson: nil, lastWrittenT: nil)
        == .discard)
    #expect(
      RecoveryPlan.make(
        journal: JournalSummary([.open(open), .end(t: 20)]), recordingJson: nil, lastWrittenT: 3.2)
        == .discard)
    // A journal whose open record was torn.
    #expect(
      RecoveryPlan.make(journal: JournalSummary([]), recordingJson: nil, lastWrittenT: 40)
        == .discard)
    #expect(
      RecoveryPlan.make(
        journal: JournalSummary([.end(t: 20)]), recordingJson: nil, lastWrittenT: 40) == .discard)
  }

  /// A walk cut off after End the session here's final sample and closing lines were written
  /// but before the close was journaled: recovery cuts it back to the end anchor plus the
  /// margin, removes the final lines and the `recording_closed` event, and keeps nothing past
  /// the cut (design 12).
  @Test func recoveryOfACutOffRecordingRemovesOnlyLines() throws {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 9.99)
    h.mark(.end, at: 10, endSessionHere: true)
    h.frames(from: 10.0167, to: 12)
    h.sink.checkpoint()
    h.frames(from: 12.0167, to: 15.2)
    #expect(h.sink.state == .awaitingBoundary)
    // The crash: the files as they are, and the journal without its closed record, as FileSink
    // leaves them between the writers' last flush and the journal's write.
    let records = Journal.decode(h.sink.journalBytes).records.filter {
      if case .closed = $0 { false } else { true }
    }
    let summary = JournalSummary(records)
    let paths = h.sink.paths.filter { $0.hasSuffix(".jsonl") && $0 != "mesh/history.jsonl" }
    #expect(try h.decode("events.jsonl", as: RecordingEventLine.self).last?.detail == "end_anchor")
    let lastWrittenT = paths.compactMap { RecoveryScan.jsonl(h.sink.file($0)!).lastT }.max()
    let plan = RecoveryPlan.make(
      journal: summary, recordingJson: h.sink.recordingJson, lastWrittenT: lastWrittenT)
    guard case .cut(let window) = plan else {
      Issue.record("a cut-off recording with an end anchor is cut back")
      return
    }
    #expect(window.close.endT == 14.983333)
    for path in paths {
      let data = h.sink.file(path)!
      let scan = RecoveryScan.jsonl(
        data, cutT: window.close.endT, dropFinal: window.removesFinalLines,
        dropClosedEvent: path == "events.jsonl" && window.removesClosedEvent)
      let kept = data.prefix(scan.keepBytes)
      #expect(data.starts(with: kept))
      let times = try kept.split(separator: 0x0A).map {
        try JSONDecoder().decode(Timed.self, from: Data($0))
      }
      #expect(
        times.allSatisfy { $0.t >= 2 && $0.t <= window.close.endT && $0.final != true }, "\(path)")
      // Its detail would say end_anchor while recording.json says interrupted.
      #expect(times.allSatisfy { $0.kind != "recording_closed" }, "\(path)")
    }
    let checkpoint = try #require(summary.lastCheckpoint)
    let bin = h.sink.file("mesh/history.bin")!
    let mesh = RecoveryScan.meshHistory(
      index: h.sink.file("mesh/history.jsonl")!, binBytes: Int64(bin.count),
      checkpointBinBytes: checkpoint.binBytes, cutT: window.close.endT, dropFinal: true,
      readBlock: { bin.subdata(in: Int($0)..<(Int($0) + $1)) },
      inflatedLength: { storedInflate($0)?.count })
    #expect(mesh.stop == .finalLine)
    #expect(mesh.lines == 2)
  }

  /// The same from the journal alone: open, an end anchor and End the session here, no closed{}.
  @Test func aCutBackRecordingLosesItsClosedEvent() throws {
    let summary = JournalSummary([.open(open), .end(t: 30), .closing(deadline: 35)])
    let events = Data(
      [
        #"{"detail":null,"kind":"recording_opened","t":3.2}"#,
        #"{"detail":null,"kind":"memory_warning","t":34.983333}"#,
        #"{"detail":"end_anchor","kind":"recording_closed","t":34.983333}"#,
      ].map { $0 + "\n" }.joined().utf8)
    let lastWrittenT = RecoveryScan.jsonl(events).lastT
    guard
      case .cut(let window) = RecoveryPlan.make(
        journal: summary, recordingJson: nil, lastWrittenT: lastWrittenT)
    else {
      Issue.record("a cut-off recording with an end anchor is cut back")
      return
    }
    #expect(window.close.endT == 34.983333)
    #expect(window.removesClosedEvent)
    let scan = RecoveryScan.jsonl(
      events, cutT: window.close.endT, dropFinal: window.removesFinalLines,
      dropClosedEvent: window.removesClosedEvent)
    // The event at the same t before it stays.
    #expect(scan.stop == .closedEvent)
    #expect(scan.lines == 2)
    #expect(scan.lastT == 34.983333)
  }
}

private struct Timed: Decodable {
  let t: Double
  let final: Bool?
  let kind: String?
}

#endif
