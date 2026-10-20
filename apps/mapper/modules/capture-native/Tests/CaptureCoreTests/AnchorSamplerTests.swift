import Foundation
import Testing

@testable import CaptureCore

/// Synthetic anchors in the session frame (metres, no real coordinates needed): a keyframe anchor
/// in the Exit F link, an image anchor on a sign, mesh anchors along the Exit G passage. Ids are
/// fixed so the expected order is known.
private func id(_ suffix: String) -> UUID {
  UUID(
    uuidString: "00000000-0000-4000-8000-" + String(repeating: "0", count: 12 - suffix.count)
      + suffix)!
}

private func lowercased(_ ids: [UUID]) -> [String] {
  ids.map { $0.uuidString.lowercased() }
}

private let degree = Double.pi / 180

/// The generated enums are not CaseIterable, so these exhaustive switches (no default) are what
/// tracks them: a kind or op added to anchor-line.schema.json stops the tests compiling until the
/// public enum and the lists below gain it too.
private func mirror(_ kind: AnchorHistoryKind) -> SampledAnchorKind {
  switch kind {
  case .image: .image
  case .keyframe: .keyframe
  case .marked: .marked
  case .mesh: .mesh
  }
}

private func mirror(_ op: HistoryOp) -> AnchorChangeOp {
  switch op {
  case .add: .add
  case .remove: .remove
  case .update: .update
  }
}

private let generatedKinds: [AnchorHistoryKind] = [.image, .keyframe, .marked, .mesh]
private let generatedOps: [HistoryOp] = [.add, .remove, .update]

@Suite struct AnchorSamplerTests {
  @Test func rawValuesMatchTheGeneratedEnums() {
    // Public to generated: a public case the schema lacks fails to parse.
    for kind in SampledAnchorKind.allCases {
      #expect(AnchorHistoryKind(rawValue: kind.rawValue)?.rawValue == kind.rawValue)
    }
    for op in AnchorChangeOp.allCases {
      #expect(HistoryOp(rawValue: op.rawValue)?.rawValue == op.rawValue)
    }
    // Generated to public: every generated case has a public twin with the same raw value, and
    // together they cover the public cases one to one.
    for kind in generatedKinds {
      #expect(mirror(kind).rawValue == kind.rawValue)
    }
    for op in generatedOps {
      #expect(mirror(op).rawValue == op.rawValue)
    }
    #expect(Set(generatedKinds.map(mirror)) == Set(SampledAnchorKind.allCases))
    #expect(generatedKinds.count == SampledAnchorKind.allCases.count)
    #expect(Set(generatedOps.map(mirror)) == Set(AnchorChangeOp.allCases))
    #expect(generatedOps.count == AnchorChangeOp.allCases.count)
  }

  @Test func newAnchorsAreAdded() {
    var sampler = AnchorSampler()
    let keyframe = AnchorSnapshot(
      id: id("c"), kind: .keyframe, transform: .yaw(0.4, x: 3, y: 1.4, z: -12), frame: 420)
    let image = AnchorSnapshot(id: id("a"), kind: .image, transform: .yaw(1.2, x: 5, y: 2, z: -20))
    let mesh = AnchorSnapshot(id: id("b"), kind: .mesh, transform: .yaw(0, x: 0, z: -30))
    let changes = sampler.sample(t: 5, anchors: [keyframe, image, mesh])
    #expect(
      changes == [
        AnchorChange(
          t: 5, id: id("a"), kind: .image, op: .add, transform: image.transform, frame: nil),
        AnchorChange(
          t: 5, id: id("b"), kind: .mesh, op: .add, transform: mesh.transform, frame: nil),
        AnchorChange(
          t: 5, id: id("c"), kind: .keyframe, op: .add, transform: keyframe.transform, frame: 420),
      ])
    // Unchanged at the next sample: nothing to write.
    #expect(sampler.sample(t: 10, anchors: [mesh, image, keyframe]).isEmpty)
  }

  @Test func jitterBelowTheThresholdsIsIgnored() {
    var sampler = AnchorSampler()
    let base = AnchorSnapshot(id: id("1"), kind: .mesh, transform: .yaw(0.3, x: 8, y: -4, z: -45))
    _ = sampler.sample(t: 0, anchors: [base])
    // Back and forth by 0.4 mm and 0.02°: never 1 mm or 0.05° from the written one.
    for step in 1...20 {
      let sign = step % 2 == 0 ? 1.0 : -1.0
      let jittered = AnchorSnapshot(
        id: base.id, kind: .mesh,
        transform: .yaw(0.3 + sign * 0.02 * degree, x: 8 + sign * 0.0004, y: -4, z: -45))
      #expect(sampler.sample(t: Double(step) * 5, anchors: [jittered]).isEmpty)
    }
  }

  @Test func slowDriftIsCaughtOnceItAddsUp() {
    var sampler = AnchorSampler()
    // 0.3 mm per sample: never 1 mm between two samples, but 1.2 mm after four.
    func at(_ step: Int) -> AnchorSnapshot {
      AnchorSnapshot(
        id: id("2"), kind: .keyframe,
        transform: .yaw(0, x: 12.5 + 0.0003 * Double(step), z: -40), frame: 900)
    }
    var updates: [Int] = []
    for step in 0...8 {
      for change in sampler.sample(t: Double(step) * 5, anchors: [at(step)]) {
        #expect(change.frame == 900)
        if change.op == .update {
          updates.append(step)
          #expect(change.transform == at(step).transform)
        }
      }
    }
    // Measured from the last written transform: 0 to 4 (1.2 mm), then 4 to 8.
    #expect(updates == [4, 8])
  }

  @Test func rotationPastTheThresholdIsAnUpdate() {
    var sampler = AnchorSampler()
    // 0.02° per sample on the spot: 0.06° from the written one at the third.
    func at(_ step: Int) -> AnchorSnapshot {
      AnchorSnapshot(
        id: id("3"), kind: .marked,
        transform: .yaw(0.8 + 0.02 * Double(step) * degree, x: -6, z: -15))
    }
    var updates: [Int] = []
    for step in 0...6 {
      let changes = sampler.sample(t: Double(step) * 2, anchors: [at(step)])
      for change in changes where change.op == .update {
        updates.append(step)
      }
    }
    #expect(updates == [3, 6])
  }

  @Test func missingAnchorsAreRemoved() {
    var sampler = AnchorSampler()
    let keyframe = AnchorSnapshot(
      id: id("d"), kind: .keyframe, transform: .yaw(0, x: 1, z: -2), frame: 120)
    let mesh = AnchorSnapshot(id: id("e"), kind: .mesh, transform: .yaw(0, x: 4, z: -9))
    _ = sampler.sample(t: 0, anchors: [keyframe, mesh])
    #expect(
      sampler.sample(t: 5, anchors: [mesh]) == [
        AnchorChange(t: 5, id: id("d"), kind: .keyframe, op: .remove, transform: nil, frame: 120)
      ])
    #expect(sampler.sample(t: 10, anchors: [mesh]).isEmpty)
    // Back again: a new add.
    #expect(sampler.sample(t: 15, anchors: [mesh, keyframe]).map(\.op) == [.add])
    // Everything gone at stop.
    #expect(
      sampler.sample(t: 20, anchors: []) == [
        AnchorChange(t: 20, id: id("d"), kind: .keyframe, op: .remove, transform: nil, frame: 120),
        AnchorChange(t: 20, id: id("e"), kind: .mesh, op: .remove, transform: nil, frame: nil),
      ])
  }

  @Test func theFinalSampleWritesEveryNonMeshAnchorWithNoThreshold() {
    var sampler = AnchorSampler()
    let keyframe = AnchorSnapshot(
      id: id("b"), kind: .keyframe, transform: .yaw(0, x: 1, z: -2), frame: 120)
    let marked = AnchorSnapshot(id: id("c"), kind: .marked, transform: .yaw(0, x: 0, z: 0))
    let image = AnchorSnapshot(id: id("d"), kind: .image, transform: .yaw(0.5, x: 3, y: 1.6, z: -4))
    let mesh = AnchorSnapshot(id: id("a"), kind: .mesh, transform: .yaw(0, x: 4, z: -9))
    _ = sampler.sample(t: 0, anchors: [keyframe, marked, image, mesh])

    // 0.6 mm of drift: under the threshold, so an ordinary sample writes nothing...
    let drifted = AnchorSnapshot(
      id: id("b"), kind: .keyframe, transform: .yaw(0, x: 1.0006, z: -2), frame: 120)
    #expect(sampler.sample(t: 5, anchors: [drifted, marked, image, mesh]).isEmpty)

    // ...but the final sample writes it, with removals first and no mesh anchors.
    let added = AnchorSnapshot(id: id("e"), kind: .marked, transform: .yaw(0, x: 2, z: -30))
    let final = sampler.sampleFinal(t: 412.8, anchors: [mesh, added, drifted, marked])
    #expect(
      final == [
        AnchorChange(t: 412.8, id: id("d"), kind: .image, op: .remove, transform: nil, frame: nil),
        AnchorChange(
          t: 412.8, id: id("b"), kind: .keyframe, op: .update, transform: drifted.transform,
          frame: 120),
        AnchorChange(
          t: 412.8, id: id("c"), kind: .marked, op: .update, transform: marked.transform, frame: nil),
        AnchorChange(
          t: 412.8, id: id("e"), kind: .marked, op: .add, transform: added.transform, frame: nil),
      ])
  }

  @Test func changesAreSortedByLowercaseUUID() {
    var sampler = AnchorSampler()
    let ids = ["f0", "0a", "a0", "09", "ff", "10"].map(id)
    let anchors = ids.enumerated().map { index, anchorID in
      AnchorSnapshot(id: anchorID, kind: .mesh, transform: .yaw(0, x: Double(index), z: -30))
    }
    let added = sampler.sample(t: 0, anchors: anchors)
    #expect(lowercased(added.map(\.id)) == lowercased(ids).sorted())
    // Moves and removals in one sample, still in order.
    let moved = anchors.dropLast(2).reversed().map {
      AnchorSnapshot(
        id: $0.id, kind: .mesh, transform: .yaw(0, x: $0.transform.translation.x, z: -29))
    }
    let changes = sampler.sample(t: 5, anchors: moved)
    #expect(lowercased(changes.map(\.id)) == lowercased(ids).sorted())
    #expect(changes.filter { $0.op == .remove }.map(\.id) == [id("10"), id("ff")])
    #expect(changes.filter { $0.op == .update }.count == 4)
  }

  @Test func aRepeatedIdInOneSnapshotKeepsTheFirst() {
    var sampler = AnchorSampler()
    let first = AnchorSnapshot(id: id("7"), kind: .image, transform: .yaw(0, x: 2, z: -18))
    let copy = AnchorSnapshot(id: id("7"), kind: .image, transform: .yaw(0, x: 4, z: -18))
    #expect(
      sampler.sample(t: 0, anchors: [first, copy]) == [
        AnchorChange(
          t: 0, id: id("7"), kind: .image, op: .add, transform: first.transform, frame: nil)
      ])
    // The copy was ignored: the first is what was written.
    #expect(sampler.sample(t: 5, anchors: [first, copy]).isEmpty)
    #expect(sampler.sample(t: 10, anchors: [copy]).map(\.op) == [.update])
  }

  @Test func fineRotationIsAccurateAtSmallAndLargeAngles() {
    let a = WorldTransform.yaw(0.5, x: 3, z: -7)
    for degrees in [0.01, 0.03, 0.05, 0.07, 1, 45, 90, 179] {
      let b = WorldTransform.yaw(0.5 + degrees * degree, x: 3, z: -7)
      #expect(abs(a.fineRotationDegrees(to: b) - degrees) < max(1e-3, degrees * 1e-4))
    }
    #expect(a.fineRotationDegrees(to: a) < 1e-4)
  }
}
