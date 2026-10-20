import Foundation

@testable import CaptureIO

#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

/// FileSecurity for the tests (design 14): it creates files and directories exclusively, as the
/// Darwin implementation does, and records every call and each path's class, since there are no
/// protection classes or backups off the phone. A test can make the next call of a kind fail.
final class RecordingFileSecurity: FileSecurity, @unchecked Sendable {
  enum Call: Equatable {
    case createFile(String, FileSecurityClass)
    case createDirectory(String, FileSecurityClass)
    case upgrade(String)
    case excludeFromBackup(String)
  }

  enum Kind: Equatable {
    case createFile, createDirectory, upgrade, excludeFromBackup
  }

  private let lock = NSLock()
  private var _calls: [Call] = []
  private var _classes: [String: FileSecurityClass] = [:]
  private var _excluded: Set<String> = []
  private var _failNext: [Kind: Int32] = [:]
  private var _protectedDataAvailable = true

  var calls: [Call] { lock.withLock { _calls } }

  /// The class each path was created with or raised to, by its path.
  func protectionClass(_ url: URL) -> FileSecurityClass? {
    lock.withLock { _classes[url.path] }
  }

  func isExcludedFromBackup(_ url: URL) -> Bool {
    lock.withLock { _excluded.contains(url.path) }
  }

  /// The next call of `kind` throws `errno` as a system error, and does nothing.
  func failNext(_ kind: Kind, errno: Int32 = EACCES) {
    lock.withLock { _failNext[kind] = errno }
  }

  var protectedDataAvailable: Bool {
    get { lock.withLock { _protectedDataAvailable } }
    set { lock.withLock { _protectedDataAvailable = newValue } }
  }

  func createFile(_ url: URL, _ cls: FileSecurityClass) throws {
    try record(.createFile, .createFile(url.path, cls))
    let fd = url.withUnsafeFileSystemRepresentation { path -> Int32 in
      open(path!, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0o600)
    }
    guard fd >= 0 else { throw IOFailure.system(.create, errno: errno) }
    close(fd)
    lock.withLock { _classes[url.path] = cls }
  }

  func createDirectory(_ url: URL, _ cls: FileSecurityClass) throws {
    try record(.createDirectory, .createDirectory(url.path, cls))
    let result = url.withUnsafeFileSystemRepresentation { path in mkdir(path!, 0o700) }
    guard result == 0 else { throw IOFailure.system(.create, errno: errno) }
    lock.withLock { _classes[url.path] = cls }
  }

  func upgrade(_ url: URL) throws {
    try record(.upgrade, .upgrade(url.path))
    guard protectedDataAvailable else { throw IOFailure.system(.open, errno: EPERM) }
    guard FileManager.default.fileExists(atPath: url.path) else {
      throw IOFailure.system(.open, errno: ENOENT)
    }
    lock.withLock { _classes[url.path] = .complete }
  }

  func excludeFromBackup(_ url: URL) throws {
    try record(.excludeFromBackup, .excludeFromBackup(url.path))
    lock.withLock { _ = _excluded.insert(url.path) }
  }

  private func record(_ kind: Kind, _ call: Call) throws {
    let failure: Int32? = lock.withLock {
      _calls.append(call)
      return _failNext.removeValue(forKey: kind)
    }
    if let failure { throw IOFailure.system(.create, errno: failure) }
  }
}
