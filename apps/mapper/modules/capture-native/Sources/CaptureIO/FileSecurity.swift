import Foundation

// Data protection and backup exclusion for every file CaptureIO writes (ADR 0010, design 7.1 and
// 7.6). The Darwin implementation, with NSFileProtection classes, isExcludedFromBackup and
// UIApplication's isProtectedDataAvailable, is in ios/ (DarwinFileSecurity): CaptureIO is
// Foundation only, so it builds and is tested on Linux, where the tests pass a recording fake.
//
// Not gated by USG_RECORDER: bundles will be written through it too.

/// The data-protection class a file or directory is created with.
public enum FileSecurityClass: String, Sendable {
  /// NSFileProtectionComplete (class A): unreadable while the phone is locked. Closed recordings,
  /// export parts and parts.json.
  case complete
  /// NSFileProtectionCompleteUnlessOpen (class B): a descriptor opened while unlocked stays
  /// writable after the lock, and new files can be created while locked. Recordings while they
  /// are written, the journal and the staging files.
  case completeUnlessOpen
}

/// How CaptureIO creates files and directories with a protection class, raises them to complete
/// once a recording is closed, and keeps them out of backups.
///
/// Every file CaptureIO writes is created here, with its class, and DurableFile adopts the
/// descriptor that created it, so no file ever exists without its class. A new file is never
/// closed and opened again: a class-B file created while the phone is locked can't be reopened
/// until it is unlocked (design 7.6), and a background close may create staging files then.
public protocol FileSecurity: Sendable {
  /// Creates an empty file with `cls` from its first byte and returns the descriptor that created
  /// it, opened with `flags` (the access mode, O_APPEND and O_CLOEXEC) plus O_CREAT and O_EXCL.
  /// Throws, leaving no file behind, if anything is already at `url` or the class can't be set.
  /// The caller owns the descriptor.
  func createAndOpen(_ url: URL, _ cls: FileSecurityClass, flags: Int32) throws -> Int32
  /// Creates a directory with `cls`, which files created in it inherit. Throws if anything is
  /// already at `url`.
  func createDirectory(_ url: URL, _ cls: FileSecurityClass) throws
  /// Raises a file or directory to `complete`. Only while protected data is available.
  func upgrade(_ url: URL) throws
  /// Sets isExcludedFromBackup, which a root keeps for everything under it.
  func excludeFromBackup(_ url: URL) throws
  /// The class a file or directory has now, read back for the self-test (design D18); nil when
  /// it has none of these two or can't be read.
  func protectionClass(_ url: URL) -> FileSecurityClass?
  /// Whether isExcludedFromBackup is set on `url` itself, read back for the self-test.
  func isExcludedFromBackup(_ url: URL) -> Bool
  /// False while the phone is locked: class-A files can't be opened, so the protection upgrade,
  /// recovery, export and the self-test wait (design 7.6).
  var protectedDataAvailable: Bool { get }
}
