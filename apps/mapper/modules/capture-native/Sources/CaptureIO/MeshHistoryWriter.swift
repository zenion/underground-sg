#if USG_RECORDER
import CaptureCore
import Foundation

// The mesh history on the I/O queue (design 3.2, 7.2 to 7.4 and 8): history.bin and
// history.jsonl written as a pair. Each add or update's block reaches history.bin before its
// line reaches history.jsonl, so a crash leaves at worst a block without a line, which recovery
// drops; a flush writes the blocks in one write(2), then the lines in another, and only commits
// both once both succeeded. The final snapshot's reused blocks are read back from history.bin
// with pread (it is opened O_RDWR), or taken from memory if they haven't been written yet.

struct MeshCutCheckpoint {
  var bin: CutCheckpoint
  var index: CutCheckpoint
}

public final class MeshHistoryWriter {
  public static let indexPath = RecordingFilePath.meshIndex.rawValue
  public static let binPath = RecordingFilePath.meshBin.rawValue

  public private(set) var committedBinBytes: Int64 = 0
  public private(set) var committedIndexBytes: Int64 = 0
  public private(set) var committedLines = 0
  public private(set) var backlogBytes = 0
  public private(set) var refusedLines = 0
  public private(set) var dirty = false

  private struct Item {
    let t: Double
    let block: Data?
    let line: Data
  }

  private let bin: DurableFile
  private let index: DurableFile
  private var pending: [Item] = []
  private var pendingBinBytes: Int64 = 0
  private var binHash = Sha256Stream()
  private var indexHash = Sha256Stream()
  private var lastCommittedT: Double?
  private var cutT: Double?
  private var cut: MeshCutCheckpoint?
  private var endT: Double?

  /// `bin` must be `appendReadWrite`, for the reused blocks.
  init(bin: DurableFile, index: DurableFile) {
    precondition(bin.mode == .appendReadWrite, "history.bin is read back")
    self.bin = bin
    self.index = index
  }

  /// history.bin's length once everything waiting is written: where the next block goes. It
  /// must equal the mesh ledger's, which placed every block.
  public var binBytes: Int64 { committedBinBytes + pendingBinBytes }

  public var digests: [FileDigest] {
    [
      FileDigest(path: Self.binPath, bytes: committedBinBytes, sha256: binHash.hex()),
      FileDigest(path: Self.indexPath, bytes: committedIndexBytes, sha256: indexHash.hex()),
    ]
  }

  /// Holds a line and its block, if any, until a flush. A copied block is read now, from disk
  /// or from the blocks still waiting.
  public func enqueue(t: Double, block: MeshBlockSource?, line: Data) throws {
    if let endT, t > endT {
      refusedLines += 1
      return
    }
    var bytes: Data?
    switch block {
    case .bytes(let data)?:
      bytes = data
    case .copy(let offset, let count)?:
      bytes = try read(offset: offset, count: count)
    case nil:
      bytes = nil
    }
    pending.append(Item(t: t, block: bytes, line: line))
    pendingBinBytes += Int64(bytes?.count ?? 0)
    backlogBytes += (bytes?.count ?? 0) + line.count
  }

  public func flush(watermark: Double) throws {
    var count = 0
    while count < pending.count && pending[count].t <= watermark { count += 1 }
    guard count > 0 else { return }
    var blocks = Data()
    var lines = Data()
    var nextBin = binHash
    var nextIndex = indexHash
    var mark: MeshCutCheckpoint?
    for position in 0..<count {
      let item = pending[position]
      if let cutT, cut == nil, mark == nil, item.t > cutT {
        mark = MeshCutCheckpoint(
          bin: CutCheckpoint(
            bytes: committedBinBytes + Int64(blocks.count), hash: nextBin.snapshot(), lines: 0,
            flagged: 0),
          index: CutCheckpoint(
            bytes: committedIndexBytes + Int64(lines.count), hash: nextIndex.snapshot(),
            lines: committedLines + position, flagged: 0))
      }
      if let block = item.block {
        blocks.append(block)
        nextBin.update(block)
      }
      lines.append(item.line)
      nextIndex.update(item.line)
    }
    do {
      if !blocks.isEmpty { try bin.appendAll(blocks) }
    } catch {
      try? bin.truncate(to: committedBinBytes)
      throw error
    }
    do {
      try index.appendAll(lines)
    } catch {
      // Blocks without their lines would be written again: take them back too.
      try? index.truncate(to: committedIndexBytes)
      try? bin.truncate(to: committedBinBytes)
      throw error
    }
    committedBinBytes += Int64(blocks.count)
    committedIndexBytes += Int64(lines.count)
    binHash = nextBin
    indexHash = nextIndex
    committedLines += count
    lastCommittedT = pending[count - 1].t
    if let mark { cut = mark }
    pending.removeFirst(count)
    pendingBinBytes -= Int64(blocks.count)
    backlogBytes -= blocks.count + lines.count
    dirty = true
  }

  public func registerCut(_ cutT: Double) {
    self.cutT = cutT
    cut = nil
  }

  /// As JsonlFileWriter's: the pair is truncated together to its cut checkpoint, or the waiting
  /// lines and blocks past `endT` dropped.
  public func cutBack(to endT: Double, useCut: Bool) throws {
    if useCut, cutT == endT, let cut {
      try bin.truncate(to: cut.bin.bytes)
      try index.truncate(to: cut.index.bytes)
      committedBinBytes = cut.bin.bytes
      committedIndexBytes = cut.index.bytes
      binHash = cut.bin.hash
      indexHash = cut.index.hash
      committedLines = cut.index.lines
      lastCommittedT = nil
      dirty = true
    } else if let lastCommittedT, lastCommittedT > endT {
      throw RecordingWriterError.committedPastEnd
    }
    self.cut = nil
    pending.removeAll { $0.t > endT }
    pendingBinBytes = pending.reduce(0) { $0 + Int64($1.block?.count ?? 0) }
    backlogBytes = pending.reduce(0) { $0 + ($1.block?.count ?? 0) + $1.line.count }
    self.endT = endT
  }

  public func sync() throws {
    guard dirty else { return }
    try bin.fsync()
    try index.fsync()
    dirty = false
  }

  /// Writes what is left, syncs and closes both files; the digests are the incremental ones.
  public func finish() throws -> [FileDigest] {
    try flush(watermark: .infinity)
    try sync()
    bin.close()
    index.close()
    return digests
  }

  public func abandon() {
    pending = []
    pendingBinBytes = 0
    backlogBytes = 0
    bin.close()
    index.close()
  }

  /// A block already placed: from history.bin when it was written, else from the blocks
  /// waiting, whose offsets follow the committed length in order.
  private func read(offset: Int64, count: Int) throws -> Data {
    if offset + Int64(count) <= committedBinBytes {
      var buffer: [UInt8] = []
      try bin.pread(offset: offset, count: count, into: &buffer)
      return Data(buffer)
    }
    var at = committedBinBytes
    for item in pending {
      guard let block = item.block else { continue }
      if at == offset && block.count == count { return block }
      at += Int64(block.count)
    }
    throw RecordingWriterError.blockMissing
  }
}
#endif
