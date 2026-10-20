#if USG_RECORDER
import Foundation

// What RecorderCore asks of the code that writes (design 3.1): typed commands, applied in order
// by FileSink on the I/O queue or by MemorySink in tests. RecorderCore decides what is written
// and when; a sink only writes it, so the two sinks can be checked against each other.

/// Which mesh geometry RecorderCore wants copied out of the frame it is handling.
public enum GeometryRequest: Equatable, Sendable {
  case none
  /// These anchors' geometry, where they still exist.
  case anchors([UUID])
  /// Every mesh anchor's: the baseline at open.
  case everyMeshAnchor
}

/// One mesh anchor's geometry, copied inside the delegate callback (design D5).
public struct MeshGeometry: Sendable {
  /// x, y, z for each vertex, in the anchor's frame.
  public var vertices: [Float]
  public var faces: MeshIndices
  /// One ARMeshClassification a face, or nil without classification.
  public var classes: [UInt8]?

  public init(vertices: [Float], faces: MeshIndices, classes: [UInt8]?) {
    self.vertices = vertices
    self.faces = faces
    self.classes = classes
  }
}

/// The session's anchors as one frame shows them.
public struct AnchorReading: Sendable {
  /// Every anchor of a kind anchors.jsonl samples, mesh anchors included.
  public var anchors: [AnchorSnapshot]
  /// The geometry asked for, by anchor.
  public var geometry: [UUID: MeshGeometry]

  public init(anchors: [AnchorSnapshot], geometry: [UUID: MeshGeometry] = [:]) {
    self.anchors = anchors
    self.geometry = geometry
  }
}

/// An anchor's geometry for the mesh queue.
public struct MeshCopy: Sendable {
  public let id: UUID
  public let transform: WorldTransform
  public let geometry: MeshGeometry
}

/// An anchor whose last block the final snapshot reuses, with its transform at the end.
public struct MeshReuse: Equatable, Sendable {
  public let id: UUID
  public let transform: WorldTransform
}

/// One mesh-history snapshot for the mesh queue (design section 8).
public struct MeshJob: Sendable {
  public let t: Double
  public let final: Bool
  /// Sorted by id.
  public let copies: [MeshCopy]
  /// Final snapshot only: anchors with no update since their last block. Sorted by id.
  public let reuse: [MeshReuse]
  /// Sorted by id.
  public let removed: [UUID]
}

/// How a recording is to be finished (design 7.5).
public struct CloseOrder: Sendable {
  public let window: WindowClose
  /// Lines appended after every writer is cut back to `window.endT`: the final sample's
  /// anchors.jsonl lines and the `recording_closed` event, all at `endT`.
  public let closingLines: [PendingLine]
  /// The mesh snapshots' times inside the window, for `mesh_interval_s`.
  public let meshSnapshotTs: [Double]
  /// A foreground close waits up to 1 s for TypeScript's final boundary flush; a background
  /// close doesn't.
  public let awaitBoundary: Bool
  /// A stop cut back on disk: truncate to the cut checkpoint rather than finish at the end of
  /// the files (design 7.4).
  public let useCut: Bool
}

public enum SinkCommand: Sendable {
  /// The recording opens: journal `open` (full sync), `rec-<id>/`, recording.json, the ballast.
  case createRecording(id: UUID, journalOpen: JournalRecord, manifest: Data)
  case lines([PendingLine])
  case mesh(MeshJob)
  /// A journal record, full-synced.
  case journal(JournalRecord)
  /// An end anchor's margin ends at `cutT`: each writer remembers where its lines pass it.
  case registerCut(cutT: Double)
  case finalize(CloseOrder)
  /// TypeScript's final boundary flush has arrived, so a waiting finalize can complete.
  case boundaryFlushed
  /// End the session here: the glue pauses the ARSession on main.
  case stopSession
  /// Delete the directory and the journal.
  case deleteRecording(id: UUID)
}

/// Where a mesh block's bytes come from.
public enum MeshBlockSource: Equatable, Sendable {
  /// Newly compressed.
  case bytes(Data)
  /// A copy of the block already at `offset` in history.bin, read back (design D6).
  case copy(offset: Int64, bytes: Int)
}

/// A line for mesh/history.jsonl and, for an add or update, its block, which is appended to
/// history.bin before the line.
public struct MeshOutput: Sendable {
  public let block: MeshBlockSource?
  public let line: PendingLine
}

public struct MeshJobCounts: Equatable, Sendable {
  public var written = 0
  public var reused = 0
  /// Reported updated but with the same geometry: only moved.
  public var unchanged = 0
  /// Geometry that couldn't be packed or compressed (too large, malformed).
  public var skipped = 0
  /// Final-snapshot anchors with no block to reuse.
  public var missing = 0

  public init() {}
}

/// The mesh queue's work (design section 8): pack, fingerprint, decide with the ledger,
/// compress, and turn each anchor into its block and line. The ledger places every block, so
/// the outputs must be written in order.
public struct MeshJobRunner: Sendable {
  public private(set) var ledger = MeshLedger()
  public private(set) var counts = MeshJobCounts()

  public init() {}

  /// The outputs of one job: removals first, then the anchors in id order.
  public mutating func run(_ job: MeshJob, deflate: (Data) throws -> Data) -> [MeshOutput] {
    var out: [MeshOutput] = []
    for id in job.removed {
      if let line = ledger.removeLine(anchor: id, t: job.t, final: job.final, captureID: nil) {
        out.append(MeshOutput(block: nil, line: line))
      }
    }
    enum Item {
      case copy(MeshCopy)
      case reuse(MeshReuse)
      var id: UUID {
        switch self {
        case .copy(let copy): copy.id
        case .reuse(let reuse): reuse.id
        }
      }
    }
    let items = (job.copies.map(Item.copy) + job.reuse.map(Item.reuse))
      .sorted { recordingOrder($0.id, $1.id) }
    for item in items {
      switch item {
      case .copy(let copy):
        if let output = write(copy, t: job.t, final: job.final, deflate: deflate) {
          out.append(output)
        }
      case .reuse(let reuse):
        guard case .reuse(let from, let to)? = ledger.reuseLast(anchor: reuse.id) else {
          counts.missing += 1
          continue
        }
        counts.reused += 1
        out.append(
          output(from: from, to: to, id: reuse.id, transform: reuse.transform, t: job.t))
      }
    }
    return out
  }

  private mutating func write(
    _ copy: MeshCopy, t: Double, final: Bool, deflate: (Data) throws -> Data
  ) -> MeshOutput? {
    guard
      let packed = try? MeshBlockLayout.pack(
        vertices: copy.geometry.vertices, faces: copy.geometry.faces,
        classes: copy.geometry.classes)
    else {
      counts.skipped += 1
      return nil
    }
    let fingerprint = MeshFingerprint.of(packed)
    switch ledger.decide(anchor: copy.id, fingerprint: fingerprint, final: final) {
    case .skipUnchanged:
      counts.unchanged += 1
      return nil
    case .reuse(let from, let to):
      counts.reused += 1
      return output(from: from, to: to, id: copy.id, transform: copy.transform, t: t)
    case .writeNew(let op):
      guard let compressed = try? deflate(packed.data), !compressed.isEmpty else {
        counts.skipped += 1
        return nil
      }
      let block = ledger.placeNew(
        anchor: copy.id, fingerprint: fingerprint, bytes: compressed.count,
        vertices: packed.vertices, faces: packed.faces)
      counts.written += 1
      let line = PendingLine.meshBlock(
        t: t, anchor: copy.id, op: op, transform: copy.transform, vertices: packed.vertices,
        faces: packed.faces, final: final, captureID: nil
      ).placed(offset: block.offset, bytes: block.bytes)
      return MeshOutput(block: .bytes(compressed), line: line)
    }
  }

  private func output(
    from: MeshBlockRef, to: MeshBlockRef, id: UUID, transform: WorldTransform, t: Double
  ) -> MeshOutput {
    // Reuse happens only in the final snapshot, of an anchor already written.
    let line = PendingLine.meshBlock(
      t: t, anchor: id, op: .update, transform: transform, vertices: to.vertices,
      faces: to.faces, final: true, captureID: nil
    ).placed(offset: to.offset, bytes: to.bytes)
    return MeshOutput(block: .copy(offset: from.offset, bytes: from.bytes), line: line)
  }
}
#endif
