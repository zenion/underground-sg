#if USG_RECORDER
import CaptureCore
import Foundation

// One JSONL file of a recording on the I/O queue (design 3.2 and 7.2 to 7.4): lines wait in
// memory until the watermark, half a second behind the newest frame, passes them; a flush then
// writes every line it can in one write(2). Only after the whole write succeeded do the
// committed length, then the incremental SHA-256, move on, so a failed write never leaves a
// partial line counted, and the digest in recording.json never needs the file read back.

/// Why a writer can't finish at the window's end. Carries no value from the recording.
public enum RecordingWriterError: Error, Equatable, Sendable {
  /// Lines past the window's end are already on disk and no cut checkpoint covers them. The
  /// sink leaves the recording to recovery rather than keep them (design 12).
  case committedPastEnd
  /// A final snapshot asked to copy a block history.bin doesn't hold.
  case blockMissing
}

/// Where a file stood just before its first line past a cut time: what a stop cut back to that
/// time truncates to, and the digest of the file truncated there (design 7.4).
struct CutCheckpoint {
  var bytes: Int64
  var hash: Sha256Stream
  var lines: Int
  var flagged: Int
}

public final class JsonlFileWriter {
  /// The path in `rec-<id>/`, as recording.json's `files` lists it.
  public let path: String
  /// Bytes on disk that a successful write put there.
  public private(set) var committedBytes: Int64 = 0
  /// Bytes waiting in memory.
  public private(set) var backlogBytes = 0
  /// Lines on disk, and how many of them were flagged (frames.jsonl's candidates).
  public private(set) var committedLines = 0
  public private(set) var committedFlagged = 0
  /// Lines refused because they came after the writer was cut back to the window's end.
  public private(set) var refusedLines = 0
  /// Written since the last fsync.
  public private(set) var dirty = false

  private let file: DurableFile
  private var pending: [(t: Double, bytes: Data, flagged: Bool)] = []
  private var hash = Sha256Stream()
  private var lastCommittedT: Double?
  private var cutT: Double?
  private var cut: CutCheckpoint?
  /// The window's end once cut back to it: later lines past it are refused.
  private var endT: Double?

  init(path: String, file: DurableFile) {
    self.path = path
    self.file = file
  }

  /// Holds an encoded line until a flush. Lines come in file order: `t` never decreases.
  public func enqueue(_ line: Data, t: Double, flagged: Bool = false) {
    if let endT, t > endT {
      refusedLines += 1
      return
    }
    pending.append((t, line, flagged))
    backlogBytes += line.count
  }

  /// The digest of what is committed, as recording.json will list it.
  public var digest: FileDigest {
    FileDigest(path: path, bytes: committedBytes, sha256: hash.hex())
  }

  /// Writes every waiting line with `t ≤ watermark` in one write(2). On a failure the file is
  /// truncated back to its committed length and the lines stay waiting (design 7.7).
  public func flush(watermark: Double) throws {
    var count = 0
    while count < pending.count && pending[count].t <= watermark { count += 1 }
    guard count > 0 else { return }
    var batch = Data()
    var next = hash
    var flagged = 0
    var mark: CutCheckpoint?
    for index in 0..<count {
      let line = pending[index]
      if let cutT, cut == nil, mark == nil, line.t > cutT {
        mark = CutCheckpoint(
          bytes: committedBytes + Int64(batch.count), hash: next.snapshot(),
          lines: committedLines + index, flagged: committedFlagged + flagged)
      }
      batch.append(line.bytes)
      next.update(line.bytes)
      if line.flagged { flagged += 1 }
    }
    do {
      try file.appendAll(batch)
    } catch {
      try? file.truncate(to: committedBytes)
      throw error
    }
    committedBytes += Int64(batch.count)
    hash = next
    committedLines += count
    committedFlagged += flagged
    lastCommittedT = pending[count - 1].t
    if let mark { cut = mark }
    pending.removeFirst(count)
    backlogBytes -= batch.count
    dirty = true
  }

  /// An end anchor's margin ends at `cutT`: the next flush that reaches a line past it notes
  /// where the file stands first. A later end anchor moves the cut, and forgets the old one.
  public func registerCut(_ cutT: Double) {
    self.cutT = cutT
    cut = nil
  }

  /// Cuts the file back to the window's end: to the cut checkpoint for a stop cut back on disk
  /// (`useCut`; a truncate, nothing reread), else by dropping the waiting lines past `endT`,
  /// which never reached the disk. Lines past `endT` that come later are refused.
  public func cutBack(to endT: Double, useCut: Bool) throws {
    if useCut, cutT == endT, let cut {
      try file.truncate(to: cut.bytes)
      committedBytes = cut.bytes
      hash = cut.hash
      committedLines = cut.lines
      committedFlagged = cut.flagged
      lastCommittedT = nil
      dirty = true
    } else if let lastCommittedT, lastCommittedT > endT {
      throw RecordingWriterError.committedPastEnd
    }
    self.cut = nil
    pending.removeAll { $0.t > endT }
    backlogBytes = pending.reduce(0) { $0 + $1.bytes.count }
    self.endT = endT
  }

  /// fsync(2), if anything was written since the last.
  public func sync() throws {
    guard dirty else { return }
    try file.fsync()
    dirty = false
  }

  /// Writes what is left, syncs and closes. The digest is the incremental one.
  public func finish() throws -> FileDigest {
    try flush(watermark: .infinity)
    try sync()
    file.close()
    return digest
  }

  /// Closes without writing: the recording is being deleted, or left to recovery.
  public func abandon() {
    pending = []
    backlogBytes = 0
    file.close()
  }
}
#endif
