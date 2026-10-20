#if USG_RECORDER
import CaptureCore
import Foundation
import Testing

@testable import CaptureIO

#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

// FileSink on temporary directories (design 14): the files it writes equal MemorySink's byte for
// byte for the same session, however often the watermark flushes; its incremental digests equal
// the files' own; a stop cut back on disk truncates to the cut checkpoint; a failed write leaves
// no partial line; and the open, the close and the delete leave the layout of design 7.1.

private func sha(_ data: Data) -> String { Sha256Stream.hex(of: data) }

/// The memory sink's files, by path.
private func files(_ sink: MemorySink) -> [String: Data] {
  Dictionary(uniqueKeysWithValues: sink.paths.map { ($0, sink.file($0) ?? Data()) })
}

@Suite struct FileSinkTests {
  let fixture: StoreFixture

  init() throws { fixture = try StoreFixture() }

  @Test(arguments: [0.25, 1.0, 7.0])
  func theFilesEqualMemorySinksByteForByte(tickS: Double) throws {
    let session = SyntheticSession(seed: 11, durationS: 40)
    let reference = memoryRecording(session)
    #expect(reference.state == .finished)

    let sink = FileSink(store: fixture.store())
    let core = SyntheticRecording.record(session, into: sink, tickS: tickS)
    #expect(sink.state == .finished)
    guard case .closed = core.phase else {
      Issue.record("the recorder closed")
      return
    }
    let id = session.recordingID
    let written = fixture.files(of: id)
    #expect(Set(written.keys) == Set(reference.paths))
    for (path, data) in files(reference) {
      #expect(written[path] == data, "\(path)")
    }
    // Nothing else is left: no journal, no ballast, no staging file.
    #expect(
      fixture.names(fixture.paths.recordingsRoot)
        == [".staging", RecordingPaths.recordingName(id)])
    #expect(fixture.names(fixture.paths.staging).isEmpty)
  }

  @Test func theIncrementalDigestsEqualTheFilesOwn() throws {
    let session = SyntheticSession(seed: 4, durationS: 30)
    let sink = FileSink(store: fixture.store())
    SyntheticRecording.record(session, into: sink, tickS: 0.5)
    let id = session.recordingID
    let facts = try #require(fixture.store().manifestFacts(id))
    #expect(facts.closed)
    #expect(facts.ended == .endAnchor)
    let written = fixture.files(of: id)
    #expect(facts.files.map(\.path) == written.keys.filter { $0 != "recording.json" }.sorted())
    for file in facts.files {
      let data = try #require(written[file.path])
      #expect(file.bytes == Int64(data.count), "\(file.path)")
      #expect(file.sha256 == sha(data), "\(file.path)")
    }
  }

  @Test(arguments: [0.25, nil] as [Double?])
  func aStopCutBackEqualsMemorySinksAndItsDigestsHold(tickS: Double?) throws {
    let session = SyntheticSession(seed: 5, durationS: 40)
    let stopT = session.endMarkT + 7
    let reference = MemorySink(digest: sha, deflate: Deflate.raw)
    driveScripted(session, ending: .stop(at: stopT), tickS: nil, apply: { reference.apply($0) }) {}
    reference.boundaryWaitExpired()
    #expect(reference.state == .finished)

    let sink = FileSink(store: fixture.store())
    let core = driveScripted(
      session, ending: .stop(at: stopT), tickS: tickS, apply: { _ = sink.apply($0) },
      tick: { _ = sink.tick() })
    guard case .finalizing(let close) = core.phase else {
      Issue.record("the recorder is finalizing")
      return
    }
    #expect(close.reason == .stop)
    #expect(close.trimmed)
    #expect(sink.state == .awaitingBoundary)
    #expect(sink.boundaryWaitExpired() == [.finalized])
    #expect(sink.state == .finished)

    let id = session.recordingID
    let written = fixture.files(of: id)
    for (path, data) in files(reference) {
      #expect(written[path] == data, "\(path)")
    }
    let facts = try #require(fixture.store().manifestFacts(id))
    #expect(facts.ended == .stop)
    #expect(facts.trimmed)
    for file in facts.files {
      #expect(file.sha256 == sha(try #require(written[file.path])), "\(file.path)")
    }
  }

  @Test func theOpenFollowsDesignSix() throws {
    let session = SyntheticSession(seed: 2, durationS: 30)
    let store = fixture.store()
    let sink = FileSink(store: store)
    let id = session.recordingID
    var sawOpen = false
    SyntheticRecording.record(session, into: sink) { sink in
      guard !sawOpen, sink.state == .open else { return }
      sawOpen = true
      // The journal's open came first and is full-synced; then the directory, recording.json,
      // the ballast and the files every recording has, all class B while written.
      let journal = Journal.decode(
        FileManager.default.contents(atPath: fixture.paths.journal(id).path) ?? Data())
      guard case .open(let open)? = journal.records.first else {
        Issue.record("the journal starts with open")
        return
      }
      #expect(open.id == id)
      #expect(fixture.exists(fixture.paths.ballast(id)))
      #expect(fileSize(fixture.paths.ballast(id).path) == 1 << 20)
      #expect(fixture.security.protectionClass(fixture.paths.recording(id)) == .completeUnlessOpen)
      for path in MemorySink.createdAtOpen {
        #expect(
          fixture.security.protectionClass(fixture.paths.file(path, of: id)) == .completeUnlessOpen)
      }
      #expect(fixture.security.isExcludedFromBackup(fixture.paths.recordingsRoot))
      #expect(store.isBusy(id))
    }
    #expect(sawOpen)
    // Closed: everything complete, the ballast and the journal gone, not busy.
    for file in store.files(in: fixture.paths.recording(id)) {
      #expect(
        fixture.security.protectionClass(
          fixture.paths.recording(id).appendingPathComponent(file.path)) == .complete)
    }
    #expect(fixture.security.protectionClass(fixture.paths.recording(id)) == .complete)
    #expect(!fixture.exists(fixture.paths.ballast(id)))
    #expect(!fixture.exists(fixture.paths.journal(id)))
    #expect(!store.isBusy(id))
    // Only exports/ may ever be made under Documents, and the sink makes nothing there.
    #expect(!fixture.exists(fixture.paths.documents))
  }

  @Test func whileLockedTheProtectionWaitsForTheUnlock() throws {
    let session = SyntheticSession(seed: 3, durationS: 25)
    let sink = FileSink(store: fixture.store())
    let core = session.makeRecorder()
    session.drive(core) { commands in
      if commands.contains(where: { if case .finalize = $0 { true } else { false } }) {
        fixture.security.protectedDataAvailable = false
      }
      for notice in sink.apply(commands) where notice == .finalized { core.finalizeCompleted() }
    }
    let id = session.recordingID
    #expect(sink.state == .protectionPending)
    let journal = Journal.decode(
      FileManager.default.contents(atPath: fixture.paths.journal(id).path) ?? Data())
    #expect(journal.summary.manifestWritten)
    #expect(journal.summary.protectionPending)
    let frames = fixture.paths.file(.frames, of: id)
    #expect(fixture.security.protectionClass(frames) == .completeUnlessOpen)

    fixture.security.protectedDataAvailable = true
    #expect(sink.protectedDataBecameAvailable().isEmpty)
    #expect(sink.state == .finished)
    #expect(fixture.security.protectionClass(fixture.paths.file(.frames, of: id)) == .complete)
    #expect(!fixture.exists(fixture.paths.journal(id)))
  }

  @Test func aDiscardDeletesTheDirectoryAndTheJournal() throws {
    let session = SyntheticSession(seed: 6, durationS: 30)
    let store = fixture.store()
    let sink = FileSink(store: store)
    let core = session.makeRecorder()
    var notices: [SinkNotice] = []
    session.drive(core) { commands in
      notices += sink.apply(commands)
      if sink.state == .open, (sink.latestFrameT ?? 0) > 10, case .open = core.phase {
        let discard = core.discard()
        // The journal's discard record goes first, then the delete.
        guard case .journal(.discard)? = discard.first else {
          Issue.record("discard is journaled first")
          return
        }
        notices += sink.apply(discard)
      }
    }
    let id = session.recordingID
    #expect(notices.contains(.deleted))
    #expect(sink.state == .deleted)
    #expect(!fixture.exists(fixture.paths.recording(id)))
    #expect(!fixture.exists(fixture.paths.journal(id)))
    #expect(!fixture.exists(fixture.paths.ballast(id)))
    #expect(!store.isBusy(id))
  }

  @Test func noSpaceLeavesNoPartialLineAndClosesAsDisk() throws {
    let session = SyntheticSession(seed: 8, durationS: 40)
    let store = fixture.store()
    let sink = FileSink(store: store)
    // From 20 s on, every write moves part of its bytes and then hits ENOSPC, until the ballast
    // is released.
    let disk = DiskSwitch()
    sink.calls = disk.calls
    let core = session.makeRecorder()
    var notices: [SinkNotice] = []
    var nextTick = 0.0
    session.drive(core) { commands in
      var batch = sink.apply(commands)
      if let t = sink.latestFrameT, t >= nextTick {
        if t >= 20 { disk.full = true }
        batch += sink.tick()
        nextTick = t + 1
      }
      for notice in batch {
        notices.append(notice)
        if case .closeRequested(let reason) = notice {
          disk.full = false
          let close = core.sinkLimitReached(reason)
          for later in sink.apply(close) {
            notices.append(later)
            if later == .awaitingBoundary { notices += sink.boundaryWaitExpired() }
          }
        }
        if notice == .finalized { core.finalizeCompleted() }
      }
    }
    for notice in notices where notice == .finalized { core.finalizeCompleted() }
    #expect(notices.contains(.closeRequested(.disk)))
    #expect(disk.partialWrites > 0)
    #expect(sink.state == .finished)
    guard case .closed(let close) = core.phase else {
      Issue.record("the recorder closed")
      return
    }
    #expect(close.reason == .disk)
    #expect(!close.finalSample)
    let id = session.recordingID
    let facts = try #require(store.manifestFacts(id))
    #expect(facts.ended == .disk)
    // Every file is whole lines, each inside the window, and matches its digest.
    for file in facts.files {
      let data = try #require(fixture.file(file.path, of: id))
      #expect(file.sha256 == sha(data), "\(file.path)")
      guard file.path.hasSuffix(".jsonl") else { continue }
      #expect(data.isEmpty || data.last == 0x0A, "\(file.path)")
      let scan = RecoveryScan.jsonl(data, cutT: close.endT)
      #expect(scan.stop == .end, "\(file.path)")
      #expect(scan.keepBytes == data.count, "\(file.path)")
    }
    #expect(sink.figures.writeFailures > 0)
  }

  @Test func aSlippedCloseIsLeftToRecovery() throws {
    // A close whose end is behind lines already on disk, which no cut checkpoint covers, can't
    // be finished in process without keeping them: the sink stops and recovery takes over.
    let session = SyntheticSession(seed: 9, durationS: 30)
    let sink = FileSink(store: fixture.store())
    let core = session.makeRecorder()
    var notices: [SinkNotice] = []
    var nextTick = 0.0
    session.drive(core) { commands in
      guard sink.state == .open || sink.state == .empty else { return }
      notices += sink.apply(commands)
      if let t = sink.latestFrameT, t >= nextTick {
        notices += sink.tick()
        nextTick = t + 1
      }
      if let t = sink.latestFrameT, t > 15 {
        notices += sink.apply(core.close(at: 5, reason: .background))
      }
    }
    #expect(notices.contains(.failed(.cut)))
    #expect(sink.state == .failed)
    let id = session.recordingID
    #expect(fixture.exists(fixture.paths.journal(id)))
    #expect(!fixture.exists(fixture.paths.ballast(id)))
  }
}

/// ENOSPC on demand: while `full`, each write moves at most 7 bytes and the next fails, as a
/// disk filling up mid-write does.
final class DiskSwitch: @unchecked Sendable {
  private let lock = NSLock()
  private var _full = false
  private var _partial = 0
  private var moved = false

  var full: Bool {
    get { lock.withLock { _full } }
    set { lock.withLock { _full = newValue } }
  }

  var partialWrites: Int { lock.withLock { _partial } }

  var calls: FileCalls {
    var calls = FileCalls.system
    calls.write = { fd, bytes, count in
      let step: Int? = self.lock.withLock {
        guard self._full else { return nil }
        if self.moved {
          self.moved = false
          return -1
        }
        self.moved = true
        self._partial += 1
        return min(count, 7)
      }
      guard let step else { return FileCalls.system.write(fd, bytes, count) }
      if step < 0 { return SysResult(value: -1, errno: ENOSPC) }
      return FileCalls.system.write(fd, bytes, step)
    }
    return calls
  }
}
#endif
