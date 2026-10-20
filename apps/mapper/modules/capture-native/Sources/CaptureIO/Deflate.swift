import Foundation

#if canImport(Compression)
  import Compression
#endif

/// Why a block couldn't be compressed. Carries no bytes.
public enum DeflateError: Error, Equatable, Sendable {
  case streamInit
  case streamFailed
}

/// Raw DEFLATE (RFC 1951, no zlib or gzip wrapper), the encoding of every mesh block in
/// history.bin (docs/session-recording.md).
///
/// Compression's COMPRESSION_ZLIB on Apple platforms, which is raw DEFLATE despite its name;
/// elsewhere (Linux, for `swift test`) StoredDeflate, which writes valid stored blocks and which
/// iOS never compiles (design D17).
///
/// Not gated by USG_RECORDER: bundles will compress through it too.
public enum Deflate {
  public static func raw(_ source: Data) throws -> Data {
    #if canImport(Compression)
      try compressed(source)
    #else
      StoredDeflate.encode(source)
    #endif
  }

  #if canImport(Compression)
    /// One compression_stream over the whole block, in 64 KiB output chunks.
    static func compressed(_ source: Data) throws -> Data {
      let chunk = 64 * 1024
      let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
      defer { stream.deallocate() }
      guard
        compression_stream_init(stream, COMPRESSION_STREAM_ENCODE, COMPRESSION_ZLIB)
          == COMPRESSION_STATUS_OK
      else { throw DeflateError.streamInit }
      defer { compression_stream_destroy(stream) }
      let output = UnsafeMutablePointer<UInt8>.allocate(capacity: chunk)
      defer { output.deallocate() }
      // compression_stream wants a pointer even for no input.
      var empty: UInt8 = 0
      return try source.withUnsafeBytes { (input: UnsafeRawBufferPointer) in
        try withUnsafePointer(to: &empty) { emptyPointer in
          stream.pointee.src_ptr =
            input.baseAddress?.assumingMemoryBound(to: UInt8.self) ?? emptyPointer
          stream.pointee.src_size = input.count
          var result = Data()
          while true {
            stream.pointee.dst_ptr = output
            stream.pointee.dst_size = chunk
            let status = compression_stream_process(
              stream, Int32(bitPattern: COMPRESSION_STREAM_FINALIZE.rawValue))
            guard status == COMPRESSION_STATUS_OK || status == COMPRESSION_STATUS_END else {
              throw DeflateError.streamFailed
            }
            result.append(output, count: chunk - stream.pointee.dst_size)
            if status == COMPRESSION_STATUS_END { return result }
          }
        }
      }
    }
  #endif
}
