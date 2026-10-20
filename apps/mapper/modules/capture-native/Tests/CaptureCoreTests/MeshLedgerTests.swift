#if USG_RECORDER
import Foundation
import Testing

@testable import CaptureCore

private func id(_ suffix: String) -> UUID {
  UUID(
    uuidString: "00000000-0000-4000-8000-" + String(repeating: "0", count: 12 - suffix.count)
      + suffix)!
}

@Suite struct MeshLedgerTests {
  @Test func theFirstBlockIsAnAddAndLaterOnesUpdates() {
    var ledger = MeshLedger()
    #expect(ledger.decide(anchor: id("a"), fingerprint: 1, final: false) == .writeNew(op: .add))
    let first = ledger.placeNew(
      anchor: id("a"), fingerprint: 1, bytes: 400, vertices: 30, faces: 40)
    #expect(first == MeshBlockRef(offset: 0, bytes: 400, vertices: 30, faces: 40))
    #expect(ledger.decide(anchor: id("a"), fingerprint: 2, final: false) == .writeNew(op: .update))
    let second = ledger.placeNew(
      anchor: id("a"), fingerprint: 2, bytes: 450, vertices: 32, faces: 44)
    #expect(second.offset == 400)
    #expect(ledger.binBytes == 850)
  }

  @Test func blocksArePlacedEndToEndAcrossAnchors() {
    var ledger = MeshLedger()
    let a = ledger.placeNew(anchor: id("a"), fingerprint: 1, bytes: 100, vertices: 3, faces: 1)
    let b = ledger.placeNew(anchor: id("b"), fingerprint: 1, bytes: 70, vertices: 3, faces: 1)
    let c = ledger.placeNew(anchor: id("c"), fingerprint: 1, bytes: 5, vertices: 3, faces: 1)
    #expect([a.offset, b.offset, c.offset] == [0, 100, 170])
    #expect(ledger.binBytes == 175)
  }

  @Test func anUnchangedGeometryIsSkipped() {
    var ledger = MeshLedger()
    _ = ledger.placeNew(anchor: id("a"), fingerprint: 7, bytes: 100, vertices: 3, faces: 1)
    // ARKit reported it updated, but it only moved: anchors.jsonl has the move.
    #expect(ledger.decide(anchor: id("a"), fingerprint: 7, final: false) == .skipUnchanged)
    #expect(ledger.binBytes == 100)
  }

  @Test func theFinalSnapshotReusesAnUnchangedBlock() {
    var ledger = MeshLedger()
    let block = ledger.placeNew(anchor: id("a"), fingerprint: 7, bytes: 100, vertices: 3, faces: 1)
    _ = ledger.placeNew(anchor: id("b"), fingerprint: 9, bytes: 60, vertices: 3, faces: 1)
    let copy = MeshBlockRef(offset: 160, bytes: 100, vertices: 3, faces: 1)
    #expect(
      ledger.decide(anchor: id("a"), fingerprint: 7, final: true) == .reuse(from: block, to: copy))
    #expect(ledger.binBytes == 260)
    // An anchor with no update since its last block is reused without a copy of its geometry.
    #expect(
      ledger.reuseLast(anchor: id("a"))
        == .reuse(from: block, to: MeshBlockRef(offset: 260, bytes: 100, vertices: 3, faces: 1)))
    #expect(ledger.binBytes == 360)
    // A changed one is written new, and one never written can't be reused.
    #expect(ledger.decide(anchor: id("b"), fingerprint: 10, final: true) == .writeNew(op: .update))
    #expect(ledger.decide(anchor: id("c"), fingerprint: 1, final: true) == .writeNew(op: .add))
    #expect(ledger.reuseLast(anchor: id("c")) == nil)
    #expect(ledger.binBytes == 360)
  }

  @Test func onlyAWrittenAnchorGetsARemoveLine() throws {
    var ledger = MeshLedger()
    #expect(ledger.removeLine(anchor: id("a"), t: 30, final: false, captureID: nil) == nil)
    _ = ledger.placeNew(anchor: id("a"), fingerprint: 1, bytes: 10, vertices: 3, faces: 1)
    #expect(ledger.hasWritten(id("a")))
    let removed = ledger.removeLine(anchor: id("a"), t: 30, final: false, captureID: nil)
    let line = try #require(removed)
    #expect(line.file == .meshIndex)
    #expect(
      String(decoding: try line.encode(LineEncoder()), as: UTF8.self)
        == #"{"anchor":"00000000-0000-4000-8000-00000000000a","bytes":null,"capture_id":null,"#
        + #""faces":null,"final":false,"offset":null,"op":"remove","t":30,"transform":null,"#
        + #""vertices":null}"# + "\n")
    // Forgotten: removed twice is one line, and if it comes back it is an add again.
    #expect(ledger.removeLine(anchor: id("a"), t: 31, final: false, captureID: nil) == nil)
    #expect(ledger.decide(anchor: id("a"), fingerprint: 1, final: false) == .writeNew(op: .add))
  }
}

@Suite struct FacingTests {
  @Test func facesAlongTheCamerasMinusZ() throws {
    let ahead = try #require(Facing.horizontal(camera: .identity))
    #expect(ahead == SIMD3(0, 0, -1))
    // Turned 90° to the left about the vertical: facing −x.
    let left = try #require(Facing.horizontal(camera: .yaw(Double.pi / 2, x: 3, z: -40)))
    #expect(abs(left.x + 1) < 1e-6 && abs(left.z) < 1e-6 && left.y == 0)
  }

  @Test func normalisesATiltedView() throws {
    // Looking down at the floor ahead, 0.3 of the view direction is horizontal.
    let tilted = WorldTransform(columnMajor: [
      1, 0, 0, 0,
      0, 0.3, -0.953_939_2, 0,
      0, 0.953_939_2, 0.3, 0,
      0, 1.4, 0, 1,
    ])
    let facing = try #require(Facing.horizontal(camera: tilted))
    #expect(facing == SIMD3(0, 0, -1))
  }

  @Test func hasNoneLookingNearlyStraightUpOrDown() {
    let down = WorldTransform(columnMajor: [
      1, 0, 0, 0,
      0, 0, -1, 0,
      0, 1, 0, 0,
      0, 1.4, 0, 1,
    ])
    #expect(Facing.horizontal(camera: down) == nil)
    let steep = WorldTransform(columnMajor: [
      1, 0, 0, 0,
      0, 0.1, -0.994_987_4, 0,
      0, 0.994_987_4, 0.1, 0,
      0, 1.4, 0, 1,
    ])
    #expect(Facing.horizontal(camera: steep) == nil)
  }
}
#endif
