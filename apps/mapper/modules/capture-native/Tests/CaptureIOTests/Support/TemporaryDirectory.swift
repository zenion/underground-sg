import Foundation

/// A fresh directory under the system's temporary directory, removed when the test is done.
/// Only synthetic bytes are ever written here.
final class TemporaryDirectory {
  let url: URL

  init() throws {
    url = FileManager.default.temporaryDirectory.appendingPathComponent(
      "capture-io-\(UUID().uuidString.lowercased())", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
  }

  deinit {
    try? FileManager.default.removeItem(at: url)
  }

  func file(_ name: String) -> URL { url.appendingPathComponent(name, isDirectory: false) }

  func directory(_ name: String) throws -> URL {
    let child = url.appendingPathComponent(name, isDirectory: true)
    try FileManager.default.createDirectory(at: child, withIntermediateDirectories: true)
    return child
  }

  func contents(_ name: String) -> Data? { FileManager.default.contents(atPath: file(name).path) }

  /// The names in a directory, sorted.
  func names(in directory: URL) throws -> [String] {
    try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
  }
}

/// Deterministic bytes that don't compress: a 64-bit LCG's high bytes.
func noiseBytes(_ count: Int, seed: UInt64 = 0x5eed) -> Data {
  var state = seed
  var bytes = [UInt8]()
  bytes.reserveCapacity(count)
  for _ in 0..<count {
    state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
    bytes.append(UInt8(truncatingIfNeeded: state >> 56))
  }
  return Data(bytes)
}

/// Lines like a recording's, which compress well. Synthetic: no sensor data.
func lineBytes(_ count: Int) -> Data {
  var text = ""
  var index = 0
  while text.utf8.count < count {
    text += "{\"t\":\(Double(index) / 60),\"frame\":\(index),\"tracking\":\"normal\"}\n"
    index += 1
  }
  return Data(text.utf8.prefix(count))
}

func data(hex: String) -> Data {
  var bytes = [UInt8]()
  var high: UInt8?
  for character in hex.utf8 {
    let nibble: UInt8
    switch character {
    case UInt8(ascii: "0")...UInt8(ascii: "9"): nibble = character - UInt8(ascii: "0")
    case UInt8(ascii: "a")...UInt8(ascii: "f"): nibble = character - UInt8(ascii: "a") + 10
    default: continue
    }
    if let value = high {
      bytes.append(value << 4 | nibble)
      high = nil
    } else {
      high = nibble
    }
  }
  return Data(bytes)
}
