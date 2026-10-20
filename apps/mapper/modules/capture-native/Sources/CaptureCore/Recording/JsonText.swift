/// JSON text (docs/session-recording.md, "Values, frames and time"): what JavaScript passed or
/// received, whose shape the module doesn't fix, held as a string that parses as one JSON value.
/// `args` and `result` in actions.jsonl and `value` in boundary.jsonl are JSON text. A value is
/// never truncated, since half a JSON value doesn't parse: one that is too long is replaced
/// whole by the too-large marker, which validate-recording reports as a warning.
///
/// Not gated by USG_RECORDER: the bundle's writers may bound JSON text too.
public enum JsonText {
  /// The schema's `maxLength` for JSON text, in Unicode code points (as JSON Schema counts).
  public static let maxCodePoints = 16_384

  /// `json` as it is when it fits, else the marker in its place. The caller passes JSON text
  /// (from JSONSerialization or JSON.stringify), never an empty string.
  public static func bounded(_ json: String) -> String {
    json.unicodeScalars.count <= maxCodePoints ? json : marker(for: json)
  }

  /// The marker that stands in for a value too large to keep. It names only the value's size in
  /// UTF-8 bytes, never any of its content.
  public static func marker(for json: String) -> String {
    marker(bytes: json.utf8.count)
  }

  /// The marker for a value of `bytes` UTF-8 bytes.
  public static func marker(bytes: Int) -> String {
    #"{"omitted":"too_large","bytes":"# + String(bytes) + "}"
  }
}
