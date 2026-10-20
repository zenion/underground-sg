import Foundation

/// The triangle indices of a mesh anchor's geometry, as ARKit stores them: 32-bit, or 16-bit for
/// small meshes.
public enum MeshIndices: Sendable {
  case uint32([UInt32])
  case uint16([UInt16])

  var count: Int {
    switch self {
    case .uint32(let indices): indices.count
    case .uint16(let indices): indices.count
    }
  }
}

/// One anchor's geometry in the mesh history's block layout, before compression.
public struct PackedMesh: Equatable, Sendable {
  /// The inflated block: 12 bytes a vertex, then 13 a face.
  public let data: Data
  public let vertices: Int
  public let faces: Int
}

/// Why a mesh anchor's geometry can't be packed. No case carries a value from the mesh.
public enum MeshBlockError: Error, Equatable, Sendable {
  /// The vertex floats aren't whole x, y, z triples.
  case vertexCount
  /// The indices aren't whole triangles.
  case indexCount
  /// An index names a vertex the mesh doesn't have.
  case indexOutOfRange
  /// Classifications given, but not one per face.
  case classCount
  /// The inflated block would pass `maxMeshBlockBytes`; the snapshot skips the anchor.
  case tooLarge
}

/// The inflated layout of a mesh-history block (docs/session-recording.md, "Encodings"): the
/// anchor's float32 vertices (x, y, z in the anchor's frame), then uint32 triangle indices (3 a
/// face), then one uint8 `ARMeshClassification` a face, all little-endian. So a block of v
/// vertices and f faces inflates to 12v + 13f bytes, which validate-recording checks.
///
/// Not gated by USG_RECORDER: the bundle's `mesh/scene.ply` writer reads the same geometry.
public enum MeshBlockLayout {
  /// `DEFAULT_RECORDING_LIMITS.maxMeshBlockBytes`.
  public static let maxBlockBytes = 64 * 1024 * 1024

  /// Packs one anchor's geometry. `vertices` holds x, y, z for each vertex; 16-bit indices are
  /// widened to 32 bits; `classes` nil (no classification) writes 0, `none`, for every face.
  /// A block over `limit` bytes inflated is refused before anything is allocated.
  public static func pack(
    vertices: [Float], faces: MeshIndices, classes: [UInt8]?, limit: Int = maxBlockBytes
  ) throws -> PackedMesh {
    guard vertices.count % 3 == 0 else { throw MeshBlockError.vertexCount }
    guard faces.count % 3 == 0 else { throw MeshBlockError.indexCount }
    let vertexCount = vertices.count / 3
    let faceCount = faces.count / 3
    if let classes, classes.count != faceCount { throw MeshBlockError.classCount }
    let size = 12 * vertexCount + 13 * faceCount
    guard size <= limit else { throw MeshBlockError.tooLarge }

    var bytes = [UInt8](repeating: 0, count: size)
    try bytes.withUnsafeMutableBytes { buffer in
      var offset = 0
      for value in vertices {
        buffer.storeBytes(of: value.bitPattern.littleEndian, toByteOffset: offset, as: UInt32.self)
        offset += 4
      }
      func store(_ index: UInt32) throws {
        guard Int(index) < vertexCount else { throw MeshBlockError.indexOutOfRange }
        buffer.storeBytes(of: index.littleEndian, toByteOffset: offset, as: UInt32.self)
        offset += 4
      }
      switch faces {
      case .uint32(let indices): for index in indices { try store(index) }
      case .uint16(let indices): for index in indices { try store(UInt32(index)) }
      }
      if let classes {
        for value in classes {
          buffer[offset] = value
          offset += 1
        }
      }
      // Without classes the last f bytes stay 0.
    }
    return PackedMesh(data: Data(bytes), vertices: vertexCount, faces: faceCount)
  }
}
