import Foundation

// A small raw-DEFLATE decoder (RFC 1951) for the tests, after zlib's puff: stored, fixed-Huffman
// and dynamic-Huffman blocks. It decodes what Deflate.raw writes on any platform, StoredDeflate's
// blocks and Compression's alike, so the round trips need no zlib. It is checked itself against
// streams zlib wrote (DeflateTests). Strict: anything after the final block is an error.

struct InflateError: Error, Equatable {
  let reason: String
}

func inflateRaw(_ data: Data) throws -> Data {
  var input = BitReader(bytes: [UInt8](data))
  var out: [UInt8] = []
  var final = false
  while !final {
    final = try input.bits(1) == 1
    switch try input.bits(2) {
    case 0: try stored(&input, &out)
    case 1: try codes(&input, &out, literals: fixedTables.literals, distances: fixedTables.distances)
    case 2:
      let tables = try dynamicTables(&input)
      try codes(&input, &out, literals: tables.literals, distances: tables.distances)
    default: throw InflateError(reason: "block type 3")
    }
  }
  guard input.atEnd else { throw InflateError(reason: "bytes after the final block") }
  return Data(out)
}

private struct BitReader {
  let bytes: [UInt8]
  var position = 0
  var buffer = 0
  var count = 0

  init(bytes: [UInt8]) { self.bytes = bytes }

  /// The next `n` bits, least significant first.
  mutating func bits(_ n: Int) throws -> Int {
    while count < n {
      guard position < bytes.count else { throw InflateError(reason: "ran out of input") }
      buffer |= Int(bytes[position]) << count
      position += 1
      count += 8
    }
    let value = buffer & ((1 << n) - 1)
    buffer >>= n
    count -= n
    return value
  }

  /// Drops the bits left in the current byte.
  mutating func align() {
    buffer = 0
    count = 0
  }

  mutating func byte() throws -> UInt8 {
    guard position < bytes.count else { throw InflateError(reason: "ran out of input") }
    position += 1
    return bytes[position - 1]
  }

  /// Every byte consumed; only padding bits may be left.
  var atEnd: Bool { position == bytes.count }
}

private func stored(_ input: inout BitReader, _ out: inout [UInt8]) throws {
  input.align()
  let length = Int(try input.byte()) | Int(try input.byte()) << 8
  let check = Int(try input.byte()) | Int(try input.byte()) << 8
  guard length ^ check == 0xffff else { throw InflateError(reason: "stored length check") }
  for _ in 0..<length { out.append(try input.byte()) }
}

/// A canonical Huffman code: how many codes of each length, and the symbols in code order.
private struct Huffman {
  var counts = [Int](repeating: 0, count: 16)
  var symbols: [Int] = []

  init(lengths: [Int]) throws {
    for length in lengths { counts[length] += 1 }
    var left = 1
    for length in 1..<16 {
      left <<= 1
      left -= counts[length]
      guard left >= 0 else { throw InflateError(reason: "over-subscribed code") }
    }
    var offsets = [Int](repeating: 0, count: 16)
    for length in 1..<15 { offsets[length + 1] = offsets[length] + counts[length] }
    symbols = [Int](repeating: 0, count: lengths.count)
    for (symbol, length) in lengths.enumerated() where length != 0 {
      symbols[offsets[length]] = symbol
      offsets[length] += 1
    }
  }

  func decode(_ input: inout BitReader) throws -> Int {
    var code = 0
    var first = 0
    var index = 0
    for length in 1..<16 {
      code |= try input.bits(1)
      let count = counts[length]
      if code - count < first { return symbols[index + (code - first)] }
      index += count
      first += count
      first <<= 1
      code <<= 1
    }
    throw InflateError(reason: "no such code")
  }
}

private let lengthBase = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
]
private let lengthExtra = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]
private let distanceBase = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
]
private let distanceExtra = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]

private func codes(
  _ input: inout BitReader, _ out: inout [UInt8], literals: Huffman, distances: Huffman
) throws {
  while true {
    let symbol = try literals.decode(&input)
    if symbol < 256 {
      out.append(UInt8(symbol))
    } else if symbol == 256 {
      return
    } else {
      let index = symbol - 257
      guard index < 29 else { throw InflateError(reason: "bad length symbol") }
      let length = lengthBase[index] + (try input.bits(lengthExtra[index]))
      let code = try distances.decode(&input)
      guard code < 30 else { throw InflateError(reason: "bad distance symbol") }
      let distance = distanceBase[code] + (try input.bits(distanceExtra[code]))
      guard distance <= out.count else { throw InflateError(reason: "distance too far back") }
      for _ in 0..<length { out.append(out[out.count - distance]) }
    }
  }
}

private let fixedTables: (literals: Huffman, distances: Huffman) = {
  var lengths = [Int](repeating: 8, count: 288)
  for symbol in 144..<256 { lengths[symbol] = 9 }
  for symbol in 256..<280 { lengths[symbol] = 7 }
  // The fixed codes are complete, so these can't throw.
  let literals = try! Huffman(lengths: lengths)
  let distances = try! Huffman(lengths: [Int](repeating: 5, count: 30))
  return (literals, distances)
}()

private let codeLengthOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

private func dynamicTables(_ input: inout BitReader) throws -> (
  literals: Huffman, distances: Huffman
) {
  let literalCount = try input.bits(5) + 257
  let distanceCount = try input.bits(5) + 1
  let codeLengthCount = try input.bits(4) + 4
  guard literalCount <= 286, distanceCount <= 30 else {
    throw InflateError(reason: "too many codes")
  }
  var codeLengths = [Int](repeating: 0, count: 19)
  for index in 0..<codeLengthCount { codeLengths[codeLengthOrder[index]] = try input.bits(3) }
  let codeLengthCode = try Huffman(lengths: codeLengths)
  var lengths: [Int] = []
  while lengths.count < literalCount + distanceCount {
    let symbol = try codeLengthCode.decode(&input)
    switch symbol {
    case 0..<16:
      lengths.append(symbol)
    case 16:
      guard let previous = lengths.last else { throw InflateError(reason: "repeat with nothing") }
      lengths += [Int](repeating: previous, count: 3 + (try input.bits(2)))
    case 17:
      lengths += [Int](repeating: 0, count: 3 + (try input.bits(3)))
    default:
      lengths += [Int](repeating: 0, count: 11 + (try input.bits(7)))
    }
  }
  guard lengths.count == literalCount + distanceCount else {
    throw InflateError(reason: "lengths overrun")
  }
  guard lengths[256] != 0 else { throw InflateError(reason: "no end-of-block code") }
  return (
    try Huffman(lengths: Array(lengths[0..<literalCount])),
    try Huffman(lengths: Array(lengths[literalCount...]))
  )
}
