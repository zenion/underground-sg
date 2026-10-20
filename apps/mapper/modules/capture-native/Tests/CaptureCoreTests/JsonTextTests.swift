import Foundation
import Testing

@testable import CaptureCore

@Suite struct JsonTextTests {
  @Test func keepsTextThatFits() {
    let args = #"[{"role":"start","kind":"floor_point"}]"#
    #expect(JsonText.bounded(args) == args)
    let full = "\"" + String(repeating: "a", count: JsonText.maxCodePoints - 2) + "\""
    #expect(JsonText.bounded(full) == full)
  }

  @Test func replacesTextOverTheBoundWithTheMarker() {
    let long = "\"" + String(repeating: "a", count: JsonText.maxCodePoints - 1) + "\""
    #expect(long.unicodeScalars.count == JsonText.maxCodePoints + 1)
    #expect(JsonText.bounded(long) == #"{"omitted":"too_large","bytes":16385}"#)
  }

  @Test func countsCodePointsAndReportsUTF8Bytes() {
    // 16,384 code points of 4 UTF-8 bytes each fit, though they are 64 KiB; one more doesn't.
    let emoji = "\u{1F687}"
    let fits = String(repeating: emoji, count: JsonText.maxCodePoints)
    #expect(JsonText.bounded(fits) == fits)
    let over = fits + emoji
    #expect(JsonText.bounded(over) == #"{"omitted":"too_large","bytes":65540}"#)
  }

  @Test func theMarkerIsJsonWithOnlyTheSize() throws {
    let marker = JsonText.marker(bytes: 123_456)
    let object = try JSONSerialization.jsonObject(with: Data(marker.utf8)) as? [String: Any]
    #expect(object?["omitted"] as? String == "too_large")
    #expect(object?["bytes"] as? Int == 123_456)
    #expect(object?.count == 2)
  }
}
