import Foundation

#if canImport(CryptoKit)
  import CryptoKit
#endif

/// An incremental SHA-256 (design D8): each writer feeds it the bytes it has committed, so the
/// digest in recording.json never needs the files read back, and a copy taken at a cut
/// checkpoint is the digest of the file truncated there (design 7.4).
///
/// CryptoKit on Apple platforms; elsewhere (Linux, for `swift test`) the pure-Swift
/// Sha256Fallback, which iOS never compiles (design D17).
///
/// Not gated by USG_RECORDER: bundles will hash through it too.
public struct Sha256Stream {
  #if canImport(CryptoKit)
    private var hasher = SHA256()
  #else
    private var hasher = Sha256Fallback()
  #endif

  /// How many bytes it has hashed.
  public private(set) var byteCount: Int64 = 0

  public init() {}

  public mutating func update(_ data: Data) {
    data.withUnsafeBytes { update($0) }
  }

  public mutating func update(_ bytes: UnsafeRawBufferPointer) {
    hasher.update(bufferPointer: bytes)
    byteCount += Int64(bytes.count)
  }

  /// An independent copy: later updates to either don't reach the other.
  public func snapshot() -> Sha256Stream { self }

  /// The digest of everything hashed so far, as 64 lowercase hex digits. The stream can go on.
  public func hex() -> String {
    Self.hex(Array(hasher.finalize()))
  }

  /// The digest of `data` in one go.
  public static func hex(of data: Data) -> String {
    var stream = Sha256Stream()
    stream.update(data)
    return stream.hex()
  }

  static func hex(_ digest: [UInt8]) -> String {
    let digits = Array("0123456789abcdef".utf8)
    var text = [UInt8]()
    text.reserveCapacity(digest.count * 2)
    for byte in digest {
      text.append(digits[Int(byte >> 4)])
      text.append(digits[Int(byte & 0x0f)])
    }
    return String(decoding: text, as: UTF8.self)
  }
}
