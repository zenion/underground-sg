import Foundation
import Testing

@testable import CaptureIO

#if canImport(CryptoKit)
  import CryptoKit
#endif

// SHA-256 against the FIPS 180-4 example vectors (NIST's "SHA-256" examples and the long
// messages of the SHA Test Vectors for Hashing Byte-Oriented Messages), through Sha256Stream,
// whichever backend this platform compiles, and through the fallback wherever it is compiled.
// On macOS the fallback is also checked against CryptoKit (design D17).

private let vectors: [(message: Data, digest: String)] = [
  (Data(), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
  (Data("abc".utf8), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
  (
    Data("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq".utf8),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
  ),
  (
    Data(
      ("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmno"
        + "ijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu").utf8),
    "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1"
  ),
  (
    Data(repeating: UInt8(ascii: "a"), count: 1_000_000),
    "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
  ),
]

/// Feeds `data` in pieces of the given sizes, cycling through them.
private func chunked(_ data: Data, _ sizes: [Int], into stream: inout Sha256Stream) {
  var offset = 0
  var index = 0
  while offset < data.count {
    let end = min(data.count, offset + sizes[index % sizes.count])
    stream.update(data.subdata(in: offset..<end))
    offset = end
    index += 1
  }
}

@Suite struct Sha256StreamTests {
  @Test func matchesTheNistVectors() {
    for vector in vectors {
      #expect(Sha256Stream.hex(of: vector.message) == vector.digest)
    }
  }

  @Test func incrementalUpdatesInAnyPiecesGiveTheSameDigest() {
    let message = vectors[3].message
    for sizes in [[1], [3, 7], [63, 1, 64, 65], [55, 56, 57], [500]] {
      var stream = Sha256Stream()
      chunked(message, sizes, into: &stream)
      #expect(stream.hex() == vectors[3].digest)
      #expect(stream.byteCount == Int64(message.count))
    }
    var stream = Sha256Stream()
    chunked(vectors[4].message, [4096, 1, 8191], into: &stream)
    #expect(stream.hex() == vectors[4].digest)
  }

  @Test func aSnapshotIsTheDigestWhereItWasTaken() {
    // The cut checkpoint (design 7.4): the copy's digest is the truncated file's.
    let lines = lineBytes(10_000)
    var stream = Sha256Stream()
    stream.update(lines.prefix(6_000))
    let cut = stream.snapshot()
    stream.update(lines.dropFirst(6_000))
    #expect(cut.hex() == Sha256Stream.hex(of: lines.prefix(6_000)))
    #expect(cut.byteCount == 6_000)
    #expect(stream.hex() == Sha256Stream.hex(of: lines))
    // Reading the digest doesn't end the stream.
    #expect(stream.hex() == stream.hex())
    var restored = cut
    restored.update(Data("more".utf8))
    #expect(cut.hex() == Sha256Stream.hex(of: lines.prefix(6_000)))
    #expect(restored.hex() == Sha256Stream.hex(of: lines.prefix(6_000) + Data("more".utf8)))
  }

  @Test func updatesFromRawBytesCountTheSame() {
    let bytes = noiseBytes(777)
    var fromData = Sha256Stream()
    fromData.update(bytes)
    var fromPointer = Sha256Stream()
    bytes.withUnsafeBytes { fromPointer.update($0) }
    #expect(fromData.hex() == fromPointer.hex())
    #expect(fromPointer.byteCount == 777)
  }
}

#if !canImport(CryptoKit) || USG_IO_FALLBACKS
  @Suite struct Sha256FallbackTests {
    private func hex(_ data: Data, sizes: [Int] = [Int.max]) -> String {
      var hasher = Sha256Fallback()
      var offset = 0
      var index = 0
      while offset < data.count {
        let end = min(data.count, offset + min(sizes[index % sizes.count], data.count - offset))
        data.subdata(in: offset..<end).withUnsafeBytes { hasher.update(bufferPointer: $0) }
        offset = end
        index += 1
      }
      return Sha256Stream.hex(hasher.finalize())
    }

    @Test func matchesTheNistVectors() {
      for vector in vectors {
        #expect(hex(vector.message) == vector.digest)
        #expect(hex(vector.message, sizes: [1, 63, 64, 65]) == vector.digest)
      }
    }

    #if canImport(CryptoKit)
      @Test func agreesWithCryptoKit() {
        for count in Array(0...300) + [4095, 4096, 4097, 100_000] {
          let message = noiseBytes(count, seed: UInt64(count))
          let expected = Sha256Stream.hex(Array(SHA256.hash(data: message)))
          #expect(hex(message) == expected)
          #expect(hex(message, sizes: [7, 64, 1]) == expected)
        }
      }
    #endif
  }
#endif
