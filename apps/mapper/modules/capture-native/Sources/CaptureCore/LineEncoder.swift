import Foundation

/// Why a line or document could not be written. The cases carry no values from the data, only a
/// size, so an error can be logged without leaking a pose, a time or a fix (ADR 0005).
public enum LineEncodingError: Error, Equatable, Sendable {
  /// A number was NaN or infinite. JSON has no text for them, and the schemas refuse them.
  case nonFinite
  /// The encoded line or document is longer than the limit the PC tools enforce.
  case tooLong(bytes: Int)
}

/// Turns the generated Codable types into the bytes of one JSONL line or one JSON document, the
/// way docs/capture-bundle.md and docs/session-recording.md want them: UTF-8, keys sorted,
/// slashes unescaped, one line ending in a newline. Sorted keys make the output deterministic, so
/// the golden files in the tests can compare it byte for byte with what the schemas accept.
///
/// A struct holding one configured JSONEncoder, so a writer builds it once and not per line.
/// JSONEncoder is a class, but Foundation marks it `@unchecked Sendable` (its settings are
/// guarded internally), and this never changes the settings after init, so the struct is
/// Sendable without a lock.
struct LineEncoder: Sendable {
  /// One JSONL line, without its newline: DEFAULT_RECORDING_LIMITS.maxJsonlLineBytes.
  static let maxLineBytes = 64 * 1024
  /// One JSON document (recording.json, parts.json): DEFAULT_RECORDING_LIMITS.maxJsonBytes.
  static let maxDocumentBytes = 16 * 1024 * 1024

  private let encoder: JSONEncoder

  init() {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    // The default, said out loud: a NaN or an infinity throws rather than being written as text.
    encoder.nonConformingFloatEncodingStrategy = .throw
    self.encoder = encoder
  }

  /// One JSON object on one line, followed by "\n".
  func line<T: Encodable>(_ value: T) throws -> Data {
    try encode(value, limit: Self.maxLineBytes)
  }

  /// A whole JSON document, followed by "\n". Written compact, like a line, so the same bytes
  /// come out on every platform.
  func document<T: Encodable>(_ value: T) throws -> Data {
    try encode(value, limit: Self.maxDocumentBytes)
  }

  private func encode<T: Encodable>(_ value: T, limit: Int) throws -> Data {
    var data: Data
    do {
      data = try encoder.encode(value)
    } catch is EncodingError {
      // JSONEncoder's only error is invalidValue, and with the types here it means a NaN or an
      // infinity. Its context names the value, so it is not passed on.
      throw LineEncodingError.nonFinite
    }
    guard data.count <= limit else { throw LineEncodingError.tooLong(bytes: data.count) }
    data.append(0x0A)
    return data
  }
}

extension Double {
  /// The Double whose shortest decimal text is the Float's. ARKit gives poses as float32; widened
  /// with `Double(_:)`, 0.866025 becomes 0.8660249710083008, which is longer and claims precision
  /// the sensor never had. Going through the Float's shortest text keeps lines short. For a very
  /// few floats, reading that text as a Double and then narrowing rounds twice and lands one ulp
  /// off; those take the exact widening, which is longer but loses nothing. So
  /// `Float(Double(shortest: f)) == f` always holds, as it does for a reader that narrows the
  /// number it parsed. A NaN or an infinity stays one, and the encoder then refuses it.
  public init(shortest value: Float) {
    guard value.isFinite, let parsed = Double(value.description), Float(parsed) == value else {
      self = Double(value)
      return
    }
    self = parsed
  }
}
