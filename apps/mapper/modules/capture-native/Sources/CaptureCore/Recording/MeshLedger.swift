#if USG_RECORDER
import Foundation

/// Where a block is in mesh/history.bin, and what it holds.
public struct MeshBlockRef: Equatable, Sendable {
  public let offset: Int64
  /// The compressed length.
  public let bytes: Int
  public let vertices: Int
  public let faces: Int
}

/// What a mesh snapshot does with one anchor's geometry.
public enum MeshLedgerDecision: Equatable, Sendable {
  /// Deflate the packed mesh, then `placeNew` it. `op` is `add` for the anchor's first block,
  /// else `update`.
  case writeNew(op: AnchorChangeOp)
  /// Append a copy of the block at `from` (read back from history.bin, not recompressed); its
  /// index line points at `to`, where the copy goes. Only in a final snapshot.
  case reuse(from: MeshBlockRef, to: MeshBlockRef)
  /// The geometry is the block already written: ARKit reported the anchor updated, but it only
  /// moved, which anchors.jsonl records. No line.
  case skipUnchanged
}

/// The mesh history's memory of what it wrote (design D6 and section 8), on the mesh queue: the
/// last block of each anchor and its fingerprint, and the length of history.bin.
///
/// The ledger places every block: a block's offset is history.bin's length when it is placed,
/// so blocks must reach the file in the order they are placed, and each placed block must be
/// written. A block too large to pack is skipped before it is decided, so it is never placed.
public struct MeshLedger: Sendable {
  /// history.bin's length once every placed block is written.
  public private(set) var binBytes: Int64 = 0
  private var written: [UUID: (fingerprint: UInt64, block: MeshBlockRef)] = [:]

  public init() {}

  /// The decision for an anchor whose geometry was copied and packed. In a regular snapshot an
  /// unchanged geometry is skipped. In the final snapshot, which holds every anchor, it reuses
  /// the anchor's last block, and the copy is placed here.
  public mutating func decide(anchor: UUID, fingerprint: UInt64, final: Bool)
    -> MeshLedgerDecision
  {
    guard let last = written[anchor] else { return .writeNew(op: .add) }
    guard last.fingerprint == fingerprint else { return .writeNew(op: .update) }
    return final ? reuse(last) : .skipUnchanged
  }

  /// The final snapshot's decision for an anchor ARKit hasn't reported updated since its last
  /// block: a copy of that block, placed here. Nil for an anchor never written, whose geometry
  /// the caller must copy and `decide` instead.
  public mutating func reuseLast(anchor: UUID) -> MeshLedgerDecision? {
    guard let last = written[anchor] else { return nil }
    return reuse(last)
  }

  /// Places a new block of `bytes` compressed bytes, after `decide` said `writeNew`, and
  /// remembers it as the anchor's last.
  public mutating func placeNew(
    anchor: UUID, fingerprint: UInt64, bytes: Int, vertices: Int, faces: Int
  ) -> MeshBlockRef {
    precondition(bytes > 0, "a raw DEFLATE stream is never empty")
    let block = MeshBlockRef(offset: binBytes, bytes: bytes, vertices: vertices, faces: faces)
    binBytes += Int64(bytes)
    written[anchor] = (fingerprint, block)
    return block
  }

  /// The remove line for an anchor ARKit removed, or nil when no block of it was ever written
  /// (an anchor's first line is always an add). It is forgotten, so if it comes back, its next
  /// block is an add.
  public mutating func removeLine(anchor: UUID, t: Double, final: Bool, captureID: UUID?)
    -> PendingLine?
  {
    guard written.removeValue(forKey: anchor) != nil else { return nil }
    return .meshRemove(t: t, anchor: anchor, final: final, captureID: captureID)
  }

  /// Whether any block of this anchor was written.
  public func hasWritten(_ anchor: UUID) -> Bool { written[anchor] != nil }

  private mutating func reuse(_ last: (fingerprint: UInt64, block: MeshBlockRef))
    -> MeshLedgerDecision
  {
    let copy = MeshBlockRef(
      offset: binBytes, bytes: last.block.bytes, vertices: last.block.vertices,
      faces: last.block.faces)
    binBytes += Int64(last.block.bytes)
    // The copy holds the same bytes, so the anchor's last block may stay the original.
    return .reuse(from: last.block, to: copy)
  }
}
#endif
