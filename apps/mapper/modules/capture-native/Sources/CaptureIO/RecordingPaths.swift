#if USG_RECORDER
import CaptureCore
import Foundation

/// Where the recorder keeps everything on the phone (design 7.1 and 9;
/// docs/session-recording.md, "On the phone"), built from the app's two roots so the tests can
/// point it at a temporary directory:
///
/// ```
/// Library/Application Support/
///   recordings/                 excluded from backup
///     rec-<id>/                 the recording (completeUnlessOpen, then complete)
///     .journal-<id>.jsonl       its journal (completeUnlessOpen)
///     .ballast-<id>             64 MiB held back while it records
///     .staging/                 AtomicJsonWriter's temporary files
///   exports-staging/replay-<id>/   an export being written
///   selftest/                   the self-test's synthetic recordings
/// Documents/
///   exports/replay-<id>/        finished exports: NNNN.part and parts.json
/// ```
///
/// Only `exports/` is ever created under Documents. Ids are lowercase UUIDs; a name with any
/// other id is not the recorder's, and the parsers return nil for it.
public struct RecordingPaths: Equatable, Sendable {
  /// `Library/Application Support`.
  public let applicationSupport: URL
  /// The app's Documents, the folder UIFileSharingEnabled exposes.
  public let documents: URL

  public init(applicationSupport: URL, documents: URL) {
    self.applicationSupport = applicationSupport
    self.documents = documents
  }

  public var recordingsRoot: URL { directory(applicationSupport, "recordings") }
  /// AtomicJsonWriter's staging directory for documents in `recordingsRoot`.
  public var staging: URL { directory(recordingsRoot, ".staging") }
  public var exportsStagingRoot: URL { directory(applicationSupport, "exports-staging") }
  public var exportsRoot: URL { directory(documents, "exports") }
  public var selfTestRoot: URL { directory(applicationSupport, "selftest") }

  public func recording(_ id: UUID) -> URL {
    directory(recordingsRoot, Self.recordingName(id))
  }

  /// A file of the recording, by its path in `rec-<id>/`.
  public func file(_ path: RecordingFilePath, of id: UUID) -> URL {
    recording(id).appendingPathComponent(path.rawValue, isDirectory: false)
  }

  /// `rec-<id>/mesh/`, created with the first snapshot.
  public func meshDirectory(of id: UUID) -> URL { directory(recording(id), "mesh") }

  public func manifest(of id: UUID) -> URL {
    recording(id).appendingPathComponent("recording.json", isDirectory: false)
  }

  public func journal(_ id: UUID) -> URL {
    recordingsRoot.appendingPathComponent(Self.journalName(id), isDirectory: false)
  }

  public func ballast(_ id: UUID) -> URL {
    recordingsRoot.appendingPathComponent(Self.ballastName(id), isDirectory: false)
  }

  public func exportStaging(_ id: UUID) -> URL {
    directory(exportsStagingRoot, Self.replayName(id))
  }

  public func export(_ id: UUID) -> URL { directory(exportsRoot, Self.replayName(id)) }

  // Names, and the ids they carry.

  public static func recordingName(_ id: UUID) -> String { "rec-\(text(id))" }
  public static func journalName(_ id: UUID) -> String { ".journal-\(text(id)).jsonl" }
  public static func ballastName(_ id: UUID) -> String { ".ballast-\(text(id))" }
  public static func replayName(_ id: UUID) -> String { "replay-\(text(id))" }

  public static func recordingID(name: String) -> UUID? { id(in: name, "rec-", "") }
  public static func journalID(name: String) -> UUID? { id(in: name, ".journal-", ".jsonl") }
  public static func ballastID(name: String) -> UUID? { id(in: name, ".ballast-", "") }
  public static func replayID(name: String) -> UUID? { id(in: name, "replay-", "") }

  private static func text(_ id: UUID) -> String { id.uuidString.lowercased() }

  private static func id(in name: String, _ prefix: String, _ suffix: String) -> UUID? {
    guard name.hasPrefix(prefix), name.hasSuffix(suffix),
      name.count == prefix.count + 36 + suffix.count
    else { return nil }
    let text = String(name.dropFirst(prefix.count).dropLast(suffix.count))
    guard let id = UUID(uuidString: text), Self.text(id) == text else { return nil }
    return id
  }

  private func directory(_ parent: URL, _ name: String) -> URL {
    parent.appendingPathComponent(name, isDirectory: true)
  }
}
#endif
