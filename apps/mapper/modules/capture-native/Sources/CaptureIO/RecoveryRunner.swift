#if USG_RECORDER
import CaptureCore
import Foundation

// Recovery at launch (design 7, "Recovery at launch"; D2, D3 and section 12), on the I/O queue
// once protected data is available, before any `start`. It only ever removes: lines past a
// window's end, torn tails, the final sample and `recording_closed` of a recording it cuts back,
// whole recordings that can't be kept, and leftovers. It is idempotent, so a crash during it is
// finished at the next launch, and it reports counts only.

/// What recovery did, as counts (design 3.2).
public struct RecoveryReport: Equatable, Sendable {
  /// False when it couldn't run (the phone locked).
  public var done = false
  /// Cut off and cut back: `interrupted`, `closed: false`.
  public var recovered = 0
  /// Closed by the recorder but not finished: completed with `closed: true`.
  public var finished = 0
  public var discarded = 0
  /// Already final: only the protection upgrade, and the journal removed.
  public var swept = 0
  /// Exports that were complete when the app died before their raw files went: verified, and
  /// the raw files deleted.
  public var exportsCompleted = 0
  /// Exports that failed that check: removed, the raw files kept.
  public var exportsRemoved = 0
  /// Recordings whose repair failed on an I/O error; tried again at the next launch.
  public var failed = 0

  public init() {}
}

public final class RecoveryRunner {
  public let store: RecordingStore
  /// Chunk size for reading files back.
  static let chunkBytes = 1 << 20

  private var paths: RecordingPaths { store.paths }
  private var security: any FileSecurity { store.security }

  public init(store: RecordingStore) {
    self.store = store
  }

  public func run() -> RecoveryReport {
    var report = RecoveryReport()
    guard security.protectedDataAvailable, (try? store.prepareRoots()) != nil else {
      return report
    }
    let fm = FileManager.default
    // 1. Leftovers: staging files, export staging, ballasts and the self-test's sets.
    for directory in [paths.staging, paths.exportsStagingRoot] {
      for name in (try? fm.contentsOfDirectory(atPath: directory.path)) ?? [] {
        try? deleteItem(directory.appendingPathComponent(name))
      }
    }
    let names = (try? fm.contentsOfDirectory(atPath: paths.recordingsRoot.path)) ?? []
    for name in names {
      if let id = RecordingPaths.ballastID(name: name), !store.isBusy(id) {
        store.releaseBallast(id)
      }
    }
    try? deleteItem(paths.selfTestRoot)

    // 2. Each journal.
    let journals = names.compactMap(RecordingPaths.journalID(name:))
      .sorted { $0.uuidString < $1.uuidString }
    for id in journals where store.markBusy(id) {
      defer { store.clearBusy(id) }
      recover(id, into: &report)
    }

    // 3. Each recording without a journal (design D3), other than those step 2 just handled.
    let left = ((try? fm.contentsOfDirectory(atPath: paths.recordingsRoot.path)) ?? [])
    let withJournal = Set(left.compactMap(RecordingPaths.journalID(name:))).union(journals)
    for id in left.compactMap(RecordingPaths.recordingID(name:)) where !withJournal.contains(id) {
      guard store.markBusy(id) else { continue }
      defer { store.clearBusy(id) }
      let json = fm.contents(atPath: paths.manifest(of: id).path)
      switch RecoveryPlan.make(journal: nil, recordingJson: json, lastWrittenT: nil) {
      case .sweepOnly:
        if (try? store.protect(id)) != nil { report.swept += 1 } else { report.failed += 1 }
      default:
        try? deleteItem(paths.recording(id))
        report.discarded += 1
      }
    }

    // 4. An export next to a surviving raw recording: the app died between the rename and the
    // delete. Verified, the raw files go; otherwise the export goes.
    let exports = ((try? fm.contentsOfDirectory(atPath: paths.exportsRoot.path)) ?? [])
      .compactMap(RecordingPaths.replayID(name:))
    for id in exports where fm.fileExists(atPath: paths.recording(id).path) {
      guard !fm.fileExists(atPath: paths.journal(id).path), store.markBusy(id) else { continue }
      defer { store.clearBusy(id) }
      if verifyExport(id) {
        try? deleteItem(paths.recording(id))
        report.exportsCompleted += 1
      } else {
        try? deleteItem(paths.export(id))
        report.exportsRemoved += 1
      }
    }
    report.done = true
    return report
  }

  // MARK: - One journal

  private func recover(_ id: UUID, into report: inout RecoveryReport) {
    let fm = FileManager.default
    let journalURL = paths.journal(id)
    let reading = Journal.decode(fm.contents(atPath: journalURL.path) ?? Data())
    let summary = reading.summary
    let directory = paths.recording(id)
    let json = fm.contents(atPath: paths.manifest(of: id).path)
    guard fm.fileExists(atPath: directory.path), !summary.discarded else {
      discard(id)
      report.discarded += 1
      return
    }
    if summary.manifestWritten {
      sweep(id, into: &report)
      return
    }
    let lastWrittenT = lastWrittenT(id)
    let plan = RecoveryPlan.make(journal: summary, recordingJson: json, lastWrittenT: lastWrittenT)
    switch plan {
    case .discard:
      discard(id)
      report.discarded += 1
    case .sweepOnly:
      sweep(id, into: &report)
    case .finishClean(let window), .cut(let window):
      guard let json, RecordingDocuments.facts(json) != nil else {
        // The open was journaled but recording.json never made it: nothing to finish.
        discard(id)
        report.discarded += 1
        return
      }
      do {
        try repair(
          id, window: window, opening: json,
          checkpointBinBytes: summary.lastCheckpoint?.binBytes ?? 0)
        try appendManifestRecord(id, validBytes: reading.validBytes)
      } catch {
        report.failed += 1
        return
      }
      if window.closed { report.finished += 1 } else { report.recovered += 1 }
      if (try? store.protect(id)) != nil { try? deleteItem(journalURL) }
    }
  }

  private func sweep(_ id: UUID, into report: inout RecoveryReport) {
    if (try? store.protect(id)) != nil {
      try? deleteItem(paths.journal(id))
      report.swept += 1
    } else {
      report.failed += 1
    }
  }

  private func discard(_ id: UUID) {
    try? deleteItem(paths.recording(id))
    try? deleteItem(paths.journal(id))
  }

  /// The latest `t` of a whole, ordered line across the recording's files.
  private func lastWrittenT(_ id: UUID) -> Double? {
    var latest: Double?
    for path in RecordingFilePath.allCases where path != .meshBin {
      let url = paths.file(path, of: id)
      guard FileManager.default.fileExists(atPath: url.path) else { continue }
      var scanner = JsonlScanner()
      try? stream(url) { scanner.feed($0) }
      if let t = scanner.finish().lastT { latest = max(latest ?? t, t) }
    }
    return latest
  }

  /// Cuts every file back to the window, drops what a cut-back recording mustn't have, rehashes
  /// and writes recording.json atomically.
  private func repair(
    _ id: UUID, window: RecoveredWindow, opening: Data, checkpointBinBytes: Int64
  ) throws {
    let endT = window.close.endT
    var lines: [RecordingFilePath: JsonlScan] = [:]
    for path in RecordingFilePath.allCases where path != .meshBin && path != .meshIndex {
      let url = paths.file(path, of: id)
      guard FileManager.default.fileExists(atPath: url.path) else { continue }
      var scanner = JsonlScanner(
        cutT: endT, dropFinal: window.removesFinalLines,
        dropClosedEvent: window.removesClosedEvent && path == .events)
      try stream(url) { scanner.feed($0) }
      let scan = scanner.finish()
      try truncate(url, to: Int64(scan.keepBytes))
      lines[path] = scan
    }
    let snapshotTs = try repairMesh(
      id, endT: endT, dropFinal: window.removesFinalLines, checkpointBinBytes: checkpointBinBytes)
    try removeUnreferencedBinaries(id)

    var files: [FileDigest] = []
    let directory = paths.recording(id)
    for file in store.files(in: directory) where file.path != "recording.json" {
      var hash = Sha256Stream()
      try stream(directory.appendingPathComponent(file.path)) { hash.update($0) }
      files.append(FileDigest(path: file.path, bytes: hash.byteCount, sha256: hash.hex()))
    }
    let rates = AchievedRates.over(
      startT: window.close.startT, endT: endT, frames: lines[.frames]?.lines ?? 0,
      candidates: lines[.frames]?.candidates ?? 0, imu: lines[.imu]?.lines ?? 0,
      motion: lines[.motion]?.lines ?? 0, snapshotTs: snapshotTs)
    let manifest = try RecordingDocuments.closed(
      opening: opening, window: window.close, rates: rates, files: files, closed: window.closed)
    try AtomicJsonWriter.replace(
      manifest, at: paths.manifest(of: id), staging: paths.staging,
      protection: .completeUnlessOpen, security: security)
  }

  /// history.jsonl against history.bin (RecoveryScan): both cut back to the last whole line
  /// whose block is whole. Blocks past the last checkpoint are inflated to check their length.
  /// One of the pair without the other is removed with the mesh directory.
  private func repairMesh(
    _ id: UUID, endT: Double, dropFinal: Bool, checkpointBinBytes: Int64
  ) throws -> [Double] {
    let fm = FileManager.default
    let indexURL = paths.file(.meshIndex, of: id)
    let binURL = paths.file(.meshBin, of: id)
    let hasIndex = fm.fileExists(atPath: indexURL.path)
    let hasBin = fm.fileExists(atPath: binURL.path)
    guard hasIndex && hasBin else {
      if hasIndex || hasBin { try deleteItem(paths.meshDirectory(of: id)) }
      return []
    }
    var index = Data()
    try stream(indexURL) { index.append($0) }
    let binBytes = fileSize(binURL.path)
    let handle = try FileHandle(forReadingFrom: binURL)
    defer { try? handle.close() }
    let scan = RecoveryScan.meshHistory(
      index: index, binBytes: binBytes, checkpointBinBytes: checkpointBinBytes, cutT: endT,
      dropFinal: dropFinal,
      readBlock: { offset, count in
        guard (try? handle.seek(toOffset: UInt64(offset))) != nil else { return nil }
        return try? handle.read(upToCount: count)
      },
      inflatedLength: { Deflate.inflate($0, limit: MeshBlockLayout.maxBlockBytes)?.count })
    try truncate(indexURL, to: Int64(scan.indexKeepBytes))
    try truncate(binURL, to: scan.binKeepBytes)
    return scan.snapshotTs
  }

  /// `boundary/<seq>.f32` files whose line is gone (design 3.1). Lean writes none.
  private func removeUnreferencedBinaries(_ id: UUID) throws {
    let fm = FileManager.default
    let directory = paths.recording(id).appendingPathComponent("boundary", isDirectory: true)
    guard let names = try? fm.contentsOfDirectory(atPath: directory.path) else { return }
    var referenced = Set<Int>()
    let url = paths.file(.boundary, of: id)
    var text = Data()
    try? stream(url) { text.append($0) }
    for line in text.split(separator: 0x0A) {
      if let fields = try? JSONDecoder().decode(BoundaryFields.self, from: Data(line)),
        fields.binary != nil
      {
        referenced.insert(fields.seq)
      }
    }
    for name in names {
      let seq = name.hasSuffix(".f32") ? Int(name.dropLast(4)) : nil
      if seq.map({ !referenced.contains($0) }) ?? true {
        try deleteItem(directory.appendingPathComponent(name))
      }
    }
  }

  /// `manifest{}` after the journal's last whole record, so a crash before the journal is
  /// deleted only sweeps at the next launch.
  private func appendManifestRecord(_ id: UUID, validBytes: Int) throws {
    let url = paths.journal(id)
    let file = try DurableFile(opening: url, mode: .appendWriteOnly)
    defer { file.close() }
    try file.truncate(to: Int64(validBytes))
    try file.appendAll(try Journal.encode(.manifest))
    try file.fullSync()
  }

  // MARK: - Exports

  /// The parts on disk against parts.json: each part's length and SHA-256, and the whole
  /// tar's, read in 1 MiB chunks.
  private func verifyExport(_ id: UUID) -> Bool {
    guard let facts = store.exportFacts(id), facts.recordingID == id else { return false }
    let directory = paths.export(id)
    var tar = Sha256Stream()
    for part in facts.parts {
      var hash = Sha256Stream()
      let ok = (try? stream(directory.appendingPathComponent(part.name)) {
        hash.update($0)
        tar.update($0)
      }) != nil
      guard ok, hash.byteCount == part.bytes, hash.hex() == part.sha256 else { return false }
    }
    return tar.byteCount == facts.tarBytes && tar.hex() == facts.tarSha256
  }

  // MARK: - Files

  private func truncate(_ url: URL, to length: Int64) throws {
    guard fileSize(url.path) != length else { return }
    let file = try DurableFile(opening: url, mode: .appendWriteOnly)
    defer { file.close() }
    try file.truncate(to: length)
    try file.fsync()
  }
}

/// Reads a file in 1 MiB chunks.
func stream(_ url: URL, chunk: Int = RecoveryRunner.chunkBytes, _ body: (Data) throws -> Void)
  throws
{
  let handle = try FileHandle(forReadingFrom: url)
  defer { try? handle.close() }
  while let data = try handle.read(upToCount: chunk), !data.isEmpty {
    try body(data)
  }
}

private struct BoundaryFields: Decodable {
  let seq: Int
  let binary: String?
}
#endif
