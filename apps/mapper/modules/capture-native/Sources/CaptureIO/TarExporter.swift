#if USG_RECORDER
import CaptureCore
import Foundation

// `exportRecording` (design 9; docs/session-recording.md, "Export and import"): a closed or
// recovered recording packed as a ustar tar straight into 16 MiB parts, re-hashing every source
// file against recording.json on the way, then renamed into `Documents/exports/replay-<id>/` and
// only then the raw files deleted. The plan comes first, so a recording too large to split, or
// without the room for its parts, is refused before anything is written, and the raw files are
// kept whenever the export fails.
//
// Only a grant exports (design section 2): the development build has none, so it can't. The
// grant must be a device grant, checked at run time too. The PC tool capture-synth exports its
// generated recordings through `exportSynthetic`, which exists only where Package.swift defines
// USG_SYNTHETIC_EXPORT (the pods never do, so the app has only the grant path) and refuses any
// recording whose recording.json doesn't say `origin: synthetic`.

/// Why an export failed. The module's error code for each is `code`; none carries a value.
public enum ExportError: Error, Equatable, Sendable {
  /// No device grant, or (`exportSynthetic`) not a synthetic recording.
  case refused
  /// Not closed or recovered yet, or not there.
  case notClosed
  case busy
  /// The phone is locked: the files can't be read (design 7.6).
  case locked
  /// More parts than `maxExportParts`.
  case tooLarge
  /// Less free space than the parts and the headroom.
  case noSpace
  /// A file doesn't match recording.json (size or SHA-256), or isn't there.
  case corrupt
  case io

  public var code: String {
    switch self {
    case .refused: "ERR_EXPORT_REFUSED"
    case .notClosed: "ERR_EXPORT_REFUSED"
    case .busy: "ERR_RECORDING_BUSY"
    case .locked: "ERR_EXPORT_REFUSED"
    case .tooLarge: "ERR_EXPORT_TOO_LARGE"
    case .noSpace: "ERR_NO_SPACE"
    case .corrupt: "ERR_RECORDING_CORRUPT"
    case .io: "ERR_IO"
    }
  }
}

public struct ExportResult: Equatable, Sendable {
  public let parts: Int
  public let tarBytes: Int64
}

/// How far an export is: bytes of the tar written, of all of it.
public struct ExportProgress: Equatable, Sendable {
  public let bytesDone: Int64
  public let bytesTotal: Int64
}

/// The tar an export would write.
public struct ExportPlan: Equatable, Sendable {
  public let layout: TarLayout
  public let parts: PartPlan
  /// recording.json's digests of the files, by member name; recording.json itself has none.
  let expected: [String: FileDigest]
}

public final class TarExporter {
  public let store: RecordingStore
  /// The free space kept beyond the parts (design 9).
  public var headroomBytes: Int64 = 64 << 20
  /// `maxExportParts`; the tests lower it.
  var maxParts = PartPlan.maxParts
  /// The steps where the tests stop an export, as a crash would.
  enum Step: Sendable {
    case rename
    case deleteRaw
  }
  var fault: (Step) throws -> Void = { _ in }

  private let uptime: @Sendable () -> Double
  private var paths: RecordingPaths { store.paths }
  private var security: any FileSecurity { store.security }

  public init(
    store: RecordingStore,
    uptime: @escaping @Sendable () -> Double = { ProcessInfo.processInfo.systemUptime }
  ) {
    self.store = store
    self.uptime = uptime
  }

  /// The tar and its parts for a closed or recovered recording, from recording.json. Refuses
  /// one that is too large, still open, or whose files don't have the listed sizes.
  public func plan(id: UUID) throws -> ExportPlan {
    let fm = FileManager.default
    guard !fm.fileExists(atPath: paths.journal(id).path), let facts = store.manifestFacts(id),
      facts.ended != nil, facts.recordingID == id
    else { throw ExportError.notClosed }
    let prefix = RecordingPaths.recordingName(id) + "/"
    let directory = paths.recording(id)
    var members: [(name: String, size: Int64)] = []
    var expected: [String: FileDigest] = [:]
    for file in facts.files {
      guard fileSize(directory.appendingPathComponent(file.path).path) == file.bytes else {
        throw ExportError.corrupt
      }
      members.append((prefix + file.path, file.bytes))
      expected[prefix + file.path] = file
    }
    members.append((prefix + "recording.json", fileSize(paths.manifest(of: id).path)))
    let layout: TarLayout
    do {
      layout = try TarLayout(files: members)
    } catch {
      throw ExportError.corrupt
    }
    guard PartPlan.partCount(tarBytes: layout.tarBytes) <= maxParts,
      let parts = try? PartPlan(tarBytes: layout.tarBytes)
    else { throw ExportError.tooLarge }
    return ExportPlan(layout: layout, parts: parts, expected: expected)
  }

  /// Exports with the walk build's grant. `progress` is called at most 5 times a second, and
  /// once at the end.
  public func export(
    id: UUID, grant: RecordingGrant, progress: (ExportProgress) -> Void = { _ in }
  ) throws -> ExportResult {
    guard grant.origin == .device else { throw ExportError.refused }
    return try run(id, progress: progress)
  }

  #if USG_SYNTHETIC_EXPORT
    /// Exports a generated recording without a grant, for capture-synth on the PC. Compiled only
    /// under Package.swift's USG_SYNTHETIC_EXPORT, never in the app; refuses anything but
    /// `origin: synthetic`.
    public func exportSynthetic(id: UUID, progress: (ExportProgress) -> Void = { _ in }) throws
      -> ExportResult
    {
      guard store.manifestFacts(id)?.origin == .synthetic else { throw ExportError.refused }
      return try run(id, progress: progress)
    }
  #endif

  private func run(_ id: UUID, progress: (ExportProgress) -> Void) throws -> ExportResult {
    guard security.protectedDataAvailable else { throw ExportError.locked }
    guard store.markBusy(id) else { throw ExportError.busy }
    defer { store.clearBusy(id) }
    let plan = try self.plan(id: id)
    let tarBytes = plan.layout.tarBytes
    guard store.freeBytes() >= tarBytes + headroomBytes else { throw ExportError.noSpace }

    let staging = paths.exportStaging(id)
    do {
      try store.prepareRoots()
      try deleteItem(staging)
      try security.createDirectory(staging, .complete)
    } catch {
      throw ExportError.io
    }
    let written: (parts: [WrittenPart], tarSha256: String)
    do {
      written = try writeParts(id, plan: plan, into: staging, progress: progress)
      let document = try RecordingDocuments.exportParts(
        recordingID: id, tarBytes: tarBytes, tarSha256: written.tarSha256,
        parts: written.parts.map { PartDigest(name: $0.name, bytes: $0.bytes, sha256: $0.sha256) }
      )
      let file = try DurableFile.create(
        staging.appendingPathComponent("parts.json", isDirectory: false), mode: .appendWriteOnly,
        protection: .complete, security: security)
      defer { file.close() }
      try file.appendAll(document)
      try file.fullSync()
      try DurableFile.syncDirectory(staging)
    } catch {
      try? deleteItem(staging)
      throw (error as? ExportError) ?? .io
    }

    // Into Documents/exports/, then the raw files go. A crash between the two leaves both;
    // recovery verifies the parts and finishes the job (design 7, step 4).
    do {
      try store.prepareExportsRoot()
      try deleteItem(paths.export(id))
      try fault(.rename)
      _ = try withPath(staging, .rename) { from in
        try withPath(paths.export(id), .rename) { to in
          try retryingEINTR(.rename) { .of(Int(sysRename(from, to))) }
        }
      }
      try DurableFile.syncDirectory(paths.exportsRoot)
      try fault(.deleteRaw)
      try deleteItem(paths.recording(id))
    } catch {
      try? deleteItem(staging)
      throw ExportError.io
    }
    return ExportResult(parts: written.parts.count, tarBytes: tarBytes)
  }

  /// The tar into the parts: each member's header, its bytes in 1 MiB reads, hashed and checked
  /// against recording.json, its padding, then the end blocks.
  private func writeParts(
    _ id: UUID, plan: ExportPlan, into staging: URL, progress: (ExportProgress) -> Void
  ) throws -> (parts: [WrittenPart], tarSha256: String) {
    let writer = TarPartWriter(
      directory: staging, plan: plan.parts, protection: .complete, security: security)
    defer { writer.abandon() }
    let total = plan.layout.tarBytes
    var lastReport = -Double.infinity
    func report(force: Bool = false) {
      let now = uptime()
      guard force || now - lastReport >= 0.2 else { return }
      lastReport = now
      progress(ExportProgress(bytesDone: writer.written, bytesTotal: total))
    }
    let directory = paths.recording(id)
    let prefix = RecordingPaths.recordingName(id) + "/"
    for entry in plan.layout.entries {
      try writer.write(try TarLayout.header(name: entry.name, size: entry.size))
      let url = directory.appendingPathComponent(String(entry.name.dropFirst(prefix.count)))
      var hash = Sha256Stream()
      do {
        try stream(url) { chunk in
          guard hash.byteCount + Int64(chunk.count) <= entry.size else {
            throw ExportError.corrupt
          }
          hash.update(chunk)
          try writer.write(chunk)
          report()
        }
      } catch let error as ExportError {
        throw error
      } catch let error as IOFailure {
        throw error
      } catch {
        throw ExportError.corrupt
      }
      guard hash.byteCount == entry.size else { throw ExportError.corrupt }
      if let expected = plan.expected[entry.name], expected.sha256 != hash.hex() {
        throw ExportError.corrupt
      }
      let padding = TarLayout.paddingBytes(forSize: entry.size)
      if padding > 0 { try writer.write(Data(count: padding)) }
    }
    try writer.write(Data(count: TarLayout.endBytes))
    report(force: true)
    return try writer.finish()
  }
}
#endif
