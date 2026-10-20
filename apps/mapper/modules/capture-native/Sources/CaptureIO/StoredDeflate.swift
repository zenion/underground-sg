// Raw DEFLATE in stored blocks (RFC 1951 3.2.4, BTYPE 00): valid and uncompressed, for where
// Compression is absent: Linux, so CaptureIO builds and is tested there (design D17). iOS never
// compiles it: the pods don't define USG_IO_FALLBACKS, which Package.swift does so `swift test`
// on macOS can check it against Compression.
#if !canImport(Compression) || USG_IO_FALLBACKS
import Foundation

enum StoredDeflate {
  /// The most a stored block holds.
  static let blockBytes = 65_535

  /// `source` in as few stored blocks as fit, the last one final; one empty final block for no
  /// input.
  static func encode(_ source: Data) -> Data {
    let blocks = max(1, (source.count + blockBytes - 1) / blockBytes)
    var out = Data(capacity: source.count + 5 * blocks)
    source.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
      for index in 0..<blocks {
        let start = index * blockBytes
        let count = min(blockBytes, bytes.count - start)
        // BFINAL in bit 0, BTYPE 00 in bits 1 and 2, then padding to the byte.
        out.append(index == blocks - 1 ? 0x01 : 0x00)
        let length = UInt16(count)
        out.append(contentsOf: [UInt8(length & 0xff), UInt8(length >> 8)])
        out.append(contentsOf: [UInt8(~length & 0xff), UInt8(~length >> 8)])
        if count > 0 { out.append(contentsOf: bytes[start..<(start + count)]) }
      }
    }
    return out
  }
}
#endif
