#if USG_RECORDER
import Foundation

/// Applies SinkCommands to files held in memory: the reference FileSink is checked against
/// byte for byte (design 14), and what RecorderCore's tests read back. It does what FileSink
/// does at the level of lines and documents, without the buffering, syncing and protection,
/// and keeps the journal's records for the recovery tests.
///
/// SHA-256 and DEFLATE come from the caller, since CaptureCore is Foundation only: the tests
/// pass their own, FileSink's checks pass CaptureIO's.
public final class MemorySink {
  public enum State: Equatable, Sendable {
    /// No recording yet.
    case empty
    case open
    /// Finalize ran; waiting for the final boundary flush.
    case awaitingBoundary
    case finished
    case deleted
  }

  public private(set) var state: State = .empty
  public private(set) var journal: [JournalRecord] = []
  /// The journal is deleted at the end of a finalize and with the recording.
  public private(set) var journalDeleted = false
  public private(set) var recordingJson: Data?
  public private(set) var cuts: [Double] = []
  public private(set) var stopSessionCount = 0
  /// Lines that came when no file could take them, or didn't encode (too long, not finite).
  public private(set) var skippedLines = 0
  public private(set) var meshRunner = MeshJobRunner()

  private struct Stored {
    let t: Double
    let bytes: Data
    let candidate: Bool
    /// history.bin's length after this line's block, for a mesh line with one.
    let binEnd: Int?
  }

  private var streams: [RecordingFilePath: [Stored]] = [:]
  private var bin: Data?
  private var pending: CloseOrder?
  private var checkpointSeq = 0
  private let digest: (Data) -> String
  private let deflate: (Data) throws -> Data
  private let encoder = LineEncoder()

  /// The files a recording has from its open, empty or not (docs/session-recording.md,
  /// "Layout"). altitude.jsonl and location.jsonl appear with their first line, the mesh history
  /// with its first snapshot.
  static let createdAtOpen: [RecordingFilePath] = [
    .frames, .imu, .motion, .anchors, .events, .actions, .telemetry, .boundary,
  ]

  public init(digest: @escaping (Data) -> String, deflate: @escaping (Data) throws -> Data) {
    self.digest = digest
    self.deflate = deflate
  }

  public func apply(_ commands: [SinkCommand]) {
    for command in commands { apply(command) }
  }

  public func apply(_ command: SinkCommand) {
    switch command {
    case .createRecording(_, let journalOpen, let manifest):
      guard state == .empty else { return }
      journal = [journalOpen]
      recordingJson = manifest
      for path in Self.createdAtOpen { streams[path] = [] }
      state = .open
    case .lines(let lines):
      for line in lines { append(line) }
    case .mesh(let job):
      guard state == .open else { return }
      if bin == nil {
        bin = Data()
        streams[.meshIndex] = []
      }
      for output in meshRunner.run(job, deflate: deflate) { append(output) }
    case .journal(let record):
      guard state == .open else { return }
      journal.append(record)
    case .registerCut(let cutT):
      cuts.append(cutT)
    case .finalize(let order):
      finalize(order)
    case .boundaryFlushed:
      if state == .awaitingBoundary { complete() }
    case .stopSession:
      stopSessionCount += 1
    case .deleteRecording:
      streams = [:]
      bin = nil
      recordingJson = nil
      journalDeleted = true
      state = .deleted
    }
  }

  /// The final boundary flush didn't come within its second: finish without it.
  public func boundaryWaitExpired() {
    if state == .awaitingBoundary { complete() }
  }

  /// A journal checkpoint of the files as they are, as FileSink writes every 5 s.
  public func checkpoint() {
    guard state == .open else { return }
    var sizes: [String: Int64] = [:]
    for path in streams.keys { sizes[path.rawValue] = Int64(stream(path).count) }
    journal.append(
      .checkpoint(
        JournalCheckpoint(seq: checkpointSeq, sizes: sizes, binBytes: Int64(bin?.count ?? 0))))
    checkpointSeq += 1
  }

  /// A file's bytes by its path in `rec-<id>/`, recording.json included, or nil when it doesn't
  /// exist.
  public func file(_ path: String) -> Data? {
    if path == "recording.json" { return recordingJson }
    if path == RecordingFilePath.meshBin.rawValue { return bin }
    guard let file = RecordingFilePath(rawValue: path), streams[file] != nil else { return nil }
    return stream(file)
  }

  /// Every file that exists, sorted.
  public var paths: [String] {
    var paths = streams.keys.map(\.rawValue)
    if bin != nil { paths.append(RecordingFilePath.meshBin.rawValue) }
    if recordingJson != nil { paths.append("recording.json") }
    return paths.sorted()
  }

  /// The journal as its file holds it.
  public var journalBytes: Data {
    journal.reduce(into: Data()) { data, record in
      if let line = try? Journal.encode(record) { data.append(line) }
    }
  }

  private func stream(_ path: RecordingFilePath) -> Data {
    (streams[path] ?? []).reduce(into: Data()) { $0.append($1.bytes) }
  }

  private func append(_ line: PendingLine) {
    let open = state == .open || (state == .awaitingBoundary && line.file == .boundary)
    guard open, line.file != .meshBin, let bytes = try? line.encode(encoder) else {
      skippedLines += 1
      return
    }
    streams[line.file, default: []].append(
      Stored(t: line.t, bytes: bytes, candidate: line.isCandidateFrame, binEnd: nil))
  }

  private func append(_ output: MeshOutput) {
    guard var bin, let bytes = try? output.line.encode(encoder) else {
      skippedLines += 1
      return
    }
    switch output.block {
    case .bytes(let data)?:
      bin.append(data)
    case .copy(let offset, let count)?:
      let start = Int(offset)
      bin.append(bin.subdata(in: start..<(start + count)))
    case nil:
      break
    }
    self.bin = bin
    streams[.meshIndex, default: []].append(
      Stored(
        t: output.line.t, bytes: bytes, candidate: false,
        binEnd: output.block == nil ? nil : bin.count))
  }

  /// Design 7.5 in memory: every file cut back to the window's end (a cut checkpoint or the
  /// watermark buffers in FileSink, the same bytes either way), then the closing lines, then
  /// `closed{}` in the journal before the wait for the boundary flush (step 3).
  private func finalize(_ order: CloseOrder) {
    guard state == .open else { return }
    let endT = order.window.endT
    for (path, lines) in streams {
      streams[path] = lines.filter { $0.t <= endT }
    }
    if bin != nil {
      let end = streams[.meshIndex]?.compactMap(\.binEnd).last ?? 0
      bin = bin?.prefix(end)
    }
    for line in order.closingLines { append(line) }
    let close = order.window
    journal.append(
      .closed(
        JournalClosed(
          endT: close.endT, reason: close.reason, trimmed: close.trimmed,
          finalSample: close.finalSample)))
    pending = order
    state = .awaitingBoundary
    if !order.awaitBoundary { complete() }
  }

  private func complete() {
    guard let order = pending, let opening = recordingJson else { return }
    let close = order.window
    let rates = AchievedRates.over(
      startT: close.startT, endT: close.endT, frames: streams[.frames]?.count ?? 0,
      candidates: streams[.frames]?.filter(\.candidate).count ?? 0,
      imu: streams[.imu]?.count ?? 0, motion: streams[.motion]?.count ?? 0,
      snapshotTs: order.meshSnapshotTs)
    var files = streams.keys.map { path in
      let data = stream(path)
      return FileDigest(path: path.rawValue, bytes: Int64(data.count), sha256: digest(data))
    }
    if let bin {
      files.append(
        FileDigest(
          path: RecordingFilePath.meshBin.rawValue, bytes: Int64(bin.count), sha256: digest(bin)))
    }
    recordingJson =
      (try? RecordingDocuments.closed(
        opening: opening, window: close, rates: rates, files: files, closed: true)) ?? opening
    journal.append(.manifest)
    journalDeleted = true
    pending = nil
    state = .finished
  }
}
#endif
