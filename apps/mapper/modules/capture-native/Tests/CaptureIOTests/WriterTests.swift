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

// JsonlFileWriter and MeshHistoryWriter on their own (design 7.2 to 7.4): the watermark, one
// write per flush, the commit only after a whole write, the cut checkpoint, and the pair's order.

/// FileCalls that count writes and follow a script for the next ones: pass, or fail.
final class CountingCalls: @unchecked Sendable {
  private let lock = NSLock()
  private var _writes = 0
  private var _script: [Int32?] = []
  /// Bytes each failing write still moves first.
  var partialBytes = 0

  var writes: Int { lock.withLock { _writes } }

  func failNext(_ errno: Int32) {
    lock.withLock { _script.append(errno) }
  }

  func passNext() {
    lock.withLock { _script.append(nil) }
  }

  var calls: FileCalls {
    var calls = FileCalls.system
    calls.write = { fd, bytes, count in
      let failure: Int32? = self.lock.withLock {
        self._writes += 1
        return self._script.isEmpty ? nil : self._script.removeFirst()
      }
      guard let failure else { return FileCalls.system.write(fd, bytes, count) }
      if self.partialBytes > 0 {
        _ = FileCalls.system.write(fd, bytes, min(count, self.partialBytes))
      }
      return SysResult(value: -1, errno: failure)
    }
    return calls
  }
}

private func line(_ t: Double, _ text: String = "x") -> Data {
  Data("{\"t\":\(t),\"v\":\"\(text)\"}\n".utf8)
}

@Suite struct JsonlFileWriterTests {
  let directory: TemporaryDirectory
  let security = RecordingFileSecurity()
  let counting = CountingCalls()

  init() throws { directory = try TemporaryDirectory() }

  private func writer(_ name: String = "frames.jsonl") throws -> JsonlFileWriter {
    let file = try DurableFile.create(
      directory.file(name), mode: .appendWriteOnly, protection: .completeUnlessOpen,
      security: security, calls: counting.calls)
    return JsonlFileWriter(path: name, file: file)
  }

  @Test func linesWaitForTheWatermarkAndFlushInOneWrite() throws {
    let writer = try writer()
    var expected = Data()
    for k in 0..<10 {
      writer.enqueue(line(Double(k) / 10), t: Double(k) / 10)
      if k < 6 { expected.append(line(Double(k) / 10)) }
    }
    #expect(directory.contents("frames.jsonl") == Data())
    try writer.flush(watermark: 0.5)
    #expect(counting.writes == 1)
    #expect(directory.contents("frames.jsonl") == expected)
    #expect(writer.committedBytes == Int64(expected.count))
    #expect(writer.committedLines == 6)
    #expect(writer.digest.sha256 == Sha256Stream.hex(of: expected))
    // Nothing new past the watermark: no write at all.
    try writer.flush(watermark: 0.5)
    #expect(counting.writes == 1)
  }

  @Test func aFailedWriteCommitsNothingAndLeavesNoPartialLine() throws {
    let writer = try writer()
    writer.enqueue(line(0), t: 0)
    try writer.flush(watermark: 1)
    let before = try #require(directory.contents("frames.jsonl"))
    let digest = writer.digest
    writer.enqueue(line(0.5), t: 0.5)
    writer.enqueue(line(0.6), t: 0.6)
    counting.partialBytes = 9
    counting.failNext(ENOSPC)
    #expect(throws: IOFailure.system(.write, errno: ENOSPC)) { try writer.flush(watermark: 1) }
    #expect(directory.contents("frames.jsonl") == before)
    #expect(writer.digest == digest)
    #expect(writer.backlogBytes == line(0.5).count + line(0.6).count)
    // The lines stay waiting and go out whole once there is room.
    try writer.flush(watermark: 1)
    #expect(directory.contents("frames.jsonl") == before + line(0.5) + line(0.6))
    #expect(writer.digest.sha256 == Sha256Stream.hex(of: before + line(0.5) + line(0.6)))
  }

  @Test func theCutCheckpointsDigestIsTheTruncatedFiles() throws {
    let writer = try writer()
    var kept = Data()
    writer.registerCut(1.0)
    for k in 0..<20 {
      let t = Double(k) / 10
      writer.enqueue(line(t), t: t, flagged: k % 4 == 0)
      if t <= 1.0 { kept.append(line(t)) }
      // Flushes that straddle the cut, one line past it in the middle of a batch.
      if k % 7 == 6 { try writer.flush(watermark: t) }
    }
    try writer.flush(watermark: 1.9)
    #expect(writer.committedBytes > Int64(kept.count))
    try writer.cutBack(to: 1.0, useCut: true)
    #expect(directory.contents("frames.jsonl") == kept)
    #expect(writer.digest.sha256 == Sha256Stream.hex(of: kept))
    #expect(writer.committedLines == 11)
    #expect(writer.committedFlagged == 3)
    // After the cut back, lines past the end are refused.
    writer.enqueue(line(1.5), t: 1.5)
    writer.enqueue(line(1.0, "closing"), t: 1.0)
    let digest = try writer.finish()
    #expect(writer.refusedLines == 1)
    #expect(directory.contents("frames.jsonl") == kept + line(1.0, "closing"))
    #expect(digest.sha256 == Sha256Stream.hex(of: kept + line(1.0, "closing")))
  }

  @Test func aCutTheWatermarkNeverReachedDropsOnlyWaitingLines() throws {
    let writer = try writer()
    writer.registerCut(1.0)
    for k in 0..<15 { writer.enqueue(line(Double(k) / 10), t: Double(k) / 10) }
    try writer.flush(watermark: 0.6)
    try writer.cutBack(to: 1.0, useCut: true)
    let digest = try writer.finish()
    let expected = (0...10).reduce(into: Data()) { $0.append(line(Double($1) / 10)) }
    #expect(directory.contents("frames.jsonl") == expected)
    #expect(digest.sha256 == Sha256Stream.hex(of: expected))
  }

  @Test func aLaterEndAnchorMovesTheCut() throws {
    let writer = try writer()
    writer.registerCut(0.5)
    for k in 0..<10 { writer.enqueue(line(Double(k) / 10), t: Double(k) / 10) }
    try writer.flush(watermark: 0.8)
    writer.registerCut(1.5)
    for k in 10..<20 { writer.enqueue(line(Double(k) / 10), t: Double(k) / 10) }
    try writer.flush(watermark: 1.9)
    try writer.cutBack(to: 1.5, useCut: true)
    _ = try writer.finish()
    let expected = (0...15).reduce(into: Data()) { $0.append(line(Double($1) / 10)) }
    #expect(directory.contents("frames.jsonl") == expected)
  }

  @Test func committedLinesPastTheEndWithoutACutAreRefused() throws {
    let writer = try writer()
    for k in 0..<10 { writer.enqueue(line(Double(k) / 10), t: Double(k) / 10) }
    try writer.flush(watermark: 0.9)
    #expect(throws: RecordingWriterError.committedPastEnd) {
      try writer.cutBack(to: 0.5, useCut: false)
    }
  }
}

@Suite struct MeshHistoryWriterTests {
  let directory: TemporaryDirectory
  let security = RecordingFileSecurity()
  let counting = CountingCalls()

  init() throws { directory = try TemporaryDirectory() }

  private func writer() throws -> MeshHistoryWriter {
    let bin = try DurableFile.create(
      directory.file("history.bin"), mode: .appendReadWrite, protection: .completeUnlessOpen,
      security: security, calls: counting.calls)
    let index = try DurableFile.create(
      directory.file("history.jsonl"), mode: .appendWriteOnly, protection: .completeUnlessOpen,
      security: security, calls: counting.calls)
    return MeshHistoryWriter(bin: bin, index: index)
  }

  @Test func blocksGoBeforeTheirLinesAndReuseReadsThemBack() throws {
    let writer = try writer()
    let a = noiseBytes(300, seed: 1)
    let b = noiseBytes(200, seed: 2)
    try writer.enqueue(t: 1, block: .bytes(a), line: line(1, "a"))
    try writer.enqueue(t: 1, block: nil, line: line(1, "remove"))
    try writer.enqueue(t: 2, block: .bytes(b), line: line(2, "b"))
    #expect(writer.binBytes == 500)
    try writer.flush(watermark: 1.5)
    #expect(directory.contents("history.bin") == a)
    #expect(directory.contents("history.jsonl") == line(1, "a") + line(1, "remove"))
    // The final snapshot copies a's block from disk and b's from memory, unwritten.
    try writer.enqueue(t: 3, block: .copy(offset: 0, bytes: 300), line: line(3, "a again"))
    try writer.enqueue(t: 3, block: .copy(offset: 300, bytes: 200), line: line(3, "b again"))
    #expect(throws: RecordingWriterError.blockMissing) {
      try writer.enqueue(t: 3, block: .copy(offset: 900, bytes: 20), line: line(3, "nothing"))
    }
    let digests = try writer.finish()
    let bin = a + b + a + b
    let index = line(1, "a") + line(1, "remove") + line(2, "b") + line(3, "a again")
      + line(3, "b again")
    #expect(directory.contents("history.bin") == bin)
    #expect(directory.contents("history.jsonl") == index)
    #expect(digests.map(\.sha256) == [Sha256Stream.hex(of: bin), Sha256Stream.hex(of: index)])
  }

  @Test func aFailedIndexWriteTakesTheBlocksBackToo() throws {
    let writer = try writer()
    try writer.enqueue(t: 1, block: .bytes(noiseBytes(100)), line: line(1))
    try writer.flush(watermark: 1)
    let bin = directory.contents("history.bin")
    let index = directory.contents("history.jsonl")
    try writer.enqueue(t: 2, block: .bytes(noiseBytes(100, seed: 3)), line: line(2))
    // The block's write succeeds, the line's fails: the block is taken back.
    counting.passNext()
    counting.failNext(EIO)
    #expect(throws: IOFailure.system(.write, errno: EIO)) { try writer.flush(watermark: 2) }
    #expect(directory.contents("history.bin") == bin)
    #expect(directory.contents("history.jsonl") == index)
    #expect(writer.committedBinBytes == 100)
    try writer.flush(watermark: 2)
    #expect(directory.contents("history.bin") == bin! + noiseBytes(100, seed: 3))
    #expect(directory.contents("history.jsonl") == index! + line(2))
  }

  @Test func theCutTruncatesThePairTogether() throws {
    let writer = try writer()
    writer.registerCut(2)
    var bin = Data()
    var index = Data()
    for k in 1...5 {
      let block = noiseBytes(64 * k, seed: UInt64(k))
      try writer.enqueue(t: Double(k), block: .bytes(block), line: line(Double(k)))
      if k <= 2 {
        bin.append(block)
        index.append(line(Double(k)))
      }
      try writer.flush(watermark: Double(k))
    }
    try writer.cutBack(to: 2, useCut: true)
    let digests = try writer.finish()
    #expect(directory.contents("history.bin") == bin)
    #expect(directory.contents("history.jsonl") == index)
    #expect(digests.map(\.sha256) == [Sha256Stream.hex(of: bin), Sha256Stream.hex(of: index)])
  }
}
#endif
