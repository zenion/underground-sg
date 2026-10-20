import Foundation

#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

// The POSIX calls CaptureIO's files make, in one place: Darwin on the phone and the Mac, Glibc on
// Linux (design D17). DurableFile goes through FileCalls, so the tests can interrupt and shorten
// them; nothing else may call write(2) on a recording's file.

/// Why a file operation failed: the operation and the system's error code, never a path, a size
/// or the bytes involved (the logging rules in CLAUDE.md).
public enum IOFailure: Error, Equatable, Sendable {
  case system(IOOperation, errno: Int32)
  /// The file ended before the bytes asked for.
  case shortRead
  /// The file was used after `close()`.
  case closed

  /// Out of space: FileSink truncates to the committed bytes and closes with `disk` (design 7.7).
  public var isNoSpace: Bool { self == .system(.write, errno: ENOSPC) }
}

public enum IOOperation: String, Sendable {
  case create, open, write, read, sync, fullSync, truncate, stat, rename, remove
}

/// A system call's result, with its errno when it failed (`value < 0`).
struct SysResult: Equatable, Sendable {
  var value: Int
  var errno: Int32

  static func of(_ value: Int) -> SysResult {
    SysResult(value: value, errno: value < 0 ? currentErrno() : 0)
  }
}

/// The calls DurableFile makes on an open descriptor.
struct FileCalls: Sendable {
  var write: @Sendable (_ fd: Int32, _ bytes: UnsafeRawPointer, _ count: Int) -> SysResult
  var pread:
    @Sendable (_ fd: Int32, _ into: UnsafeMutableRawPointer, _ count: Int, _ offset: Int64) ->
      SysResult
  var fsync: @Sendable (_ fd: Int32) -> SysResult
  /// F_FULLFSYNC on Darwin; Linux has none (design D17).
  var fullFsync: @Sendable (_ fd: Int32) -> SysResult
  var ftruncate: @Sendable (_ fd: Int32, _ length: Int64) -> SysResult

  static let system = FileCalls(
    write: { fd, bytes, count in .of(sysWrite(fd, bytes, count)) },
    pread: { fd, into, count, offset in .of(sysPread(fd, into, count, offset)) },
    fsync: { fd in .of(Int(sysFsync(fd))) },
    fullFsync: { fd in
      #if canImport(Darwin)
        .of(Int(fcntl(fd, F_FULLFSYNC)))
      #else
        SysResult(value: -1, errno: ENOTSUP)
      #endif
    },
    ftruncate: { fd, length in .of(Int(sysFtruncate(fd, length))) }
  )
}

// Thin wrappers, so the methods of the same names on DurableFile don't hide the C functions.

func currentErrno() -> Int32 { errno }

/// Opens a file that exists: CaptureIO never passes O_CREAT (FileSecurity creates).
func sysOpen(_ path: UnsafePointer<CChar>, _ flags: Int32) -> Int32 { open(path, flags) }

func sysClose(_ fd: Int32) { _ = close(fd) }

func sysWrite(_ fd: Int32, _ bytes: UnsafeRawPointer, _ count: Int) -> Int {
  write(fd, bytes, count)
}

func sysPread(_ fd: Int32, _ into: UnsafeMutableRawPointer, _ count: Int, _ offset: Int64) -> Int {
  pread(fd, into, count, off_t(offset))
}

func sysFsync(_ fd: Int32) -> Int32 { fsync(fd) }

func sysFtruncate(_ fd: Int32, _ length: Int64) -> Int32 { ftruncate(fd, off_t(length)) }

func sysFileSize(_ fd: Int32) -> Int64? {
  var info = stat()
  guard fstat(fd, &info) == 0 else { return nil }
  return Int64(info.st_size)
}

func sysRename(_ from: UnsafePointer<CChar>, _ to: UnsafePointer<CChar>) -> Int32 {
  rename(from, to)
}

func sysUnlink(_ path: UnsafePointer<CChar>) -> Int32 { unlink(path) }

/// Runs `body` with a path's file-system representation, refusing a URL that has none.
func withPath<T>(
  _ url: URL, _ operation: IOOperation, _ body: (UnsafePointer<CChar>) throws -> T
) throws -> T {
  try url.withUnsafeFileSystemRepresentation { path in
    guard let path else { throw IOFailure.system(operation, errno: EINVAL) }
    return try body(path)
  }
}

/// Calls `body` again while it fails with EINTR, then throws its error, if any, as `operation`'s.
@discardableResult
func retryingEINTR(_ operation: IOOperation, _ body: () -> SysResult) throws -> Int {
  while true {
    let result = body()
    if result.value >= 0 { return result.value }
    if result.errno != EINTR { throw IOFailure.system(operation, errno: result.errno) }
  }
}
