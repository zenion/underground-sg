import Foundation

/// The mesh anchors one mesh-history snapshot writes to mesh/history.bin and history.jsonl, and
/// when. anchors.jsonl is sampled at the same moments.
public struct MeshSnapshotPlan: Equatable, Sendable {
  /// The snapshot's time, seconds since the ARKit session started.
  public var t: Double
  /// Anchors whose geometry or transform changed since the last snapshot (every anchor in the
  /// final one), sorted by lowercase UUID.
  public var updated: [UUID]
  /// Anchors removed since the last snapshot, sorted by lowercase UUID.
  public var removed: [UUID]
  /// The snapshot at stop, which holds every anchor with the session-end transforms.
  public var final: Bool

  public init(t: Double, updated: [UUID], removed: [UUID], final: Bool) {
    self.t = t
    self.updated = updated
    self.removed = removed
    self.final = final
  }
}

/// When the recorder snapshots the mesh, and which anchors each snapshot holds (ADR 0010: changed
/// mesh anchors every 5 s, 2 s in `dense`, and a final snapshot at stop). Writing every anchor
/// at every snapshot would cost tens of MB a minute more, so the module reports ARKit's mesh
/// anchor updates and removals here as they come, and a snapshot writes only those.
public struct MeshHistorySchedule: Sendable {
  /// Seconds between snapshots.
  public let intervalS: Double

  private var lastSnapshotT: Double?
  private var finished = false
  private var pendingUpdated: Set<UUID> = []
  private var pendingRemoved: Set<UUID> = []

  /// `intervalS` is 5, or 2 in `dense` (docs/session-recording.md, "Profiles").
  public init(intervalS: Double) {
    precondition(intervalS > 0)
    self.intervalS = intervalS
  }

  /// ARKit added or updated this mesh anchor. The next snapshot writes it, even if it was
  /// removed before: a removed anchor that comes back is written as it is now.
  public mutating func anchorUpdated(_ id: UUID) {
    pendingRemoved.remove(id)
    pendingUpdated.insert(id)
  }

  /// ARKit removed this mesh anchor. The next snapshot writes its removal, and not any update
  /// reported before it. The schedule doesn't track what earlier snapshots wrote, so this may
  /// name an anchor no snapshot ever wrote; the writer, which knows, skips those.
  public mutating func anchorRemoved(_ id: UUID) {
    pendingUpdated.remove(id)
    pendingRemoved.insert(id)
  }

  /// Whether a snapshot is due at `t`: at the first call after start, then `intervalS` after the
  /// last snapshot. Never after the final snapshot, which ends the history.
  public func isDue(at t: Double) -> Bool {
    if finished { return false }
    guard let last = lastSnapshotT else { return true }
    // A small tolerance, as in CandidateGate: frame times are multiples of the frame interval in
    // floating point, and 300 frames at 60 Hz must count as 5 s.
    return t - last >= intervalS - 1e-6
  }

  /// Takes the snapshot at `t`: the anchors changed and removed since the last one. The next
  /// snapshot is due `intervalS` after `t`.
  public mutating func take(at t: Double) -> MeshSnapshotPlan {
    let plan = MeshSnapshotPlan(
      t: t, updated: pendingUpdated.sorted(by: recordingOrder),
      removed: pendingRemoved.sorted(by: recordingOrder), final: false)
    commit(at: t)
    return plan
  }

  /// Takes the snapshot at stop: every anchor in `all`, with the session-end transforms, so a
  /// replay has the final mesh whatever changed when, plus the removals since the last snapshot.
  /// An anchor listed in `all` is never also removed. Nothing is due after it.
  public mutating func takeFinal(at t: Double, all: [UUID]) -> MeshSnapshotPlan {
    let every = Set(all)
    let plan = MeshSnapshotPlan(
      t: t, updated: every.sorted(by: recordingOrder),
      removed: pendingRemoved.subtracting(every).sorted(by: recordingOrder), final: true)
    commit(at: t)
    finished = true
    return plan
  }

  private mutating func commit(at t: Double) {
    pendingUpdated = []
    pendingRemoved = []
    lastSnapshotT = t
  }
}
