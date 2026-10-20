#if USG_RECORDER
import Foundation
import Testing

@testable import CaptureCore

/// A window opened by a start mark at 3.2 s.
private func openWindow() -> RecorderWindow {
  var window = RecorderWindow()
  window.markAnchor(t: 3.2, role: .start)
  return window
}

/// A line as TypeScript serialises it: sorted keys, compact.
private func boundary(
  t: String = "3.25", seq: String = "0", kind: String = #""status""#,
  value: String = #""{\"fps\":60}""#, binary: String = "null"
) -> String {
  #"{"binary":"# + binary + #","kind":"# + kind + #","seq":"# + seq + #","t":"# + t
    + #","value":"# + value + "}"
}

private func refusal(
  _ line: String, window: RecorderWindow = openWindow(), lastSeq: Int? = nil, lastT: Double? = nil
) -> BoundaryRefusal? {
  switch BoundaryLineCheck.check(line, window: window, lastSeq: lastSeq, lastT: lastT) {
  case .success: nil
  case .failure(let refusal): refusal
  }
}

@Suite struct BoundaryLineCheckTests {
  @Test func acceptsALineInTheWindow() throws {
    let line = boundary()
    let checked = try BoundaryLineCheck.check(line, window: openWindow(), lastSeq: nil).get()
    #expect(checked.t == 3.25)
    #expect(checked.seq == 0)
    #expect(checked.bytes == Data((line + "\n").utf8))
  }

  @Test func refusesLinesOutsideTheWindow() {
    #expect(refusal(boundary(t: "3.1")) == .outsideWindow)
    #expect(refusal(boundary(), window: RecorderWindow()) == .outsideWindow)
    var closed = openWindow()
    closed.close(at: 10, reason: .background)
    #expect(refusal(boundary(t: "10"), window: closed) == nil)
    #expect(refusal(boundary(t: "10.5"), window: closed) == .outsideWindow)
    #expect(refusal(boundary(t: "-1")) == .badTime)
  }

  @Test func seqStrictlyIncreasesAndTNeverDecreases() {
    #expect(refusal(boundary(seq: "4"), lastSeq: 3) == nil)
    // A gap is allowed: a refused line mustn't refuse every line after it.
    #expect(refusal(boundary(seq: "6"), lastSeq: 3) == nil)
    #expect(refusal(boundary(seq: "3"), lastSeq: 3) == .seqOrder)
    #expect(refusal(boundary(seq: "2"), lastSeq: 3) == .seqOrder)
    #expect(refusal(boundary(seq: "1000000"), lastSeq: 3) == .seqOrder)
    #expect(refusal(boundary(seq: "-1")) == .seqOrder)
    #expect(refusal(boundary(t: "5"), lastT: 5) == nil)
    #expect(refusal(boundary(t: "4.9"), lastT: 5) == .timeOrder)
  }

  @Test func refusesAnythingButTheFiveFields() {
    #expect(refusal(#"{"kind":"status","seq":0,"t":3.25,"value":"1"}"#) == .fields)
    #expect(
      refusal(#"{"binary":null,"kind":"status","pose":[1],"seq":0,"t":3.25,"value":"1"}"#)
        == .fields)
    #expect(refusal("[1,2]") == .malformed)
    #expect(refusal("not json") == .malformed)
    #expect(refusal(boundary(t: #""3.25""#)) == .malformed)
    #expect(refusal(boundary(seq: "0.5")) == .malformed)
  }

  @Test func checksKindValueAndBinary() {
    #expect(refusal(boundary(kind: #""onStatus.v2:x-1""#)) == nil)
    #expect(refusal(boundary(kind: #""1status""#)) == .kind)
    #expect(refusal(boundary(kind: "\"\"")) == .kind)
    #expect(refusal(boundary(kind: "\"" + String(repeating: "k", count: 65) + "\"")) == .kind)
    #expect(refusal(boundary(value: "null")) == .value)
    #expect(refusal(boundary(value: "\"\"")) == .value)
    #expect(refusal(boundary(value: #""{not json""#)) == .value)
    #expect(refusal(boundary(value: "12")) == .malformed)
    let tooLong = "\"" + String(repeating: "1", count: JsonText.maxCodePoints + 1) + "\""
    #expect(refusal(boundary(value: tooLong)) == .value)
    // No binary results are recorded yet.
    #expect(refusal(boundary(value: "null", binary: #""boundary/000000.f32""#)) == .binary)
  }

  @Test func refusesALineThatIsTooLongOrNotOneLine() {
    let pad = String(repeating: " ", count: LineEncoder.maxLineBytes)
    #expect(refusal(boundary() + pad) == .tooLong)
    #expect(refusal(boundary().replacingOccurrences(of: ",", with: ",\n")) == .notOneLine)
    #expect(refusal(boundary() + "\r") == .notOneLine)
  }
}
#endif
