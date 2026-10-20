#if USG_RECORDER
import CaptureCore
import Foundation

// RecorderCore's SinkCommands applied to files (design 3.2 and 7), on the I/O queue: the journal,
// `rec-<id>/` and recording.json at the open, the lines behind the watermark, the mesh history,
// the cut checkpoints, and the finalize of design 7.5. It writes what MemorySink holds, byte for
// byte, for the same commands (design 14). What it can't do itself it hands back as notices: the
// host passes `closeRequested` to RecorderCore.sinkLimitReached, `finalized` to
// finalizeCompleted, and `stopSession` to the glue, which pauses the ARSession on main.
//
// The host calls `tick()` every second (the watermark flush) and `checkpoint()` every 5 s (fsync
// and a journal checkpoint), and `boundaryWaitExpired()` a second after `awaitingBoundary` if
// TypeScript's final flush hasn't come.

/// The I/O settings (design 7.2, 7.3 and 7.7), tuned from the walk's figures.
public struct RecorderIOConfig: Equatable, Sendable {
  /// Lines wait until the newest frame is this much newer.
  public var watermarkLagS: Double
  /// Bytes waiting in memory before the sink gives up on a stalled disk (`disk`).
  public var maxBacklogBytes: Int
  /// The recording's size limit, `maxRecordingBytes` (`limit`).
  public var maxRecordingBytes: Int64
  /// Each JSONL file's limit, `maxJsonlBytes`.
  public var maxJsonlBytes: Int64
  /// history.bin's limit, `maxMeshHistoryBytes`.
  public var maxMeshHistoryBytes: Int64

  public init(
    watermarkLagS: Double = 0.5, maxBacklogBytes: Int = 64 << 20,
    maxRecordingBytes: Int64 = 8 << 30, maxJsonlBytes: Int64 = 256 << 20,
    maxMeshHistoryBytes: Int64 = 2 << 30
  ) {
    self.watermarkLagS = watermarkLagS
    self.maxBacklogBytes = maxBacklogBytes
    self.maxRecordingBytes = maxRecordingBytes
    self.maxJsonlBytes = maxJsonlBytes
    self.maxMeshHistoryBytes = maxMeshHistoryBytes
  }

  public static let lean = RecorderIOConfig()
}

/// Why the sink stopped and left the recording to recovery at the next launch.
public enum SinkFailure: String, Sendable {
  /// The journal, the directory or recording.json couldn't be created; nothing is kept.
  case create
  /// A write failed even after the ballast was released.
  case io
  /// Lines past the window's end were on disk with no cut checkpoint to take them back.
  case cut
}

/// What the host must act on.
public enum SinkNotice: Equatable, Sendable {
  /// End the session here: pause the ARSession.
  case stopSession
  /// The sink can't go on: close the window with this reason (`disk` or `limit`).
  case closeRequested(WindowEndReason)
  /// Finalize waits for TypeScript's final boundary flush, at most a second.
  case awaitingBoundary
  /// recording.json is final: the recording is closed.
  case finalized
  case deleted
  /// Writing stopped; recovery finishes or removes the recording at the next launch.
  case failed(SinkFailure)
}

/// Counts for the debug figures (design 13). Sizes and counts only.
public struct SinkFigures: Equatable, Sendable {
  public var committedBytes: Int64 = 0
  public var backlogBytes = 0
  public var linesSkipped = 0
  public var linesRefused = 0
  public var writeFailures = 0
  public var checkpoints = 0
  public var ballastFailures = 0
  public var mesh = MeshJobCounts()
}

public final class FileSink {
  public enum State: Equatable, Sendable {
    case empty
    case open
    /// Finalize ran up to `closed{}`; waiting for the final boundary flush.
    case awaitingBoundary
    /// recording.json is final; the files wait for the protection upgrade until unlock.
    case protectionPending
    case finished
    case deleted
    case failed
  }

  public let store: RecordingStore
  public let config: RecorderIOConfig
  public private(set) var state: State = .empty
  public private(set) var recordingID: UUID?
  /// The newest frames.jsonl line's `t`: the watermark follows it.
  public private(set) var latestFrameT: Double?

  /// The system calls the files use; the tests script them.
  var calls: FileCalls = .system

  private var paths: RecordingPaths { store.paths }
  private var security: any FileSecurity { store.security }
  private var journalFile: DurableFile?
  /// The journal's length up to its last whole, synced record.
  private var journalBytes: Int64 = 0
  private var writers: [RecordingFilePath: JsonlFileWriter] = [:]
  private var mesh: MeshHistoryWriter?
  private var meshRunner = MeshJobRunner()
  private var opening: Data?
  private var cutT: Double?
  private var pendingOrder: CloseOrder?
  private var checkpointSeq = 0
  private var enqueuedBytes: Int64 = 0
  private var requested: WindowEndReason?
  /// A write failed: no more flushes until the finalize, which tries once more.
  private var writeFailed = false
  private var counts = SinkFigures()
  private let encoder = LineEncoder()

  public init(store: RecordingStore, config: RecorderIOConfig = .lean) {
    self.store = store
    self.config = config
  }

  public var figures: SinkFigures {
    var figures = counts
    figures.committedBytes =
      writers.values.reduce(0) { $0 + $1.committedBytes }
      + (mesh.map { $0.committedBinBytes + $0.committedIndexBytes } ?? 0)
    figures.backlogBytes = backlogBytes
    figures.linesRefused =
      writers.values.reduce(0) { $0 + $1.refusedLines } + (mesh?.refusedLines ?? 0)
    figures.mesh = meshRunner.counts
    return figures
  }

  // MARK: - Commands

  @discardableResult
  public func apply(_ commands: [SinkCommand]) -> [SinkNotice] {
    var notices: [SinkNotice] = []
    for command in commands { notices += apply(command) }
    return notices
  }

  @discardableResult
  public func apply(_ command: SinkCommand) -> [SinkNotice] {
    switch command {
    case .createRecording(let id, let journalOpen, let manifest):
      return create(id: id, journalOpen: journalOpen, manifest: manifest)
    case .lines(let lines):
      var notices: [SinkNotice] = []
      for line in lines { notices += append(line, closing: false) }
      return notices
    case .mesh(let job):
      return appendMesh(job)
    case .journal(let record):
      guard state == .open else { return [] }
      do {
        try writeJournal(record)
      } catch {
        return writeFailure()
      }
      switch record {
      case .end, .closing: return checkpoint()
      default: return []
      }
    case .registerCut(let cutT):
      self.cutT = cutT
      for writer in writers.values { writer.registerCut(cutT) }
      mesh?.registerCut(cutT)
      return []
    case .finalize(let order):
      return finalize(order)
    case .boundaryFlushed:
      return state == .awaitingBoundary ? complete() : []
    case .stopSession:
      return [.stopSession]
    case .deleteRecording(let id):
      return delete(id)
    }
  }

  /// The final boundary flush didn't come within its second: finish without it.
  public func boundaryWaitExpired() -> [SinkNotice] {
    state == .awaitingBoundary ? complete() : []
  }

  /// Every second: each file writes its lines behind the watermark.
  public func tick() -> [SinkNotice] {
    guard state == .open, !writeFailed, let latestFrameT else { return [] }
    do {
      try flushAll(watermark: latestFrameT - config.watermarkLagS)
    } catch {
      return writeFailure()
    }
    if backlogBytes > config.maxBacklogBytes { return request(.disk) }
    return []
  }

  /// Every 5 s, and at the open, each end mark and closing: fsync what was written, then a
  /// journal checkpoint of the committed sizes, full-synced (design 7.3).
  public func checkpoint() -> [SinkNotice] {
    guard state == .open, !writeFailed else { return [] }
    do {
      for writer in writers.values { try writer.sync() }
      try mesh?.sync()
      var sizes: [String: Int64] = [:]
      for (path, writer) in writers { sizes[path.rawValue] = writer.committedBytes }
      if let mesh { sizes[MeshHistoryWriter.indexPath] = mesh.committedIndexBytes }
      try writeJournal(
        .checkpoint(
          JournalCheckpoint(
            seq: checkpointSeq, sizes: sizes, binBytes: mesh?.committedBinBytes ?? 0)))
      checkpointSeq += 1
      counts.checkpoints += 1
    } catch {
      return writeFailure()
    }
    return []
  }

  /// Closes every descriptor without another write, leaving the files and the journal as a
  /// crash would, for recovery to finish: capture-synth's and the tests' interrupted sessions.
  public func abandon() {
    for writer in writers.values { writer.abandon() }
    mesh?.abandon()
    journalFile?.close()
    journalFile = nil
    if let id = recordingID { store.clearBusy(id) }
    state = .failed
  }

  /// The phone was unlocked: a recording whose files wait for the upgrade gets it now.
  public func protectedDataBecameAvailable() -> [SinkNotice] {
    guard state == .protectionPending, let id = recordingID else { return [] }
    guard (try? store.protect(id)) != nil else { return [] }
    finishUp(id)
    return []
  }

  // MARK: - Opening

  /// Design section 6, the open: the journal's `open` full-synced before `rec-<id>/` exists
  /// (D3), the directory, recording.json, the ballast, the files every recording has, and a
  /// first checkpoint.
  private func create(id: UUID, journalOpen: JournalRecord, manifest: Data) -> [SinkNotice] {
    guard state == .empty else { return [] }
    recordingID = id
    guard store.markBusy(id) else {
      state = .failed
      return [.failed(.create)]
    }
    do {
      try store.prepareRoots()
      journalFile = try DurableFile.create(
        paths.journal(id), mode: .appendWriteOnly, protection: .completeUnlessOpen,
        security: security, calls: calls)
      try writeJournal(journalOpen)
      try security.createDirectory(paths.recording(id), .completeUnlessOpen)
      try AtomicJsonWriter.replace(
        manifest, at: paths.manifest(of: id), staging: paths.staging,
        protection: .completeUnlessOpen, security: security)
      opening = manifest
      for path in MemorySink.createdAtOpen { _ = try writer(path) }
    } catch {
      for writer in writers.values { writer.abandon() }
      writers = [:]
      journalFile?.close()
      journalFile = nil
      try? deleteItem(paths.recording(id))
      try? deleteItem(paths.journal(id))
      store.clearBusy(id)
      state = .failed
      return [.failed(.create)]
    }
    do {
      try store.reserveBallast(id)
    } catch {
      counts.ballastFailures += 1
    }
    state = .open
    return checkpoint()
  }

  private func writer(_ path: RecordingFilePath) throws -> JsonlFileWriter {
    if let writer = writers[path] { return writer }
    guard let id = recordingID else { throw IOFailure.closed }
    let file = try DurableFile.create(
      paths.file(path, of: id), mode: .appendWriteOnly, protection: .completeUnlessOpen,
      security: security, calls: calls)
    let writer = JsonlFileWriter(path: path.rawValue, file: file)
    if let cutT { writer.registerCut(cutT) }
    writers[path] = writer
    return writer
  }

  private func meshWriter() throws -> MeshHistoryWriter {
    if let mesh { return mesh }
    guard let id = recordingID else { throw IOFailure.closed }
    try security.createDirectory(paths.meshDirectory(of: id), .completeUnlessOpen)
    let bin = try DurableFile.create(
      paths.file(.meshBin, of: id), mode: .appendReadWrite, protection: .completeUnlessOpen,
      security: security, calls: calls)
    let index = try DurableFile.create(
      paths.file(.meshIndex, of: id), mode: .appendWriteOnly, protection: .completeUnlessOpen,
      security: security, calls: calls)
    let writer = MeshHistoryWriter(bin: bin, index: index)
    if let cutT { writer.registerCut(cutT) }
    mesh = writer
    return writer
  }

  // MARK: - Lines

  /// A line into its file's writer: while open, or the boundary file while finalize waits for
  /// the final flush, or a closing line during the finalize. A line that doesn't encode, or
  /// would pass its file's limit, is skipped and counted.
  private func append(_ line: PendingLine, closing: Bool) -> [SinkNotice] {
    let accepting =
      state == .open || closing || (state == .awaitingBoundary && line.file == .boundary)
    guard accepting, line.file != .meshBin, line.file != .meshIndex,
      let bytes = try? line.encode(encoder)
    else {
      counts.linesSkipped += 1
      return []
    }
    let writer: JsonlFileWriter
    do {
      writer = try self.writer(line.file)
    } catch {
      return writeFailure()
    }
    if writer.committedBytes + Int64(writer.backlogBytes + bytes.count) > config.maxJsonlBytes {
      counts.linesSkipped += 1
      return request(.limit)
    }
    writer.enqueue(bytes, t: line.t, flagged: line.isCandidateFrame)
    enqueuedBytes += Int64(bytes.count)
    if line.file == .frames { latestFrameT = max(latestFrameT ?? line.t, line.t) }
    return enqueuedBytes > config.maxRecordingBytes ? request(.limit) : []
  }

  /// A snapshot through the mesh ledger and DEFLATE, then into the history's writer, in the
  /// order the ledger placed the blocks.
  private func appendMesh(_ job: MeshJob) -> [SinkNotice] {
    guard state == .open else { return [] }
    let writer: MeshHistoryWriter
    do {
      writer = try meshWriter()
    } catch {
      return writeFailure()
    }
    for output in meshRunner.run(job, deflate: Deflate.raw) {
      guard let line = try? output.line.encode(encoder) else {
        counts.linesSkipped += 1
        continue
      }
      do {
        try writer.enqueue(t: output.line.t, block: output.block, line: line)
      } catch {
        return writeFailure()
      }
      enqueuedBytes += Int64(line.count)
      if case .bytes(let block)? = output.block { enqueuedBytes += Int64(block.count) }
    }
    if writer.binBytes > config.maxMeshHistoryBytes || enqueuedBytes > config.maxRecordingBytes {
      return request(.limit)
    }
    return []
  }

  private var backlogBytes: Int {
    writers.values.reduce(0) { $0 + $1.backlogBytes } + (mesh?.backlogBytes ?? 0)
  }

  private func flushAll(watermark: Double) throws {
    for path in writers.keys.sorted(by: { $0.rawValue < $1.rawValue }) {
      try writers[path]?.flush(watermark: watermark)
    }
    try mesh?.flush(watermark: watermark)
  }

  private func syncAll() throws {
    for writer in writers.values { try writer.sync() }
    try mesh?.sync()
  }

  /// A record full-synced onto the journal. A failed write or sync is cut back to the last whole
  /// record, as the writers' are (design 7.7): recovery reads the journal only up to its first
  /// torn line, so a torn checkpoint would hide the `closed{}` written after it.
  private func writeJournal(_ record: JournalRecord) throws {
    guard let journalFile else { throw IOFailure.closed }
    let bytes = try Journal.encode(record)
    do {
      try journalFile.appendAll(bytes)
      try journalFile.fullSync()
    } catch {
      try? journalFile.truncate(to: journalBytes)
      throw error
    }
    journalBytes += Int64(bytes.count)
  }

  /// Asks for the window to close, once.
  private func request(_ reason: WindowEndReason) -> [SinkNotice] {
    guard requested == nil else { return [] }
    requested = reason
    return [.closeRequested(reason)]
  }

  /// A write failed (ENOSPC, EIO or another): the writer already truncated back to what it had
  /// committed, so no partial line stays. The ballast goes, giving the finalize room, and the
  /// window closes as `disk` (design 7.7).
  private func writeFailure() -> [SinkNotice] {
    counts.writeFailures += 1
    writeFailed = true
    if let id = recordingID { store.releaseBallast(id) }
    return state == .open ? request(.disk) : []
  }

  // MARK: - Closing

  /// Design 7.5, steps 1 to 4: every file cut back to the window's end, the closing lines, the
  /// files written out and synced, then `closed{}` in the journal.
  private func finalize(_ order: CloseOrder) -> [SinkNotice] {
    guard state == .open else { return [] }
    let endT = order.window.endT
    do {
      for writer in writers.values { try writer.cutBack(to: endT, useCut: order.useCut) }
      try mesh?.cutBack(to: endT, useCut: order.useCut)
    } catch RecordingWriterError.committedPastEnd {
      return fail(.cut)
    } catch {
      return fail(.io)
    }
    for line in order.closingLines { _ = append(line, closing: true) }
    let close = order.window
    do {
      try flushAll(watermark: .infinity)
      try syncAll()
      try writeJournal(
        .closed(
          JournalClosed(
            endT: close.endT, reason: close.reason, trimmed: close.trimmed,
            finalSample: close.finalSample)))
    } catch {
      return fail(.io)
    }
    pendingOrder = order
    state = .awaitingBoundary
    return order.awaitBoundary ? [.awaitingBoundary] : complete()
  }

  /// Design 7.5, steps 5 to 8: the files closed with their incremental digests, the rates,
  /// recording.json replaced atomically, `manifest{}`, the protection upgrade (or
  /// `protectionPending{}` while locked), then the ballast and the journal go.
  private func complete() -> [SinkNotice] {
    guard let order = pendingOrder, let opening, let id = recordingID else { return [] }
    let close = order.window
    var files: [FileDigest] = []
    do {
      for path in writers.keys.sorted(by: { $0.rawValue < $1.rawValue }) {
        if let writer = writers[path] { files.append(try writer.finish()) }
      }
      if let mesh { files += try mesh.finish() }
    } catch {
      return fail(.io)
    }
    let rates = AchievedRates.over(
      startT: close.startT, endT: close.endT, frames: writers[.frames]?.committedLines ?? 0,
      candidates: writers[.frames]?.committedFlagged ?? 0,
      imu: writers[.imu]?.committedLines ?? 0, motion: writers[.motion]?.committedLines ?? 0,
      snapshotTs: order.meshSnapshotTs)
    do {
      let manifest = try RecordingDocuments.closed(
        opening: opening, window: close, rates: rates, files: files, closed: true)
      try AtomicJsonWriter.replace(
        manifest, at: paths.manifest(of: id), staging: paths.staging,
        protection: .completeUnlessOpen, security: security)
      try writeJournal(.manifest)
    } catch {
      return fail(.io)
    }
    pendingOrder = nil
    if security.protectedDataAvailable, (try? store.protect(id)) != nil {
      finishUp(id)
    } else {
      try? writeJournal(.protectionPending)
      state = .protectionPending
    }
    return [.finalized]
  }

  private func finishUp(_ id: UUID) {
    store.releaseBallast(id)
    journalFile?.close()
    journalFile = nil
    try? deleteItem(paths.journal(id))
    store.clearBusy(id)
    state = .finished
  }

  /// Stops writing and leaves the journal for recovery at the next launch, which cuts the
  /// recording back or removes it.
  private func fail(_ failure: SinkFailure) -> [SinkNotice] {
    for writer in writers.values { writer.abandon() }
    mesh?.abandon()
    journalFile?.close()
    journalFile = nil
    if let id = recordingID {
      store.releaseBallast(id)
      store.clearBusy(id)
    }
    state = .failed
    return [.failed(failure)]
  }

  private func delete(_ id: UUID) -> [SinkNotice] {
    guard id == recordingID, state != .deleted else { return [] }
    for writer in writers.values { writer.abandon() }
    writers = [:]
    mesh?.abandon()
    mesh = nil
    journalFile?.close()
    journalFile = nil
    // The directory first: a journal left alone is discarded at the next launch.
    try? deleteItem(paths.recording(id))
    store.releaseBallast(id)
    try? deleteItem(paths.journal(id))
    store.clearBusy(id)
    state = .deleted
    return [.deleted]
  }
}
#endif
