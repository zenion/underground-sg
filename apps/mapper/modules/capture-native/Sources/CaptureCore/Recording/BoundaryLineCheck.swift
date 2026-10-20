#if USG_RECORDER
import Foundation

/// A boundary line the module accepted: its time and number, and the bytes to append, ending in
/// a newline.
public struct CheckedBoundaryLine: Equatable, Sendable {
  public let t: Double
  public let seq: Int
  public let bytes: Data
}

/// Why `appendBoundary` refused a line. No case carries anything from the line, so a refusal
/// can be counted and logged.
public enum BoundaryRefusal: Error, Equatable, Sendable {
  /// Over 64 KiB, the format's longest line.
  case tooLong
  /// It holds a line break, so it would be more than one line.
  case notOneLine
  /// Not a JSON object, or a field of the wrong type.
  case malformed
  /// Not exactly `t`, `seq`, `kind`, `value` and `binary`.
  case fields
  /// `t` negative or not finite.
  case badTime
  /// `t` outside the recording window: nothing outside it is written.
  case outsideWindow
  /// `t` before the previous line's.
  case timeOrder
  /// `seq` not after the last line's, or outside 0 to 999,999.
  case seqOrder
  /// `kind` not a short name.
  case kind
  /// `value` null, empty, longer than JSON text may be, or not JSON.
  case value
  /// `binary` not null: no binary results are recorded yet.
  case binary
}

/// Checks a boundary.jsonl line TypeScript hands the module through `appendBoundary`
/// (docs/session-recording.md; design D21) before it is written, so a bug in the TypeScript can't
/// put anything into the recording that the format or the window doesn't allow. TypeScript
/// serialises the line with sorted keys, and an accepted line is written exactly as it came.
public enum BoundaryLineCheck {
  static let fieldNames: Set<String> = ["t", "seq", "kind", "value", "binary"]

  /// Accepts `line` when it is one JSON object with exactly the five fields, `t` in the window
  /// and not before `lastT`, `seq` after `lastSeq` (TypeScript numbers them from 0 at the
  /// window's open; a refused line leaves a gap rather than refusing every line after it),
  /// `value` JSON text and `binary` null.
  public static func check(
    _ line: String, window: RecorderWindow, lastSeq: Int?, lastT: Double? = nil
  ) -> Result<CheckedBoundaryLine, BoundaryRefusal> {
    var bytes = Data(line.utf8)
    guard bytes.count <= LineEncoder.maxLineBytes else { return .failure(.tooLong) }
    guard !bytes.contains(0x0A), !bytes.contains(0x0D) else { return .failure(.notOneLine) }
    let fields: BoundaryFields
    do {
      fields = try JSONDecoder().decode(BoundaryFields.self, from: bytes)
    } catch let refusal as BoundaryRefusal {
      return .failure(refusal)
    } catch {
      return .failure(.malformed)
    }
    // The decoder keeps the first of two equal keys and JSON.parse on the PC the last, so a
    // repeated key would be checked here as one value and read there as another.
    guard hasPlainDistinctKeys(bytes) else { return .failure(.fields) }
    guard fields.t.isFinite, fields.t >= 0 else { return .failure(.badTime) }
    guard window.accepts(t: fields.t) else { return .failure(.outsideWindow) }
    if let lastT, fields.t < lastT { return .failure(.timeOrder) }
    guard (0...999_999).contains(fields.seq), fields.seq > (lastSeq ?? -1) else {
      return .failure(.seqOrder)
    }
    guard isKind(fields.kind) else { return .failure(.kind) }
    guard fields.binaryIsNull else { return .failure(.binary) }
    guard let value = fields.value, isJsonText(value) else { return .failure(.value) }
    bytes.append(0x0A)
    return .success(CheckedBoundaryLine(t: fields.t, seq: fields.seq, bytes: bytes))
  }

  /// `^[A-Za-z][A-Za-z0-9_.:-]{0,63}$`, the schema's `kind`.
  static func isKind(_ kind: String) -> Bool {
    let bytes = Array(kind.utf8)
    guard let first = bytes.first, bytes.count <= 64, isLetter(first) else { return false }
    return bytes.allSatisfy { byte in
      isLetter(byte) || (byte >= UInt8(ascii: "0") && byte <= UInt8(ascii: "9"))
        || byte == UInt8(ascii: "_") || byte == UInt8(ascii: ".") || byte == UInt8(ascii: ":")
        || byte == UInt8(ascii: "-")
    }
  }

  /// The top-level object's keys are all different and none is spelled with an escape: the five
  /// names never need one, and JSON.stringify doesn't use one, so an escaped key could only be a
  /// repeat in disguise. `bytes` is an object the decoder read, so every string is closed and a
  /// comma at depth 1 always comes before a key.
  static func hasPlainDistinctKeys(_ bytes: Data) -> Bool {
    let quote = UInt8(ascii: "\"")
    let backslash = UInt8(ascii: "\\")
    var keys: Set<Data> = []
    var depth = 0
    var expectingKey = false
    var index = bytes.startIndex
    while index < bytes.endIndex {
      let byte = bytes[index]
      if byte == quote {
        var end = index + 1
        var escaped = false
        while end < bytes.endIndex, bytes[end] != quote {
          if bytes[end] == backslash {
            escaped = true
            end += 1
          }
          end += 1
        }
        if depth == 1 && expectingKey {
          let key = Data(bytes[(index + 1)..<min(end, bytes.endIndex)])
          guard !escaped, keys.insert(key).inserted else { return false }
          expectingKey = false
        }
        index = end + 1
        continue
      }
      switch byte {
      case UInt8(ascii: "{"):
        depth += 1
        expectingKey = depth == 1
      case UInt8(ascii: "["):
        depth += 1
      case UInt8(ascii: "}"), UInt8(ascii: "]"):
        depth -= 1
      case UInt8(ascii: ","):
        if depth == 1 { expectingKey = true }
      default:
        break
      }
      index += 1
    }
    return true
  }

  /// One JSON value, at most JsonText's length.
  static func isJsonText(_ text: String) -> Bool {
    let count = text.unicodeScalars.count
    guard count >= 1, count <= JsonText.maxCodePoints else { return false }
    return (try? JSONSerialization.jsonObject(with: Data(text.utf8), options: .fragmentsAllowed))
      != nil
  }
}

private func isLetter(_ byte: UInt8) -> Bool {
  (byte >= UInt8(ascii: "A") && byte <= UInt8(ascii: "Z"))
    || (byte >= UInt8(ascii: "a") && byte <= UInt8(ascii: "z"))
}

/// A boundary line's fields, decoded only to be checked.
private struct BoundaryFields: Decodable {
  let t: Double
  let seq: Int
  let kind: String
  let value: String?
  let binaryIsNull: Bool

  private struct Key: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: Key.self)
    let names = container.allKeys.map(\.stringValue)
    guard names.count == BoundaryLineCheck.fieldNames.count,
      Set(names) == BoundaryLineCheck.fieldNames
    else { throw BoundaryRefusal.fields }
    t = try container.decode(Double.self, forKey: Key(stringValue: "t"))
    seq = try container.decode(Int.self, forKey: Key(stringValue: "seq"))
    kind = try container.decode(String.self, forKey: Key(stringValue: "kind"))
    value = try container.decodeNil(forKey: Key(stringValue: "value"))
      ? nil : container.decode(String.self, forKey: Key(stringValue: "value"))
    binaryIsNull = try container.decodeNil(forKey: Key(stringValue: "binary"))
  }
}
#endif
