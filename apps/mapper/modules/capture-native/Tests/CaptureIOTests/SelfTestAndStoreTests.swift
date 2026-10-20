#if USG_RECORDER
import CaptureCore
import Foundation
import Testing

@testable import CaptureIO

// The self-test (design 9 and D18) and the store's list, delete, free space, ballast and busy
// flags (design 3.2).

private func walkGrant() -> RecordingGrant? {
  if case .granted(let grant) = RecordPermission.decide(
    profile: .lean, facts: .walk, venues: ["5d6e7f80-1a2b-4c3d-8e9f-a0b1c2d3e4f5"],
    freeDiskBytes: 1 << 40)
  {
    return grant
  }
  return nil
}

@Suite struct SelfTestTests {
  let fixture: StoreFixture

  init() throws { fixture = try StoreFixture() }

  @Test func itPassesAndLeavesNothingBehind() throws {
    let report = SelfTest(store: fixture.store()).run(
      keep: false, grant: nil, durationS: 20, seed: 5)
    #expect(report.passed)
    #expect(report.recordingFinished)
    #expect(report.protectionWhileWriting == .completeUnlessOpen)
    #expect(report.protectionAfterClose == .complete)
    #expect(report.excludedFromBackup)
    #expect(report.compressionMatches)
    #expect(report.sha256Matches)
    #expect(report.documentsNames.isEmpty)
    #expect(report.keptID == nil)
    #expect(!fixture.exists(fixture.paths.selfTestRoot))
    #expect(fixture.names(fixture.paths.recordingsRoot) == [".staging"])
  }

  @Test func theDevelopmentBuildCantKeepTheSet() throws {
    let report = SelfTest(store: fixture.store()).run(
      keep: true, grant: nil, durationS: 20, seed: 6)
    #expect(report.passed)
    #expect(report.keptID == nil)
    #expect(fixture.names(fixture.paths.recordingsRoot) == [".staging"])
  }

  @Test func theWalkBuildKeepsTheSetAsSynthetic() throws {
    let report = SelfTest(store: fixture.store()).run(
      keep: true, grant: walkGrant(), durationS: 20, seed: 7)
    let id = try #require(report.keptID)
    let summary = try #require(fixture.store().list().first { $0.id == id })
    #expect(summary.origin == .synthetic)
    #expect(summary.state == .closed)
    #expect(summary.ended == .endAnchor)
    #expect(!fixture.exists(fixture.paths.selfTestRoot))
  }

  @Test func whileLockedItDoesntRun() {
    fixture.security.protectedDataAvailable = false
    let report = SelfTest(store: fixture.store()).run(keep: false, grant: nil, durationS: 20)
    #expect(!report.passed)
    #expect(!report.recordingFinished)
  }
}

@Suite struct RecordingStoreTests {
  let fixture: StoreFixture

  init() throws { fixture = try StoreFixture() }

  @Test func theListReportsEachStateWithoutTimes() throws {
    let finished = SyntheticSession(seed: 41, durationS: 25)
    SyntheticRecording.record(finished, into: FileSink(store: fixture.store()))
    let cut = SyntheticSession(seed: 42, durationS: 25)
    SyntheticRecording.record(
      cut, into: FileSink(store: fixture.store()), interruptAtT: cut.endMarkT + 2)

    var listed = Dictionary(uniqueKeysWithValues: fixture.store().list().map { ($0.id, $0) })
    let closed = try #require(listed[finished.recordingID])
    #expect(closed.state == .closed)
    #expect(closed.profile == .lean)
    #expect(closed.ended == .endAnchor)
    #expect(closed.files == 13)
    #expect(closed.bytes > 0)
    #expect(closed.exportParts == nil)
    #expect(closed.venues.count == 1)
    #expect(try #require(closed.durationS) > 15)
    #expect(try #require(listed[cut.recordingID]).state == .needsRecovery)

    _ = RecoveryRunner(store: fixture.store()).run()
    listed = Dictionary(uniqueKeysWithValues: fixture.store().list().map { ($0.id, $0) })
    let recovered = try #require(listed[cut.recordingID])
    #expect(recovered.state == .recovered)
    #expect(recovered.ended == .interrupted)
    #expect(recovered.trimmed)
  }

  @Test func theAgeIsInWholeDays() throws {
    let session = SyntheticSession(seed: 43, durationS: 25)
    SyntheticRecording.record(session, into: FileSink(store: fixture.store()))
    // The synthetic clock starts 2026-10-20 00:00 +08:00, give or take; ten and a half days on.
    let store = RecordingStore(
      paths: fixture.paths, security: fixture.security,
      now: { Date(timeIntervalSince1970: 1_792_454_400 + 10.5 * 86_400) })
    #expect(store.list().first?.ageDays == 10)
  }

  @Test func deleteRemovesEverythingButRefusesABusyRecording() throws {
    let session = SyntheticSession(seed: 44, durationS: 25)
    SyntheticRecording.record(session, into: FileSink(store: fixture.store()))
    let id = session.recordingID
    let store = fixture.store()
    #expect(store.markBusy(id))
    #expect(throws: RecordingStoreError.busy) { try store.delete(id) }
    store.clearBusy(id)
    try store.delete(id)
    #expect(!fixture.exists(fixture.paths.recording(id)))
    #expect(throws: RecordingStoreError.notFound) { try store.delete(id) }
  }

  @Test func freeSpaceIsReadAtMostOnceASecond() {
    let clock = Clock()
    let reads = Counter()
    let store = RecordingStore(
      paths: fixture.paths, security: fixture.security,
      freeSpace: FreeSpaceProbe { _ in
        reads.add()
        return 1000
      }, uptime: { clock.now })
    #expect(store.freeBytes() == 1000)
    clock.now = 0.5
    #expect(store.freeBytes() == 1000)
    #expect(reads.value == 1)
    clock.now = 1.2
    _ = store.freeBytes()
    #expect(reads.value == 2)
  }

  @Test func theSystemProbeReadsTheVolume() throws {
    try FileManager.default.createDirectory(
      at: fixture.paths.applicationSupport, withIntermediateDirectories: true)
    #expect((FreeSpaceProbe.system.bytes(fixture.paths.applicationSupport) ?? 0) > 0)
  }

  @Test func theBallastHoldsItsBytesUntilReleased() throws {
    let store = fixture.store()
    try store.prepareRoots()
    let id = UUID()
    try store.reserveBallast(id)
    #expect(fileSize(fixture.paths.ballast(id).path) == 1 << 20)
    store.releaseBallast(id)
    #expect(!fixture.exists(fixture.paths.ballast(id)))
  }

  @Test func busyFlagsAreExclusive() {
    let store = fixture.store()
    let id = UUID()
    #expect(store.markBusy(id))
    #expect(!store.markBusy(id))
    #expect(store.isBusy(id))
    store.clearBusy(id)
    #expect(!store.isBusy(id))
  }
}

private final class Clock: @unchecked Sendable {
  private let lock = NSLock()
  private var _now = 0.0
  var now: Double {
    get { lock.withLock { _now } }
    set { lock.withLock { _now = newValue } }
  }
}

private final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var _value = 0
  var value: Int { lock.withLock { _value } }
  func add() { lock.withLock { _value += 1 } }
}
#endif
