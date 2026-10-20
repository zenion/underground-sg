import Foundation

#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

/// One append-only file of a recording (design 3.2 and 7): whole writes that survive EINTR and
/// short writes, reads at an offset, fsync and full sync, truncation, nothing else. A file is
/// only ever created through FileSecurity, with its protection class, then opened here without
/// O_CREAT; every descriptor is O_APPEND and O_CLOEXEC.
///
/// Confined to the queue that owns it (the I/O queue). Not gated by USG_RECORDER: bundles will be
/// written through it too.
public final class DurableFile {
  public enum Mode: Sendable {
    /// O_WRONLY: the recording's JSONL files and the journal.
    case appendWriteOnly
    /// O_RDWR: history.bin, whose final snapshot copies earlier blocks (design D6).
    case appendReadWrite
  }

  public let mode: Mode
  private var fd: Int32
  private let calls: FileCalls

  /// Creates the file through `security` with `protection`, then opens it. Throws if anything is
  /// already at `url`.
  public static func create(
    _ url: URL, mode: Mode, protection: FileSecurityClass, security: any FileSecurity
  ) throws -> DurableFile {
    try security.createFile(url, protection)
    return try DurableFile(opening: url, mode: mode)
  }

  /// Opens a file that exists. Never creates one.
  public convenience init(opening url: URL, mode: Mode) throws {
    try self.init(opening: url, mode: mode, calls: .system)
  }

  init(opening url: URL, mode: Mode, calls: FileCalls) throws {
    let access = mode == .appendWriteOnly ? O_WRONLY : O_RDWR
    let flags = access | O_APPEND | O_CLOEXEC
    fd = try withPath(url, .open) { path in
      Int32(try retryingEINTR(.open) { .of(Int(sysOpen(path, flags))) })
    }
    self.mode = mode
    self.calls = calls
  }

  deinit {
    if fd >= 0 { sysClose(fd) }
  }

  public var isOpen: Bool { fd >= 0 }

  /// The descriptor, for the tests' checks of its flags.
  var descriptor: Int32 { fd }

  /// Appends every byte of `data`, in as many write(2) calls as it takes. On a failure part of
  /// `data` may be on disk: the caller truncates back to its committed length (design 7.7).
  public func appendAll(_ data: Data) throws {
    let fd = try openDescriptor()
    try data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
      guard var next = buffer.baseAddress else { return }
      var remaining = buffer.count
      while remaining > 0 {
        let written = try retryingEINTR(.write) { calls.write(fd, next, remaining) }
        // write(2) reports no error but moves nothing: give up rather than spin.
        guard written > 0 else { throw IOFailure.system(.write, errno: EIO) }
        next += written
        remaining -= written
      }
    }
  }

  /// Reads exactly `count` bytes at `offset` into `buffer`, which ends up `count` long. Throws
  /// `shortRead` if the file ends first. Needs `appendReadWrite`.
  public func pread(offset: Int64, count: Int, into buffer: inout [UInt8]) throws {
    precondition(offset >= 0 && count >= 0, "a read inside the file")
    let fd = try openDescriptor()
    if buffer.count != count { buffer = [UInt8](repeating: 0, count: count) }
    try buffer.withUnsafeMutableBytes { (bytes: UnsafeMutableRawBufferPointer) in
      var done = 0
      while done < count {
        let read = try retryingEINTR(.read) {
          calls.pread(fd, bytes.baseAddress! + done, count - done, offset + Int64(done))
        }
        guard read > 0 else { throw IOFailure.shortRead }
        done += read
      }
    }
  }

  /// The file's length now.
  public func length() throws -> Int64 {
    let fd = try openDescriptor()
    guard let size = sysFileSize(fd) else {
      throw IOFailure.system(.stat, errno: currentErrno())
    }
    return size
  }

  /// fsync(2): the data reaches the drive, perhaps only its cache.
  public func fsync() throws {
    let fd = try openDescriptor()
    try retryingEINTR(.sync) { calls.fsync(fd) }
  }

  /// F_FULLFSYNC on Darwin: the data reaches the flash, as the journal's checkpoints need
  /// (design D7). Where it isn't supported (Linux, or a file system without it), fsync instead.
  public func fullSync() throws {
    let fd = try openDescriptor()
    do {
      try retryingEINTR(.fullSync) { calls.fullFsync(fd) }
    } catch {
      try retryingEINTR(.fullSync) { calls.fsync(fd) }
    }
  }

  /// Cuts the file to `length` bytes; later appends start there. A stop cut-back and a failed
  /// write both use it (design 7.4 and 7.7).
  public func truncate(to length: Int64) throws {
    precondition(length >= 0, "a length")
    let fd = try openDescriptor()
    try retryingEINTR(.truncate) { calls.ftruncate(fd, length) }
  }

  /// Closes the descriptor; again does nothing. close(2) is not retried: the descriptor is gone
  /// whatever it returns, and what matters was synced before.
  public func close() {
    guard fd >= 0 else { return }
    sysClose(fd)
    fd = -1
  }

  /// fsync(2) on a directory, so a rename or a new file in it survives a power loss.
  public static func syncDirectory(_ url: URL) throws {
    let fd = try withPath(url, .open) { path in
      Int32(try retryingEINTR(.open) { .of(Int(sysOpen(path, O_RDONLY | O_CLOEXEC))) })
    }
    defer { sysClose(fd) }
    try retryingEINTR(.sync) { .of(Int(sysFsync(fd))) }
  }

  private func openDescriptor() throws -> Int32 {
    guard fd >= 0 else { throw IOFailure.closed }
    return fd
  }
}
