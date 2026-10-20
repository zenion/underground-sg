#if USG_RECORDER
import CaptureCore
import Foundation

#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

// The recordings on the phone as a whole (design 3.2, 7.1 and 9): the roots, the list, deletion,
// free space, the ballast and which recordings are busy. FileSink, RecoveryRunner, TarExporter
// and SelfTest share one store; its busy flags are the only state they share across queues, so
// they sit behind a lock. Everything it reports is counts, sizes, durations and ages in days.

/// Why the store refused. Carries no value from a recording.
public enum RecordingStoreError: Error, Equatable, Sendable {
  /// The recording is being written, exported or deleted.
  case busy
  /// No such recording or export.
  case notFound
}

/// A recording as `listRecordings` reports it: counts, sizes, a duration and an age in days,
/// never a time or a pose.
public struct RecordingSummary: Equatable, Sendable {
  public enum State: String, Sendable {
    /// Being written now.
    case open
    /// Cut off; recovery finishes or removes it at the next launch.
    case needsRecovery = "needs_recovery"
    case closed
    /// Cut back by recovery (`interrupted`).
    case recovered
    /// Exported; the raw files are gone.
    case exported
  }

  public let id: UUID
  public let origin: ManifestBase.Origin
  public let profile: RecordProfile
  public let state: State
  public let ended: WindowEndReason?
  public let trimmed: Bool
  public let durationS: Double?
  public let bytes: Int64
  public let files: Int
  public let ageDays: Int
  public let venues: [String]
  public let exportParts: Int?
}

/// The free space a recording may count on: volumeAvailableCapacityForImportantUsage on Apple
/// platforms, statvfs(3) elsewhere.
public struct FreeSpaceProbe: Sendable {
  public var bytes: @Sendable (URL) -> Int64?

  public init(bytes: @escaping @Sendable (URL) -> Int64?) {
    self.bytes = bytes
  }

  public static let system = FreeSpaceProbe { url in
    #if canImport(Darwin)
      if let values = try? url.resourceValues(forKeys: [
        .volumeAvailableCapacityForImportantUsageKey
      ]), let bytes = values.volumeAvailableCapacityForImportantUsage {
        return bytes
      }
    #endif
    return try? withPath(url, .stat) { path in sysAvailableBytes(path) }
  }
}

public final class RecordingStore: @unchecked Sendable {
  public let paths: RecordingPaths
  public let security: any FileSecurity
  /// 64 MiB a recording holds back while it records (design 7.1).
  public let ballastBytes: Int64

  private let probe: FreeSpaceProbe
  private let uptime: @Sendable () -> Double
  private let now: @Sendable () -> Date
  private let lock = NSLock()
  private var busyIDs: Set<UUID> = []
  private var cachedFree: (bytes: Int64, at: Double)?

  public init(
    paths: RecordingPaths, security: any FileSecurity, ballastBytes: Int64 = 64 << 20,
    freeSpace: FreeSpaceProbe = .system,
    uptime: @escaping @Sendable () -> Double = { ProcessInfo.processInfo.systemUptime },
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.paths = paths
    self.security = security
    self.ballastBytes = ballastBytes
    probe = freeSpace
    self.uptime = uptime
    self.now = now
  }

  // MARK: - Roots

  /// Creates the roots that are missing and sets their backup exclusion again, as every launch
  /// does (design 7.1). Documents gets `exports/` only when an export first needs it.
  public func prepareRoots() throws {
    try FileManager.default.createDirectory(
      at: paths.applicationSupport, withIntermediateDirectories: true)
    try ensureDirectory(paths.recordingsRoot, .completeUnlessOpen)
    try ensureDirectory(paths.staging, .completeUnlessOpen)
    try ensureDirectory(paths.exportsStagingRoot, .complete)
    try security.excludeFromBackup(paths.recordingsRoot)
    try security.excludeFromBackup(paths.exportsStagingRoot)
  }

  /// `Documents/exports/`, created on first use, class A and excluded from backup.
  public func prepareExportsRoot() throws {
    try FileManager.default.createDirectory(at: paths.documents, withIntermediateDirectories: true)
    try ensureDirectory(paths.exportsRoot, .complete)
    try security.excludeFromBackup(paths.exportsRoot)
  }

  func ensureDirectory(_ url: URL, _ cls: FileSecurityClass) throws {
    var isDirectory: ObjCBool = false
    if FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) {
      if isDirectory.boolValue { return }
      try deleteItem(url)
    }
    try security.createDirectory(url, cls)
  }

  // MARK: - Busy flags

  /// Marks `id` busy; false when it already is.
  public func markBusy(_ id: UUID) -> Bool {
    lock.withLock { busyIDs.insert(id).inserted }
  }

  public func clearBusy(_ id: UUID) {
    lock.withLock { _ = busyIDs.remove(id) }
  }

  public func isBusy(_ id: UUID) -> Bool {
    lock.withLock { busyIDs.contains(id) }
  }

  // MARK: - Free space and the ballast

  /// The free space on the recordings' volume, read at most once a second.
  public func freeBytes() -> Int64 {
    let at = uptime()
    if let cached = lock.withLock({ cachedFree }), at - cached.at < 1, at >= cached.at {
      return cached.bytes
    }
    let bytes = probe.bytes(paths.applicationSupport) ?? 0
    lock.withLock { cachedFree = (bytes, at) }
    return bytes
  }

  /// Creates `.ballast-<id>` and allocates `ballastBytes` to it.
  public func reserveBallast(_ id: UUID) throws {
    let url = paths.ballast(id)
    try? deleteItem(url)
    let file = try DurableFile.create(
      url, mode: .appendWriteOnly, protection: .completeUnlessOpen, security: security)
    defer { file.close() }
    do {
      try file.reserve(ballastBytes)
    } catch {
      try? deleteItem(url)
      throw error
    }
  }

  /// Deletes the ballast, giving its space back: before a close on a full disk, and at the end.
  public func releaseBallast(_ id: UUID) {
    try? deleteItem(paths.ballast(id))
  }

  // MARK: - Listing and deleting

  /// Every recording and export, by id. Reads recording.json, the journals and the exports.
  public func list() -> [RecordingSummary] {
    let fm = FileManager.default
    let recordingIDs = Set(
      ((try? fm.contentsOfDirectory(atPath: paths.recordingsRoot.path)) ?? [])
        .compactMap(RecordingPaths.recordingID(name:)))
    let journalIDs = Set(
      ((try? fm.contentsOfDirectory(atPath: paths.recordingsRoot.path)) ?? [])
        .compactMap(RecordingPaths.journalID(name:)))
    let exportIDs = Set(
      ((try? fm.contentsOfDirectory(atPath: paths.exportsRoot.path)) ?? [])
        .compactMap(RecordingPaths.replayID(name:)))
    var summaries: [RecordingSummary] = []
    for id in recordingIDs.union(exportIDs).sorted(by: { $0.uuidString < $1.uuidString }) {
      let parts = exportIDs.contains(id) ? exportFacts(id) : nil
      if recordingIDs.contains(id) {
        if let summary = recordingSummary(
          id, journal: journalIDs.contains(id), exportParts: parts?.parts.count)
        {
          summaries.append(summary)
        }
      } else if let parts, let summary = exportSummary(id, parts: parts) {
        summaries.append(summary)
      }
    }
    return summaries
  }

  /// Removes the raw directory, the export and the journal. Refuses a recording that is busy.
  public func delete(_ id: UUID) throws {
    guard markBusy(id) else { throw RecordingStoreError.busy }
    defer { clearBusy(id) }
    let fm = FileManager.default
    let targets = [
      paths.recording(id), paths.export(id), paths.exportStaging(id), paths.journal(id),
      paths.ballast(id),
    ]
    guard targets.contains(where: { fm.fileExists(atPath: $0.path) }) else {
      throw RecordingStoreError.notFound
    }
    // The directory first: a journal without its directory is discarded at the next launch.
    for target in targets where fm.fileExists(atPath: target.path) { try deleteItem(target) }
  }

  /// recording.json's facts, if it is there and reads.
  public func manifestFacts(_ id: UUID) -> ManifestFacts? {
    FileManager.default.contents(atPath: paths.manifest(of: id).path).flatMap(
      RecordingDocuments.facts)
  }

  /// parts.json's facts in the export, if it is there and reads.
  public func exportFacts(_ id: UUID) -> ExportPartsFacts? {
    FileManager.default.contents(
      atPath: paths.export(id).appendingPathComponent("parts.json").path
    ).flatMap(RecordingDocuments.exportPartsFacts)
  }

  /// Every regular file under `directory`, with its path inside it (with `/`) and its size,
  /// sorted bytewise.
  func files(in directory: URL) -> [(path: String, size: Int64)] {
    entries(in: directory).compactMap { entry in
      entry.isDirectory ? nil : (entry.path, entry.size)
    }
  }

  /// Raises every file and directory of `rec-<id>/`, and the directory itself, to complete
  /// (design 7.5, step 7). Only while protected data is available.
  public func protect(_ id: UUID) throws {
    let directory = paths.recording(id)
    for entry in entries(in: directory) {
      try security.upgrade(directory.appendingPathComponent(entry.path))
    }
    try security.upgrade(directory)
  }

  private func entries(in directory: URL) -> [(path: String, size: Int64, isDirectory: Bool)] {
    let fm = FileManager.default
    guard let enumerator = fm.enumerator(atPath: directory.path) else { return [] }
    var out: [(String, Int64, Bool)] = []
    while let path = enumerator.nextObject() as? String {
      let full = directory.appendingPathComponent(path).path
      var isDirectory: ObjCBool = false
      guard fm.fileExists(atPath: full, isDirectory: &isDirectory) else { continue }
      let size = isDirectory.boolValue ? 0 : fileSize(full)
      out.append((path, size, isDirectory.boolValue))
    }
    return out.sorted { Array($0.0.utf8).lexicographicallyPrecedes(Array($1.0.utf8)) }
  }

  private func recordingSummary(_ id: UUID, journal: Bool, exportParts: Int?)
    -> RecordingSummary?
  {
    let onDisk = files(in: paths.recording(id))
    let bytes = onDisk.reduce(0) { $0 + $1.size }
    guard let facts = manifestFacts(id) else {
      // No readable recording.json: only recovery can say what it is.
      return nil
    }
    let state: RecordingSummary.State
    if journal || facts.ended == nil {
      state = isBusy(id) && journal ? .open : .needsRecovery
    } else {
      state = facts.closed ? .closed : .recovered
    }
    return summary(
      id, facts: facts, state: state, bytes: bytes, files: onDisk.count, exportParts: exportParts)
  }

  /// An export whose raw files are gone: recording.json is read from the parts.
  private func exportSummary(_ id: UUID, parts: ExportPartsFacts) -> RecordingSummary? {
    let reader = PartsReader(
      directory: paths.export(id), parts: parts.parts.map { ($0.name, $0.bytes) })
    guard
      let data = try? reader.member(named: "\(RecordingPaths.recordingName(id))/recording.json"),
      let facts = RecordingDocuments.facts(data)
    else { return nil }
    return summary(
      id, facts: facts, state: .exported, bytes: parts.tarBytes, files: facts.files.count + 1,
      exportParts: parts.parts.count)
  }

  private func summary(
    _ id: UUID, facts: ManifestFacts, state: RecordingSummary.State, bytes: Int64, files: Int,
    exportParts: Int?
  ) -> RecordingSummary {
    var age = 0
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let started = formatter.date(from: facts.sessionStartedAt) {
      age = max(0, Int(now().timeIntervalSince(started) / 86_400))
    }
    let duration = facts.endT.map { max(0, $0 - facts.startT) }
    return RecordingSummary(
      id: id, origin: facts.origin, profile: facts.profile, state: state, ended: facts.ended,
      trimmed: facts.trimmed, durationS: duration, bytes: bytes, files: files, ageDays: age,
      venues: facts.venues, exportParts: exportParts)
  }
}

/// Removes a file or a directory with everything in it; a missing one is fine.
func deleteItem(_ url: URL) throws {
  do {
    try FileManager.default.removeItem(at: url)
  } catch let error as CocoaError where error.code == .fileNoSuchFile {
    return
  } catch {
    if FileManager.default.fileExists(atPath: url.path) {
      throw IOFailure.system(.remove, errno: EIO)
    }
  }
}

/// A file's length from stat(2), 0 when it can't be read.
func fileSize(_ path: String) -> Int64 {
  var info = stat()
  guard stat(path, &info) == 0 else { return 0 }
  return Int64(info.st_size)
}
#endif
