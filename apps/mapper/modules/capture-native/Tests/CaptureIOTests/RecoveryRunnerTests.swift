#if USG_RECORDER
import CaptureCore
import Foundation
import Testing

@testable import CaptureIO

// Recovery at launch on copies of a recording the app "died" writing (design 7 and 14): a torn
// line, a NUL tail, a missing newline and an index past the bin's end are cut away; the recording
// is cut back to its last end anchor plus the margin, as interrupted, with closed false, no final
// lines and no recording_closed event; a recording the recorder closed is finished; and the
// journal-less rules of D3 hold.

private func sha(_ data: Data) -> String { Sha256Stream.hex(of: data) }

private func append(_ data: Data, to url: URL) throws {
  let handle = try FileHandle(forWritingTo: url)
  defer { try? handle.close() }
  try handle.seekToEnd()
  try handle.write(contentsOf: data)
}

private func truncate(_ url: URL, by bytes: Int) throws {
  let handle = try FileHandle(forWritingTo: url)
  defer { try? handle.close() }
  let length = try handle.seekToEnd()
  try handle.truncate(atOffset: length - UInt64(bytes))
}

/// The checks every recovered recording passes: whole lines inside the window, recording.json
/// listing every file with its digest, the journal gone, the files complete.
private func expectRecovered(
  _ fixture: StoreFixture, _ id: UUID, ended: WindowEndReason, closed: Bool
) throws -> ManifestFacts {
  let facts = try #require(fixture.store().manifestFacts(id))
  #expect(facts.ended == ended)
  #expect(facts.closed == closed)
  let endT = try #require(facts.endT)
  let written = fixture.files(of: id)
  #expect(Set(facts.files.map(\.path)) == Set(written.keys.filter { $0 != "recording.json" }))
  for file in facts.files {
    let data = try #require(written[file.path])
    #expect(file.bytes == Int64(data.count), "\(file.path)")
    #expect(file.sha256 == sha(data), "\(file.path)")
    guard file.path.hasSuffix(".jsonl") else { continue }
    let scan = RecoveryScan.jsonl(data, cutT: endT, dropFinal: !closed, dropClosedEvent: !closed)
    #expect(scan.stop == .end, "\(file.path)")
    #expect(scan.keepBytes == data.count, "\(file.path)")
  }
  if !closed {
    let hasClosedEvent = String(decoding: try #require(written["events.jsonl"]), as: UTF8.self)
      .contains("recording_closed")
    #expect(!hasClosedEvent)
  }
  #expect(!fixture.exists(fixture.paths.journal(id)))
  #expect(fixture.security.protectionClass(fixture.paths.file(.frames, of: id)) == .complete)
  return facts
}

@Suite struct RecoveryRunnerTests {
  let fixture: StoreFixture
  let session = SyntheticSession(seed: 21, durationS: 40)

  init() throws { fixture = try StoreFixture() }

  /// Records until `t`, then stops as a crash would: what was flushed stays, nothing else.
  private func crash(at t: Double) {
    let sink = FileSink(store: fixture.store())
    SyntheticRecording.record(session, into: sink, tickS: 0.5, interruptAtT: t)
  }

  @Test func aCutOffRecordingIsCutBackAsInterrupted() throws {
    crash(at: session.endMarkT + 3)
    let id = session.recordingID
    let report = RecoveryRunner(store: fixture.store()).run()
    #expect(report.done)
    #expect(report.recovered == 1)
    let facts = try expectRecovered(fixture, id, ended: .interrupted, closed: false)
    #expect(facts.trimmed)
    #expect(try #require(facts.endT) <= session.endMarkT + 5)
    // Idempotent: a second launch finds nothing to do.
    let again = RecoveryRunner(store: fixture.store()).run()
    #expect(again.recovered == 0 && again.discarded == 0 && again.finished == 0)
  }

  @Test(arguments: ["torn line", "NUL tail", "missing newline", "index past the bin"])
  func damagedCopiesRecover(_ damage: String) throws {
    crash(at: session.endMarkT + 3)
    let id = session.recordingID
    let before = fixture.files(of: id)
    switch damage {
    case "torn line":
      try append(Data("{\"t\":99,\"frame\":".utf8), to: fixture.paths.file(.frames, of: id))
    case "NUL tail":
      try append(Data(count: 4096), to: fixture.paths.file(.imu, of: id))
    case "missing newline":
      try truncate(fixture.paths.file(.motion, of: id), by: 1)
    default:
      try truncate(fixture.paths.file(.meshBin, of: id), by: 5)
    }
    let report = RecoveryRunner(store: fixture.store()).run()
    #expect(report.recovered == 1)
    _ = try expectRecovered(fixture, id, ended: .interrupted, closed: false)
    let after = fixture.files(of: id)
    switch damage {
    case "torn line":
      // Booleans first, so a failure names counts rather than printing the file.
      let frames = after["frames.jsonl"] ?? Data()
      let torn = frames.count < before["frames.jsonl"]!.count + 16 && frames.last == 0x0A
      #expect(torn)
    case "NUL tail":
      let nul = after["imu.jsonl"]!.contains(0)
      #expect(!nul)
    case "missing newline":
      #expect(after["motion.jsonl"]!.count < before["motion.jsonl"]!.count - 1)
    default:
      #expect(after["mesh/history.jsonl"]!.count < before["mesh/history.jsonl"]!.count)
      #expect(after["mesh/history.bin"]!.count < before["mesh/history.bin"]!.count)
    }
  }

  @Test func aCrashBeforeAnEndAnchorKeepsNothing() throws {
    crash(at: session.endMarkT - 10)
    let id = session.recordingID
    let report = RecoveryRunner(store: fixture.store()).run()
    #expect(report.discarded == 1)
    #expect(!fixture.exists(fixture.paths.recording(id)))
    #expect(!fixture.exists(fixture.paths.journal(id)))
  }

  @Test func aRecordingTheRecorderClosedIsFinishedAsClosed() throws {
    // The app died while finalize waited for the boundary flush: closed{} is journaled.
    let sink = FileSink(store: fixture.store())
    let core = session.makeRecorder()
    session.drive(core) { commands in
      guard sink.state == .open || sink.state == .empty else { return }
      _ = sink.apply(commands)
    }
    #expect(sink.state == .awaitingBoundary)
    sink.abandon()
    let report = RecoveryRunner(store: fixture.store()).run()
    #expect(report.finished == 1)
    let facts = try expectRecovered(
      fixture, session.recordingID, ended: .endAnchor, closed: true)
    // The final sample stays: the recorder took it.
    let hasFinal = String(
      decoding: try #require(fixture.file("anchors.jsonl", of: session.recordingID)),
      as: UTF8.self
    ).contains("\"final\":true")
    #expect(hasFinal)
    #expect(facts.trimmed == false)
  }

  @Test func withoutAJournalAFinishedRecordingIsSweptAndAnUnfinishedOneDeleted() throws {
    // Finished, then its journal lost: kept, only protected.
    let sink = FileSink(store: fixture.store())
    SyntheticRecording.record(session, into: sink)
    let id = session.recordingID
    #expect(sink.state == .finished)
    // An open recording.json without a journal: the open was never journaled (D3).
    let other = SyntheticSession(seed: 22, durationS: 30)
    crash(other, at: 10)
    try FileManager.default.removeItem(at: fixture.paths.journal(other.recordingID))
    let report = RecoveryRunner(store: fixture.store()).run()
    #expect(report.swept == 1)
    #expect(report.discarded == 1)
    #expect(fixture.exists(fixture.paths.recording(id)))
    #expect(!fixture.exists(fixture.paths.recording(other.recordingID)))
  }

  @Test func aRecoveredRecordingIsNeverDeletedLater() throws {
    crash(at: session.endMarkT + 3)
    _ = RecoveryRunner(store: fixture.store()).run()
    let id = session.recordingID
    let again = RecoveryRunner(store: fixture.store()).run()
    #expect(again.swept == 1)
    #expect(again.discarded == 0)
    _ = try expectRecovered(fixture, id, ended: .interrupted, closed: false)
  }

  @Test func aJournalWithManifestOnlySweepsAndOneWithDiscardDeletes() throws {
    let sink = FileSink(store: fixture.store())
    SyntheticRecording.record(session, into: sink)
    let id = session.recordingID
    // The app died after manifest{} (protection pending), before the journal went.
    let open = JournalRecord.open(
      JournalOpen(id: id, startT: 2, profile: .lean, marginS: 5, idleS: 300, maxS: 1800))
    let journal = try [open, .manifest, .protectionPending].map(Journal.encode)
      .reduce(Data(), +)
    try journal.write(to: fixture.paths.journal(id))
    // And one died while deleting: discard{} journaled, the directory still there.
    let other = SyntheticSession(seed: 23, durationS: 30)
    crash(other, at: other.endMarkT + 2)
    try append(try Journal.encode(.discard), to: fixture.paths.journal(other.recordingID))

    let report = RecoveryRunner(store: fixture.store()).run()
    #expect(report.swept == 1)
    #expect(report.discarded == 1)
    #expect(fixture.exists(fixture.paths.recording(id)))
    #expect(!fixture.exists(fixture.paths.journal(id)))
    #expect(!fixture.exists(fixture.paths.recording(other.recordingID)))
    #expect(!fixture.exists(fixture.paths.journal(other.recordingID)))
  }

  @Test func leftoversAreSwept() throws {
    let store = fixture.store()
    try store.prepareRoots()
    let id = UUID()
    try store.reserveBallast(id)
    try Data("x".utf8).write(to: fixture.paths.staging.appendingPathComponent("a.tmp"))
    let staged = fixture.paths.exportStaging(id)
    try FileManager.default.createDirectory(at: staged, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(
      at: fixture.paths.selfTestRoot, withIntermediateDirectories: true)
    let report = RecoveryRunner(store: fixture.store()).run()
    #expect(report.done)
    #expect(!fixture.exists(fixture.paths.ballast(id)))
    #expect(fixture.names(fixture.paths.staging).isEmpty)
    #expect(fixture.names(fixture.paths.exportsStagingRoot).isEmpty)
    #expect(!fixture.exists(fixture.paths.selfTestRoot))
  }

  @Test func whileLockedNothingRuns() throws {
    crash(at: session.endMarkT + 3)
    fixture.security.protectedDataAvailable = false
    let report = RecoveryRunner(store: fixture.store()).run()
    #expect(!report.done)
    #expect(fixture.exists(fixture.paths.journal(session.recordingID)))
  }

  private func crash(_ other: SyntheticSession, at t: Double) {
    let sink = FileSink(store: fixture.store())
    SyntheticRecording.record(other, into: sink, tickS: 0.5, interruptAtT: t)
  }
}
#endif
