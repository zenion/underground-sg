#if USG_RECORDER
  import CaptureIO
  import Foundation
  import UIKit

  /// CaptureIO's FileSecurity on the phone (the lean recorder design, 7.1 and 7.6): Data
  /// Protection classes from a file's first byte, backup exclusion, and whether protected data is
  /// available now.
  ///
  /// UIApplication's `isProtectedDataAvailable` may be read only on the main queue, and
  /// CaptureIO asks from its own queues, so the answer is kept here: read on the main queue by
  /// `startObserving` and updated from UIApplication's notifications, which arrive there. Until
  /// then it says false, so nothing that needs class A runs early. It turns false when iOS
  /// announces the lock (`protectedDataWillBecomeUnavailable`), about ten seconds before class-A
  /// files close.
  ///
  /// Errors carry an operation and an errno, never a path or a system message.
  final class DarwinFileSecurity: FileSecurity, @unchecked Sendable {
    private let lock = NSLock()
    private var available = false
    /// Main queue only.
    private var observers: [NSObjectProtocol] = []

    /// Main queue. Reads the state now and follows it; `becameAvailable` runs on the main queue
    /// each time protected data becomes available.
    func startObserving(becameAvailable: @escaping @Sendable () -> Void) {
      guard observers.isEmpty else { return }
      setAvailable(UIApplication.shared.isProtectedDataAvailable)
      let center = NotificationCenter.default
      observers.append(
        center.addObserver(
          forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil,
          queue: .main
        ) { [weak self] _ in
          self?.setAvailable(true)
          becameAvailable()
        })
      observers.append(
        center.addObserver(
          forName: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil,
          queue: .main
        ) { [weak self] _ in
          self?.setAvailable(false)
        })
    }

    private func setAvailable(_ value: Bool) {
      lock.lock()
      available = value
      lock.unlock()
    }

    // MARK: FileSecurity

    var protectedDataAvailable: Bool {
      lock.lock()
      defer { lock.unlock() }
      return available
    }

    func createFile(_ url: URL, _ cls: FileSecurityClass) throws {
      // Without overwriting: O_EXCL. Foundation opens the file with its protection class, so it
      // has the class from its first byte (the self-test reads it back on the phone).
      let options: Data.WritingOptions = [.withoutOverwriting, DarwinFileSecurity.writingOption(cls)]
      do {
        try Data().write(to: url, options: options)
      } catch {
        throw IOFailure.system(.create, errno: posixErrno(error))
      }
    }

    func createDirectory(_ url: URL, _ cls: FileSecurityClass) throws {
      do {
        try FileManager.default.createDirectory(
          at: url, withIntermediateDirectories: false,
          attributes: [.protectionKey: DarwinFileSecurity.protectionType(cls)])
      } catch {
        throw IOFailure.system(.create, errno: posixErrno(error))
      }
    }

    func upgrade(_ url: URL) throws {
      do {
        try FileManager.default.setAttributes(
          [.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
      } catch {
        throw IOFailure.system(.open, errno: posixErrno(error))
      }
    }

    func excludeFromBackup(_ url: URL) throws {
      var target = url
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      do {
        try target.setResourceValues(values)
      } catch {
        throw IOFailure.system(.open, errno: posixErrno(error))
      }
    }

    func protectionClass(_ url: URL) -> FileSecurityClass? {
      guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
        let type = attributes[.protectionKey] as? FileProtectionType
      else { return nil }
      if type == .complete { return .complete }
      if type == .completeUnlessOpen { return .completeUnlessOpen }
      return nil
    }

    func isExcludedFromBackup(_ url: URL) -> Bool {
      // A fresh URL, so no cached resource value answers.
      let fresh = URL(fileURLWithPath: url.path)
      return (try? fresh.resourceValues(forKeys: [.isExcludedFromBackupKey]))?.isExcludedFromBackup
        ?? false
    }

    // MARK: Classes

    private static func writingOption(_ cls: FileSecurityClass) -> Data.WritingOptions {
      switch cls {
      case .complete: return .completeFileProtection
      case .completeUnlessOpen: return .completeFileProtectionUnlessOpen
      }
    }

    private static func protectionType(_ cls: FileSecurityClass) -> FileProtectionType {
      switch cls {
      case .complete: return .complete
      case .completeUnlessOpen: return .completeUnlessOpen
      }
    }
  }

  /// The errno behind a Foundation error, or EIO. Only the number is kept.
  func posixErrno(_ error: Error) -> Int32 {
    let ns = error as NSError
    if ns.domain == NSPOSIXErrorDomain { return Int32(truncatingIfNeeded: ns.code) }
    if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError,
      underlying.domain == NSPOSIXErrorDomain
    {
      return Int32(truncatingIfNeeded: underlying.code)
    }
    if ns.domain == NSCocoaErrorDomain {
      if ns.code == CocoaError.Code.fileWriteFileExists.rawValue { return EEXIST }
      if ns.code == CocoaError.Code.fileWriteOutOfSpace.rawValue { return ENOSPC }
      if ns.code == CocoaError.Code.fileNoSuchFile.rawValue
        || ns.code == CocoaError.Code.fileReadNoSuchFile.rawValue
      {
        return ENOENT
      }
    }
    return EIO
  }
#endif
