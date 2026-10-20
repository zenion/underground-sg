import Foundation
import Testing

@testable import CaptureIO

#if canImport(Compression)
  import Compression
#endif

// Deflate.raw round trips through the test target's inflate on every platform, and on macOS
// through Compression's own decoder too, which also reads the stored-block fallback (design
// D17). The inflate is checked first against streams zlib wrote.

/// zlib 1.3 `deflateRaw` with Z_FIXED of `fixedText`: one fixed-Huffman block.
private let fixedText = Data(
  "Esplanade Exit F to South Beach, Exit G to Raffles City. Esplanade Exit F to South Beach.".utf8)
private let fixedStream = data(
  hex: "732d2ec849cc4b4c495570adc82c51705328c95708ce2f2dc950704a4d4cced08108bb83848312d3d272528b"
    + "159c334b2af5145cf16bd40300")

/// Synthetic lines that zlib 1.3 `deflateRaw` at level 9 writes as one dynamic-Huffman block.
private let dynamicText = Data(
  (0..<300).map { i in "frame \(i * i % 1009) tracking \(i % 7 == 0 ? "limited" : "normal")\n" }
    .joined().utf8)
private let dynamicStream = data(
  hex: "7dd95d8a50310c05e07757314b68daa4699733e828838ec2e0fe11447044be79bda56d9a9f734e723fbf3ebe"
    + "3c3d8c879faf8f1fbf3e7ffff2f0edf9e5f9e7d3a70f9f7f2fc4df85ef3f5e5f1ebffdf99ef87ef13d3616666161"
    + "69475e19bb65d5d133620cad4ceec9e423f9fcbb65f4a40766d1694717ad99f4276349276486cccea38b6acab8"
    + "6a3d68d3099b7b9af7f45bdbfe35fba4bc70e9854bcf85ac3e4cab6cc5349c22a71954866ec9b68aa9951b8c82"
    + "f674957d4d8f4e3d48dfef6165058b4499b3ce725ad3396f37fdeb1c5ed434eef841633497ae514476afa5e3b2"
    + "58c2cdb75e632c63979388cd3a7907e198f2b518bb431061096f82488ca15db12ed33159aa41bbf5d6e69e63f0"
    + "5bf636012695dbc534ddad7b0e4129c66092c4766e33e28354433170ea30765a7045ae4b2469a21f15cc656e07"
    + "7dba68764d0260b3bc6e50dd845cba8210c3d37a2a7477916b8228b74a0faa5d1410d3794abe89c50227b5efed"
    + "3a36431cd683a5d7a454b1e7c836edb0d2a7f50ee3c97393722d2fa1d1a2f592bd26b54a5e562bf539e1a289f4"
    + "4e9143efecc53cd03b37a37d9cf3aca09c84bf0ee2c865b4d93f955d9da4148acc9cc366134df57d4cfa7ab1d7"
    + "6067c7d3ca547382a565b144eaec246d505037db3737be4c904546db5402f79a82583ed436f78435d4e57187c7"
    + "59ccd2b8add3180477623dace2381420903308c1ce32d9501c035f5841d5656749ec25616ce228270c3968751f"
    + "02520990ea9d4e9978645aa0df9aad416ef202c33d993c3be938f239a76ac703bfc969ca26565186645b8a11ae"
    + "29283a28b183312d43080b6879c640f09f49ce6a4bec61f162b3c9c1c4d1534c38b7f1ef7406e626361a6c608b"
    + "a1bb944fb928bd2f736431b30f4176b6a7059c4a0c8ffc38e64ecaa7cd2110270c45a2639216955d51c413f92e"
    + "f13a29472ffbf464f2de32f45127266926e99d6bf04d3f883ac02389e63d6f83fddfe88cc04c15bbac03dc9b51"
    + "9433ada7bb74ea8d60f6f4346f929fd91aade9c2e2e02cdd83f141454048bbd47f3b08d883293269dbf190bbc9"
    + "4034bb86ff3951d710f926f3baf9e36071a877d9c017873f9c2fef0efb9ae281f892a4cd7027fc7f487f01")

/// Inputs for the round trips: empty, tiny, the stored-block boundaries, lines that compress
/// well, and noise that doesn't.
private let samples: [Data] = [
  Data(), Data([0x2a]), lineBytes(65_534), lineBytes(65_535), lineBytes(65_536),
  lineBytes(200_000), noiseBytes(70_000), noiseBytes(1_048_576, seed: 9) + lineBytes(300_000),
]

@Suite struct InflateTests {
  @Test func decodesZlibsFixedHuffmanBlock() throws {
    #expect((fixedStream[0] >> 1) & 3 == 1)
    #expect(try inflateRaw(fixedStream) == fixedText)
  }

  @Test func decodesZlibsDynamicHuffmanBlock() throws {
    #expect((dynamicStream[0] >> 1) & 3 == 2)
    #expect(dynamicText.count == 7801)
    #expect(try inflateRaw(dynamicStream) == dynamicText)
  }

  @Test func refusesDamage() {
    // A stored block whose NLEN isn't LEN's complement.
    #expect(throws: InflateError.self) { try inflateRaw(Data([0x01, 0x01, 0x00, 0xff, 0xff, 0x41])) }
    // Cut short.
    #expect(throws: InflateError.self) { try inflateRaw(dynamicStream.prefix(400)) }
    // Bytes after the final block.
    #expect(throws: InflateError.self) { try inflateRaw(fixedStream + Data([0])) }
    // Block type 3.
    #expect(throws: InflateError.self) { try inflateRaw(Data([0x07])) }
  }
}

@Suite struct DeflateTests {
  @Test func rawRoundTrips() throws {
    for sample in samples {
      let compressed = try Deflate.raw(sample)
      #expect(!compressed.isEmpty)
      #expect(try inflateRaw(compressed) == sample)
    }
  }

  #if canImport(Compression)
    /// Compression's own raw-DEFLATE decoder.
    private func decode(_ stream: Data, expecting count: Int) -> Data? {
      // One spare byte: a stream that decodes to more than `count` fills it.
      let capacity = count + 1
      var out = [UInt8](repeating: 0, count: capacity)
      let written = stream.withUnsafeBytes { (source: UnsafeRawBufferPointer) -> Int in
        guard let base = source.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return 0 }
        return compression_decode_buffer(
          &out, capacity, base, source.count, nil, COMPRESSION_ZLIB)
      }
      return Data(out.prefix(written))
    }

    @Test func compressionDecodesWhatRawWrites() throws {
      for sample in samples where !sample.isEmpty {
        let compressed = try Deflate.raw(sample)
        #expect(decode(compressed, expecting: sample.count) == sample)
      }
      // Lines compress: this is Compression, not the stored fallback.
      let lines = lineBytes(200_000)
      #expect(try Deflate.raw(lines).count < lines.count / 2)
    }

    @Test func compressionAndTheFallbackAgreeOnEveryInput() throws {
      for sample in samples where !sample.isEmpty {
        let stored = StoredDeflate.encode(sample)
        #expect(decode(stored, expecting: sample.count) == sample)
        #expect(try inflateRaw(Deflate.compressed(sample)) == sample)
      }
      #expect(decode(dynamicStream, expecting: dynamicText.count) == dynamicText)
    }
  #endif
}

#if !canImport(Compression) || USG_IO_FALLBACKS
  @Suite struct StoredDeflateTests {
    @Test func writesTheFewestStoredBlocks() throws {
      for (count, blocks) in [(0, 1), (1, 1), (65_535, 1), (65_536, 2), (200_000, 4)] {
        let source = noiseBytes(count)
        let stored = StoredDeflate.encode(source)
        #expect(stored.count == count + 5 * blocks)
        #expect(try inflateRaw(stored) == source)
      }
    }

    @Test func onlyTheLastBlockIsFinal() {
      let stored = StoredDeflate.encode(noiseBytes(65_536))
      #expect(stored[0] == 0x00)
      #expect(Array(stored[1..<5]) == [0xff, 0xff, 0x00, 0x00])
      let second = 5 + 65_535
      #expect(stored[second] == 0x01)
      #expect(Array(stored[(second + 1)..<(second + 5)]) == [0x01, 0x00, 0xfe, 0xff])
    }

    @Test func anEmptyInputIsOneEmptyFinalBlock() {
      #expect(StoredDeflate.encode(Data()) == Data([0x01, 0x00, 0x00, 0xff, 0xff]))
    }
  }
#endif
