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

// DurableFile on real files in a temporary directory, with the system calls interrupted,
// shortened and failed where a test needs it (design 7.2 and 7.7).

/// FileCalls whose write and pread are scripted: each call takes the next step, then the real
/// call, at most `limit` bytes at a time.
private final class ScriptedCalls: @unchecked Sendable {
  enum Step {
    case interrupt
    case fail(Int32)
    case zero
    case pass
  }

  private let lock = NSLock()
  private var writes: [Step]
  private var reads: [Step]
  private(set) var writeCalls = 0
  private(set) var readCalls = 0
  let limit: Int
  var fullFsyncFails = false
  private(set) var fsyncCalls = 0

  init(writes: [Step] = [], reads: [Step] = [], limit: Int = .max) {
    self.writes = writes
    self.reads = reads
    self.limit = limit
  }

  var calls: FileCalls {
    var calls = FileCalls.system
    calls.write = { fd, bytes, count in
      let step = self.next(write: true)
      switch step {
      case .interrupt: return SysResult(value: -1, errno: EINTR)
      case .fail(let code): return SysResult(value: -1, errno: code)
      case .zero: return SysResult(value: 0, errno: 0)
      case .pass: return FileCalls.system.write(fd, bytes, min(count, self.limit))
      }
    }
    calls.pread = { fd, into, count, offset in
      let step = self.next(write: false)
      switch step {
      case .interrupt: return SysResult(value: -1, errno: EINTR)
      case .fail(let code): return SysResult(value: -1, errno: code)
      case .zero: return SysResult(value: 0, errno: 0)
      case .pass: return FileCalls.system.pread(fd, into, min(count, self.limit), offset)
      }
    }
    calls.fullFsync = { fd in
      self.fullFsyncFails ? SysResult(value: -1, errno: ENOTSUP) : FileCalls.system.fullFsync(fd)
    }
    calls.fsync = { fd in
      self.lock.withLock { self.fsyncCalls += 1 }
      return FileCalls.system.fsync(fd)
    }
    return calls
  }

  private func next(write: Bool) -> Step {
    lock.withLock {
      if write {
        writeCalls += 1
        return writes.isEmpty ? .pass : writes.removeFirst()
      }
      readCalls += 1
      return reads.isEmpty ? .pass : reads.removeFirst()
    }
  }
}

@Suite struct DurableFileTests {
  let directory: TemporaryDirectory
  let security = RecordingFileSecurity()

  init() throws { directory = try TemporaryDirectory() }

  private func create(_ name: String, _ mode: DurableFile.Mode = .appendWriteOnly) throws
    -> DurableFile
  {
    try DurableFile.create(
      directory.file(name), mode: mode, protection: .completeUnlessOpen, security: security)
  }

  @Test func createGoesThroughFileSecurityWithItsClass() throws {
    let file = try create("frames.jsonl")
    defer { file.close() }
    #expect(security.calls == [.createFile(directory.file("frames.jsonl").path, .completeUnlessOpen)])
    #expect(security.protectionClass(directory.file("frames.jsonl")) == .completeUnlessOpen)
    #expect(try file.length() == 0)
  }

  @Test func createRefusesAFileThatExists() throws {
    try create("frames.jsonl").close()
    #expect(throws: IOFailure.system(.create, errno: EEXIST)) { try create("frames.jsonl") }
  }

  @Test func openingNeverCreates() {
    #expect(throws: IOFailure.system(.open, errno: ENOENT)) {
      try DurableFile(opening: directory.file("missing.jsonl"), mode: .appendWriteOnly)
    }
    #expect(!FileManager.default.fileExists(atPath: directory.file("missing.jsonl").path))
  }

  @Test func aFailedCreateLeavesNoFile() {
    security.failNext(.createFile)
    #expect(throws: IOFailure.system(.create, errno: EACCES)) { try create("frames.jsonl") }
    #expect(!FileManager.default.fileExists(atPath: directory.file("frames.jsonl").path))
  }

  @Test func descriptorsAreCloseOnExec() throws {
    for mode in [DurableFile.Mode.appendWriteOnly, .appendReadWrite] {
      let file = try create("file-\(mode)", mode)
      defer { file.close() }
      #expect(fcntl(file.descriptor, F_GETFD) & FD_CLOEXEC != 0)
      #expect(fcntl(file.descriptor, F_GETFL) & O_APPEND != 0)
    }
  }

  @Test func appendsGoToTheEndEvenAfterReopening() throws {
    let file = try create("events.jsonl")
    try file.appendAll(Data("one\n".utf8))
    file.close()
    let again = try DurableFile(opening: directory.file("events.jsonl"), mode: .appendWriteOnly)
    try again.appendAll(Data("two\n".utf8))
    try again.appendAll(Data())
    #expect(try again.length() == 8)
    again.close()
    #expect(directory.contents("events.jsonl") == Data("one\ntwo\n".utf8))
  }

  @Test func appendAllLoopsOverInterruptionsAndShortWrites() throws {
    let script = ScriptedCalls(writes: [.interrupt, .pass, .interrupt, .interrupt], limit: 3)
    try create("imu.jsonl").close()
    let file = try DurableFile(
      opening: directory.file("imu.jsonl"), mode: .appendWriteOnly, calls: script.calls)
    let bytes = lineBytes(1000)
    try file.appendAll(bytes)
    file.close()
    #expect(directory.contents("imu.jsonl") == bytes)
    // 334 writes of at most 3 bytes, plus the three interrupted ones.
    #expect(script.writeCalls == 337)
  }

  @Test func aWriteThatMovesNothingFailsInsteadOfSpinning() throws {
    let script = ScriptedCalls(writes: [.zero])
    try create("imu.jsonl").close()
    let file = try DurableFile(
      opening: directory.file("imu.jsonl"), mode: .appendWriteOnly, calls: script.calls)
    #expect(throws: IOFailure.system(.write, errno: EIO)) { try file.appendAll(Data("x".utf8)) }
    #expect(script.writeCalls == 1)
  }

  @Test func noSpaceMidLineIsCutBackToTheCommittedLength() throws {
    // Design 7.7: the line that met ENOSPC is half on disk; truncating to the committed length
    // leaves only whole lines.
    let script = ScriptedCalls(writes: [.pass, .pass, .pass, .fail(ENOSPC)], limit: 4)
    try create("motion.jsonl").close()
    let file = try DurableFile(
      opening: directory.file("motion.jsonl"), mode: .appendWriteOnly, calls: script.calls)
    let committed = Data("{\"t\":1}\n".utf8)
    try file.appendAll(committed)
    let failure = #expect(throws: IOFailure.self) {
      try file.appendAll(Data("{\"t\":2}\n{\"t\":3}\n".utf8))
    }
    #expect(failure?.isNoSpace == true)
    #expect(try file.length() > Int64(committed.count))
    try file.truncate(to: Int64(committed.count))
    try file.appendAll(Data("{\"t\":4}\n".utf8))
    file.close()
    #expect(directory.contents("motion.jsonl") == Data("{\"t\":1}\n{\"t\":4}\n".utf8))
  }

  @Test func preadReadsBackBlocksOfAReadWriteFile() throws {
    let file = try create("history.bin", .appendReadWrite)
    defer { file.close() }
    let first = noiseBytes(5000, seed: 1)
    let second = noiseBytes(3000, seed: 2)
    try file.appendAll(first)
    try file.appendAll(second)
    var buffer: [UInt8] = []
    try file.pread(offset: 5000, count: 3000, into: &buffer)
    #expect(Data(buffer) == second)
    try file.pread(offset: 10, count: 20, into: &buffer)
    #expect(Data(buffer) == first.subdata(in: 10..<30))
    try file.pread(offset: 0, count: 0, into: &buffer)
    #expect(buffer.isEmpty)
    // Appending what was read, as the final snapshot reuses a block (design D6).
    try file.pread(offset: 0, count: 5000, into: &buffer)
    try file.appendAll(Data(buffer))
    #expect(try file.length() == 13_000)
  }

  @Test func preadLoopsOverInterruptionsAndShortReads() throws {
    try create("history.bin", .appendReadWrite).close()
    let script = ScriptedCalls(reads: [.interrupt, .pass, .interrupt], limit: 7)
    let file = try DurableFile(
      opening: directory.file("history.bin"), mode: .appendReadWrite, calls: script.calls)
    defer { file.close() }
    let bytes = noiseBytes(100)
    try file.appendAll(bytes)
    var buffer: [UInt8] = []
    try file.pread(offset: 0, count: 100, into: &buffer)
    #expect(Data(buffer) == bytes)
    // 15 reads of at most 7 bytes, plus the two interrupted ones.
    #expect(script.readCalls == 17)
  }

  @Test func preadPastTheEndIsAShortRead() throws {
    let file = try create("history.bin", .appendReadWrite)
    defer { file.close() }
    try file.appendAll(noiseBytes(10))
    var buffer: [UInt8] = []
    #expect(throws: IOFailure.shortRead) { try file.pread(offset: 5, count: 6, into: &buffer) }
  }

  @Test func aWriteOnlyFileCantBeRead() throws {
    let file = try create("frames.jsonl")
    defer { file.close() }
    try file.appendAll(Data("x\n".utf8))
    var buffer: [UInt8] = []
    #expect(throws: IOFailure.system(.read, errno: EBADF)) {
      try file.pread(offset: 0, count: 1, into: &buffer)
    }
  }

  @Test func syncsSucceedAndFullSyncFallsBackToFsync() throws {
    let file = try create("journal.jsonl")
    try file.appendAll(Data("{}\n".utf8))
    try file.fsync()
    try file.fullSync()
    file.close()

    let script = ScriptedCalls()
    script.fullFsyncFails = true
    let again = try DurableFile(
      opening: directory.file("journal.jsonl"), mode: .appendWriteOnly, calls: script.calls)
    defer { again.close() }
    try again.fullSync()
    #expect(script.fsyncCalls == 1)
  }

  @Test func truncateCutsAndLaterAppendsStartThere() throws {
    let file = try create("anchors.jsonl")
    defer { file.close() }
    try file.appendAll(Data("keep\ncut\n".utf8))
    try file.truncate(to: 5)
    try file.appendAll(Data("next\n".utf8))
    #expect(try file.length() == 10)
    #expect(directory.contents("anchors.jsonl") == Data("keep\nnext\n".utf8))
  }

  @Test func closeIsIdempotentAndAClosedFileRefusesEverything() throws {
    let file = try create("telemetry.jsonl")
    #expect(file.isOpen)
    file.close()
    file.close()
    #expect(!file.isOpen)
    var buffer: [UInt8] = []
    #expect(throws: IOFailure.closed) { try file.appendAll(Data("x".utf8)) }
    #expect(throws: IOFailure.closed) { try file.pread(offset: 0, count: 1, into: &buffer) }
    #expect(throws: IOFailure.closed) { try file.fsync() }
    #expect(throws: IOFailure.closed) { try file.fullSync() }
    #expect(throws: IOFailure.closed) { try file.truncate(to: 0) }
    #expect(throws: IOFailure.closed) { try file.length() }
  }

  @Test func aDirectoryCanBeSynced() throws {
    try DurableFile.syncDirectory(directory.url)
    #expect(throws: IOFailure.system(.open, errno: ENOENT)) {
      try DurableFile.syncDirectory(directory.url.appendingPathComponent("missing"))
    }
  }
}
