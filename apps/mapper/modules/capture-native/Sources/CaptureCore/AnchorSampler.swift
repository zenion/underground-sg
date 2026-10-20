import Foundation

/// The kinds of anchor the recorder samples into anchors.jsonl (docs/session-recording.md).
/// Raw values are the file's `kind` values.
public enum SampledAnchorKind: String, CaseIterable, Sendable {
  /// The ARAnchor placed at a keyframe, to see whether ARKit refines it (ADR 0010, "Keyframe-anchor
  /// refinement").
  case keyframe
  /// An image anchor ARKit detected.
  case image
  /// A scene-reconstruction mesh anchor.
  case mesh
  /// An anchor `markAnchor` placed.
  case marked
}

/// What happened to an anchor since its last line in anchors.jsonl. Raw values are the file's
/// `op` values.
public enum AnchorChangeOp: String, CaseIterable, Sendable {
  case add
  /// It moved more than the sampler's thresholds since its last line.
  case update
  case remove
}

/// One anchor as the module read it from the session at a sample.
public struct AnchorSnapshot: Equatable, Sendable {
  /// ARKit's anchor identifier.
  public var id: UUID
  public var kind: SampledAnchorKind
  /// Anchor to world.
  public var transform: WorldTransform
  /// The keyframe's session frame for a keyframe anchor, else nil.
  public var frame: Int?

  /// A keyframe anchor must carry its frame and no other kind may: anchors.jsonl ties the two
  /// together, so a mismatch is a bug in the caller.
  public init(id: UUID, kind: SampledAnchorKind, transform: WorldTransform, frame: Int? = nil) {
    precondition((kind == .keyframe) == (frame != nil), "only a keyframe anchor has a frame")
    self.id = id
    self.kind = kind
    self.transform = transform
    self.frame = frame
  }
}

/// One line of anchors.jsonl: an anchor added, moved or removed, as of the sample at `t`.
public struct AnchorChange: Equatable, Sendable {
  /// The sample's time, seconds since the ARKit session started.
  public var t: Double
  public var id: UUID
  public var kind: SampledAnchorKind
  public var op: AnchorChangeOp
  /// Anchor to world, or nil for a remove.
  public var transform: WorldTransform?
  /// The keyframe's frame for a keyframe anchor (on its remove too), else nil.
  public var frame: Int?

  /// The file's rules hold by construction: `transform` is nil exactly for a remove, and `frame`
  /// is set exactly for a keyframe anchor.
  public init(
    t: Double, id: UUID, kind: SampledAnchorKind, op: AnchorChangeOp, transform: WorldTransform?,
    frame: Int?
  ) {
    precondition((op == .remove) == (transform == nil), "only a remove has no transform")
    precondition((kind == .keyframe) == (frame != nil), "only a keyframe anchor has a frame")
    self.t = t
    self.id = id
    self.kind = kind
    self.op = op
    self.transform = transform
    self.frame = frame
  }
}

/// Turns the anchors the module samples with each mesh snapshot, and at stop, into the lines of
/// anchors.jsonl (ADR 0010): adds, removals, and anchors that moved more than about 1 mm or
/// 0.05°. ARKit may never send update callbacks for refined anchors, so the recorder reads every
/// anchor's transform on its own schedule and this keeps only what changed.
public struct AnchorSampler: Sendable {
  /// Metres an anchor must move, since its last line, to get an update.
  public let minTranslationM: Double
  /// Degrees an anchor must turn, since its last line, to get an update.
  public let minRotationDeg: Double

  /// What was last written for each anchor still in the session.
  private var written: [UUID: AnchorSnapshot] = [:]

  public init(minTranslationM: Double = 0.001, minRotationDeg: Double = 0.05) {
    precondition(minTranslationM >= 0 && minRotationDeg >= 0)
    self.minTranslationM = minTranslationM
    self.minRotationDeg = minRotationDeg
  }

  /// Compares the session's anchors at `t` with what was last written and returns the lines to
  /// append, sorted by lowercase UUID so the same input always writes the same file.
  ///
  /// An update is judged against the anchor's last written transform, not the previous sample,
  /// so drift too slow to cross a threshold between two samples still gets a line once it adds
  /// up. An anchor seen before and missing now is removed. If an id appears twice in one
  /// snapshot, the first one counts and the rest are ignored: ARKit's identifiers are unique, so
  /// a repeat is a copy made by the caller, and keeping the first is deterministic.
  public mutating func sample(t: Double, anchors: [AnchorSnapshot]) -> [AnchorChange] {
    var current: [UUID: AnchorSnapshot] = [:]
    for anchor in anchors where current[anchor.id] == nil {
      current[anchor.id] = anchor
    }

    var changes: [AnchorChange] = []
    for (id, anchor) in current {
      if let last = written[id] {
        guard moved(from: last.transform, to: anchor.transform) else { continue }
        changes.append(
          AnchorChange(
            t: t, id: id, kind: anchor.kind, op: .update, transform: anchor.transform,
            frame: anchor.frame))
      } else {
        changes.append(
          AnchorChange(
            t: t, id: id, kind: anchor.kind, op: .add, transform: anchor.transform,
            frame: anchor.frame))
      }
      written[id] = anchor
    }
    for (id, last) in written where current[id] == nil {
      changes.append(
        AnchorChange(t: t, id: id, kind: last.kind, op: .remove, transform: nil, frame: last.frame))
      written[id] = nil
    }
    return changes.sorted { recordingOrder($0.id, $1.id) }
  }

  /// The final sample, when the recording closes with End the session here or idle
  /// (docs/session-recording.md, "The final sample"): first a remove for each keyframe, image or
  /// marked anchor gone since the last sample, then every keyframe, image and marked anchor that
  /// exists, with no movement threshold (`update` for one already written, `add` for a new one).
  /// Each group is sorted as `sample` sorts. Mesh anchors are left out: their final transforms
  /// and geometry go in the mesh history's final snapshot. The caller writes these lines with
  /// `final: true` and the open segment's `capture_id`.
  public mutating func sampleFinal(t: Double, anchors: [AnchorSnapshot]) -> [AnchorChange] {
    var current: [UUID: AnchorSnapshot] = [:]
    for anchor in anchors where anchor.kind != .mesh && current[anchor.id] == nil {
      current[anchor.id] = anchor
    }

    var removes: [AnchorChange] = []
    for (id, last) in written where last.kind != .mesh && current[id] == nil {
      removes.append(
        AnchorChange(t: t, id: id, kind: last.kind, op: .remove, transform: nil, frame: last.frame))
      written[id] = nil
    }
    var present: [AnchorChange] = []
    for (id, anchor) in current {
      present.append(
        AnchorChange(
          t: t, id: id, kind: anchor.kind, op: written[id] == nil ? .add : .update,
          transform: anchor.transform, frame: anchor.frame))
      written[id] = anchor
    }
    return removes.sorted { recordingOrder($0.id, $1.id) }
      + present.sorted { recordingOrder($0.id, $1.id) }
  }

  private func moved(from a: WorldTransform, to b: WorldTransform) -> Bool {
    a.distance(to: b) > minTranslationM || a.fineRotationDegrees(to: b) > minRotationDeg
  }
}

/// The order of ids in every file the recorder writes: by lowercase uuidString, as the files
/// spell them.
func recordingOrder(_ a: UUID, _ b: UUID) -> Bool {
  a.uuidString.lowercased() < b.uuidString.lowercased()
}

extension WorldTransform {
  /// The angle between the two orientations, in degrees, accurate for the hundredths of a degree
  /// anchors.jsonl's threshold needs. `rotationDegrees(to:)` takes acos of the trace, which loses
  /// most of its precision near 0° with float32 matrices; this uses atan2 of the sine (from the
  /// antisymmetric part of Rᵀ R') and the cosine (from its trace).
  func fineRotationDegrees(to other: WorldTransform) -> Double {
    // r[i][j] of Rᵀ R' is the dot product of column i of R and column j of R'.
    func r(_ i: Int, _ j: Int) -> Double {
      var sum = 0.0
      for k in 0..<3 { sum += Double(m[i * 4 + k]) * Double(other.m[j * 4 + k]) }
      return sum
    }
    let trace = r(0, 0) + r(1, 1) + r(2, 2)
    let x = r(2, 1) - r(1, 2)
    let y = r(0, 2) - r(2, 0)
    let z = r(1, 0) - r(0, 1)
    let sine = (x * x + y * y + z * z).squareRoot() / 2
    let cosine = (trace - 1) / 2
    return atan2(sine, cosine) * 180 / Double.pi
  }
}
