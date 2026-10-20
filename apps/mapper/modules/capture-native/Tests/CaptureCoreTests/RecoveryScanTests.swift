#if USG_RECORDER
import Foundation
import Testing

@testable import CaptureCore

// RecoveryScan on synthetic damage: what a crash or a power loss can leave at the end of a file.

private func lines(_ ts: [Double], final: Bool = false) -> Data {
  Data(
    ts.map {
      #"{"kind":"memory_warning","t":"# + String($0) + (final ? #","final":true}"# : "}") + "\n"
    }.joined().utf8)
}

@Suite struct RecoveryScanJsonlTests {
  @Test func wholeOrderedLinesAreKept() {
    let data = lines([1, 2, 2, 3.5])
    let scan = RecoveryScan.jsonl(data)
    #expect(scan == JsonlScan(keepBytes: data.count, lines: 4, lastT: 3.5, stop: .end))
    #expect(RecoveryScan.jsonl(Data()) == JsonlScan(keepBytes: 0, lines: 0, lastT: nil, stop: .end))
  }

  @Test(arguments: [
    (#"{"t":4,"kind":"memo"#, "a torn line"),
    (#"{"t":4}"#, "a missing newline"),
    (String(repeating: "\u{0}", count: 40), "a NUL tail"),
    ("garbage\n", "garbage"),
    (#"{"t":1.5}"# + "\n", "t going back"),
    (#"{"t":"4"}"# + "\n", "t not a number"),
    (#"{"t":-1}"# + "\n", "a negative t"),
    ("[4]\n", "not an object"),
    ("\n", "a blank line"),
  ])
  func damageStopsTheScanAtTheLastGoodLine(_ tail: String, _ what: String) {
    let good = lines([1, 2, 3])
    let scan = RecoveryScan.jsonl(good + Data(tail.utf8) + lines([9]))
    #expect(scan.keepBytes == good.count, "\(what)")
    #expect(scan.lines == 3)
    #expect(scan.lastT == 3)
    #expect(scan.stop == .damaged)
  }

  @Test func aCutStopsAtTheFirstLinePastIt() {
    let kept = lines([1, 2, 3])
    let scan = RecoveryScan.jsonl(kept + lines([3.5, 4]), cutT: 3.2)
    #expect(scan == JsonlScan(keepBytes: kept.count, lines: 3, lastT: 3, stop: .cut))
  }

  @Test func finalLinesAreDroppedOnlyWhenAsked() {
    let kept = lines([1, 2])
    let data = kept + lines([2.5], final: true)
    #expect(RecoveryScan.jsonl(data).stop == .end)
    let scan = RecoveryScan.jsonl(data, dropFinal: true)
    #expect(scan.keepBytes == kept.count)
    #expect(scan.stop == .finalLine)
  }

  @Test func theClosedEventIsDroppedOnlyWhenAsked() {
    let kept = lines([1, 2, 3])
    let closed = Data((#"{"detail":"stop","kind":"recording_closed","t":3}"# + "\n").utf8)
    #expect(RecoveryScan.jsonl(kept + closed).stop == .end)
    let scan = RecoveryScan.jsonl(kept + closed, cutT: 3, dropClosedEvent: true)
    #expect(scan == JsonlScan(keepBytes: kept.count, lines: 3, lastT: 3, stop: .closedEvent))
    // A `kind` that isn't a string is no event of the recorder's: the line stays.
    let other = lines([1]) + Data((#"{"kind":7,"t":2}"# + "\n").utf8)
    #expect(RecoveryScan.jsonl(other, dropClosedEvent: true).stop == .end)
  }

  @Test func chunksOfAnySizeGiveTheSameResult() {
    let data = lines([1, 2, 3, 4, 5]) + Data(#"{"t":6"#.utf8)
    let whole = RecoveryScan.jsonl(data, cutT: 4.5)
    for size in [1, 3, 7, 64] {
      var scanner = JsonlScanner(cutT: 4.5)
      var start = 0
      while start < data.count {
        scanner.feed(data.subdata(in: start..<min(data.count, start + size)))
        start += size
      }
      #expect(scanner.finish() == whole, "chunks of \(size)")
    }
  }

  @Test func aLineLongerThanTheFormatAllowsIsDamage() {
    var scanner = JsonlScanner()
    scanner.feed(lines([1]))
    scanner.feed(Data(repeating: 0x41, count: LineEncoder.maxLineBytes + 1))
    let scan = scanner.finish()
    #expect(scan.stop == .damaged)
    #expect(scan.lines == 1)
  }
}

/// A mesh history built the way the writer builds it: each block appended before its line.
private struct MeshHistory {
  var index = Data()
  var bin = Data()

  mutating func block(t: Double, faces: Int, final: Bool = false, corrupt: Bool = false) {
    let packed = try! MeshBlockLayout.pack(
      vertices: stripGeometry(faces: faces).vertices, faces: stripGeometry(faces: faces).faces,
      classes: stripGeometry(faces: faces).classes)
    var block = storedDeflate(packed.data)
    if corrupt {
      block[block.count - 1] ^= 0xff
      block[1] ^= 0x01
    }
    let line = PendingLine.meshBlock(
      t: t, anchor: testUUID(1), op: bin.isEmpty ? .add : .update, transform: .identity,
      vertices: packed.vertices, faces: packed.faces, final: final, captureID: nil
    ).placed(offset: Int64(bin.count), bytes: block.count)
    bin.append(block)
    index.append(try! line.encode(LineEncoder()))
  }

  mutating func remove(t: Double) {
    index.append(
      try! PendingLine.meshRemove(t: t, anchor: testUUID(1), final: false, captureID: nil).encode(
        LineEncoder()))
  }

  func scan(checkpoint: Int64, binBytes: Int64? = nil, cutT: Double? = nil, dropFinal: Bool = false)
    -> MeshHistoryScan
  {
    RecoveryScan.meshHistory(
      index: index, binBytes: binBytes ?? Int64(bin.count), checkpointBinBytes: checkpoint,
      cutT: cutT, dropFinal: dropFinal,
      readBlock: { offset, count in
        let start = Int(offset)
        return start + count <= bin.count ? bin.subdata(in: start..<(start + count)) : nil
      },
      inflatedLength: { storedInflate($0)?.count })
  }
}

@Suite struct RecoveryScanMeshTests {
  @Test func aWholeHistoryIsKept() {
    var history = MeshHistory()
    history.block(t: 2, faces: 4)
    history.block(t: 7, faces: 6)
    history.remove(t: 12)
    let scan = history.scan(checkpoint: 0)
    #expect(scan.indexKeepBytes == history.index.count)
    #expect(scan.binKeepBytes == Int64(history.bin.count))
    #expect(scan.lines == 3)
    #expect(scan.stop == .end)
  }

  @Test func anIndexLinePastTheEndOfTheBinIsDamage() {
    var history = MeshHistory()
    history.block(t: 2, faces: 4)
    let firstIndex = history.index.count
    let firstBin = Int64(history.bin.count)
    history.block(t: 7, faces: 6)
    // The bin lost its last block (a power loss before the sync), the index didn't.
    let scan = history.scan(checkpoint: 0, binBytes: firstBin + 10)
    #expect(scan.indexKeepBytes == firstIndex)
    #expect(scan.binKeepBytes == firstBin)
    #expect(scan.stop == .damaged)
  }

  @Test func aBadBlockPastTheCheckpointIsDamageButBeforeItIsTrusted() {
    var history = MeshHistory()
    history.block(t: 2, faces: 4)
    let firstIndex = history.index.count
    let firstBin = Int64(history.bin.count)
    history.block(t: 7, faces: 6, corrupt: true)
    let past = history.scan(checkpoint: firstBin)
    #expect(past.indexKeepBytes == firstIndex)
    #expect(past.binKeepBytes == firstBin)
    #expect(past.stop == .damaged)
    // Synced at the checkpoint: not inflated again.
    #expect(history.scan(checkpoint: Int64(history.bin.count)).stop == .end)
  }

  @Test func aBlockWithoutItsLineIsCutFromTheBin() {
    var history = MeshHistory()
    history.block(t: 2, faces: 4)
    let firstBin = Int64(history.bin.count)
    let index = history.index
    history.block(t: 7, faces: 6)
    history.index = index
    let scan = history.scan(checkpoint: 0)
    #expect(scan.stop == .end)
    #expect(scan.binKeepBytes == firstBin)
  }

  @Test func cutAndFinalLinesStopTheScan() {
    var history = MeshHistory()
    history.block(t: 2, faces: 4)
    let firstIndex = history.index.count
    history.block(t: 7, faces: 6, final: true)
    #expect(history.scan(checkpoint: 0, cutT: 5).indexKeepBytes == firstIndex)
    #expect(history.scan(checkpoint: 0, cutT: 5).stop == .cut)
    let final = history.scan(checkpoint: 0, dropFinal: true)
    #expect(final.indexKeepBytes == firstIndex)
    #expect(final.stop == .finalLine)
  }

  @Test func anOffsetThatDoesntFollowOnIsDamage() {
    var history = MeshHistory()
    history.block(t: 2, faces: 4)
    let bad = PendingLine.meshBlock(
      t: 3, anchor: testUUID(2), op: .add, transform: .identity, vertices: 6, faces: 4,
      final: false, captureID: nil
    ).placed(offset: 3, bytes: 10)
    history.index.append(try! bad.encode(LineEncoder()))
    history.bin.append(Data(repeating: 0, count: 10))
    #expect(history.scan(checkpoint: 0).stop == .damaged)
    #expect(history.scan(checkpoint: 0).lines == 1)
  }
}
#endif
