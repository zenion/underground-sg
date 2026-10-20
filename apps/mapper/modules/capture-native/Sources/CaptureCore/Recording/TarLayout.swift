import Foundation

// The export tar's layout (docs/session-recording.md, "Export and import"; design 3.1): a plain
// POSIX ustar archive, read on the PC under the bundle's tar rules. Worked out before anything
// is written, so an export too large to split refuses up front.
//
// Not gated by USG_RECORDER: `packBundle` writes the same tar for bundles.

/// Why a tar can't be laid out. No case carries a value from the files but a count.
public enum TarLayoutError: Error, Equatable, Sendable {
  /// A name that is empty, absolute, has a `.` or `..` part, an empty part, or a byte outside
  /// `A-Z a-z 0-9 . _ - /`.
  case badName
  /// Over the 100 bytes of the ustar name field (the prefix field is never used).
  case nameTooLong
  case duplicateName
  /// Over the 11 octal digits of the size field (8 GiB less a byte).
  case fileTooLarge
}

/// One member: a regular file.
public struct TarEntry: Equatable, Sendable {
  public let name: String
  public let size: Int64
  /// Where its header starts in the tar.
  public let headerOffset: Int64
  /// Where its bytes start, right after the header.
  public var dataOffset: Int64 { headerOffset + Int64(TarLayout.blockBytes) }
}

/// The members of an export tar, sorted bytewise by name, and the tar's size: a 512-byte
/// header and the file's bytes padded to 512 for each, then two zero blocks.
public struct TarLayout: Equatable, Sendable {
  public static let blockBytes = 512
  /// The end-of-archive marker: two zero blocks. No padding to a record size follows.
  public static let endBytes = 1024
  public static let maxNameBytes = 100
  /// 0o77777777777: what 11 octal digits hold.
  public static let maxFileBytes: Int64 = 8_589_934_591

  public let entries: [TarEntry]
  /// Σ(512 + roundUp512(size)) + 1024.
  public let tarBytes: Int64

  public init(files: [(name: String, size: Int64)]) throws {
    let sorted = files.sorted { Array($0.name.utf8).lexicographicallyPrecedes(Array($1.name.utf8)) }
    var entries: [TarEntry] = []
    var offset: Int64 = 0
    for file in sorted {
      try Self.check(name: file.name)
      guard file.size >= 0, file.size <= Self.maxFileBytes else {
        throw TarLayoutError.fileTooLarge
      }
      if entries.last?.name == file.name { throw TarLayoutError.duplicateName }
      entries.append(TarEntry(name: file.name, size: file.size, headerOffset: offset))
      offset += Int64(Self.blockBytes) + file.size + Int64(Self.paddingBytes(forSize: file.size))
    }
    self.entries = entries
    tarBytes = offset + Int64(Self.endBytes)
  }

  /// Zero bytes after a file's data, to the next 512-byte boundary.
  public static func paddingBytes(forSize size: Int64) -> Int {
    let remainder = Int(size % Int64(blockBytes))
    return remainder == 0 ? 0 : blockBytes - remainder
  }

  /// The 512-byte ustar header of a regular file: mode 0644, uid and gid 0, mtime 0, empty user
  /// and group names, typeflag `0`, magic `ustar` NUL and version `00`, the numbers in
  /// zero-padded octal ending in NUL, and the checksum (the byte sum of the header with the
  /// checksum field as eight spaces) as six octal digits, NUL and a space. The same bytes for
  /// the same file every time, so an export's hashes are reproducible.
  public static func header(name: String, size: Int64) throws -> Data {
    try check(name: name)
    guard size >= 0, size <= maxFileBytes else { throw TarLayoutError.fileTooLarge }
    var header = [UInt8](repeating: 0, count: blockBytes)
    func put(_ bytes: [UInt8], at offset: Int) {
      for (index, byte) in bytes.enumerated() { header[offset + index] = byte }
    }
    put(Array(name.utf8), at: 0)
    put(octal(0o644, digits: 7) + [0], at: 100)
    put(octal(0, digits: 7) + [0], at: 108)
    put(octal(0, digits: 7) + [0], at: 116)
    put(octal(UInt64(size), digits: 11) + [0], at: 124)
    put(octal(0, digits: 11) + [0], at: 136)
    put([UInt8](repeating: 0x20, count: 8), at: 148)
    header[156] = UInt8(ascii: "0")
    put(Array("ustar".utf8) + [0], at: 257)
    put(Array("00".utf8), at: 263)
    // uname, gname, devmajor, devminor and prefix stay NUL.
    let sum = header.reduce(UInt64(0)) { $0 + UInt64($1) }
    put(octal(sum, digits: 6) + [0, 0x20], at: 148)
    return Data(header)
  }

  static func check(name: String) throws {
    let bytes = Array(name.utf8)
    guard bytes.count <= maxNameBytes else { throw TarLayoutError.nameTooLong }
    guard !bytes.isEmpty, bytes.first != UInt8(ascii: "/"), bytes.last != UInt8(ascii: "/"),
      bytes.allSatisfy(isNameByte)
    else { throw TarLayoutError.badName }
    for part in name.split(separator: "/", omittingEmptySubsequences: false) {
      guard !part.isEmpty, part != ".", part != ".." else { throw TarLayoutError.badName }
    }
  }
}

private func isNameByte(_ byte: UInt8) -> Bool {
  (byte >= UInt8(ascii: "a") && byte <= UInt8(ascii: "z"))
    || (byte >= UInt8(ascii: "A") && byte <= UInt8(ascii: "Z"))
    || (byte >= UInt8(ascii: "0") && byte <= UInt8(ascii: "9"))
    || byte == UInt8(ascii: ".") || byte == UInt8(ascii: "_") || byte == UInt8(ascii: "-")
    || byte == UInt8(ascii: "/")
}

/// `value` as exactly `digits` octal digits, zero-padded. The callers keep it in range.
private func octal(_ value: UInt64, digits: Int) -> [UInt8] {
  var out = [UInt8](repeating: UInt8(ascii: "0"), count: digits)
  var rest = value
  var index = digits - 1
  while rest > 0 && index >= 0 {
    out[index] = UInt8(ascii: "0") + UInt8(rest & 7)
    rest >>= 3
    index -= 1
  }
  precondition(rest == 0, "an octal field overflowed")
  return out
}
