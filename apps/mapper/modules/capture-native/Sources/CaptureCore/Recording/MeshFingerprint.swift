import Foundation

/// A fingerprint of a packed mesh (design D6), to tell whether an anchor ARKit reported as
/// updated changed its geometry or only moved, which anchors.jsonl already records. FNV-1a 64
/// over the packed bytes, then the vertex and face counts, so two layouts of the same bytes
/// differ. Not a security hash: a collision costs one block that isn't rewritten.
public enum MeshFingerprint {
  public static func of(_ mesh: PackedMesh) -> UInt64 {
    var hash = fnv1a(mesh.data)
    hash = fnv1a(littleEndianBytes(UInt64(mesh.vertices)), from: hash)
    return fnv1a(littleEndianBytes(UInt64(mesh.faces)), from: hash)
  }

  static let offsetBasis: UInt64 = 0xcbf2_9ce4_8422_2325
  static let prime: UInt64 = 0x0000_0100_0000_01b3

  /// FNV-1a 64 of `bytes`, continuing from `hash`.
  static func fnv1a<Bytes: Sequence<UInt8>>(_ bytes: Bytes, from hash: UInt64 = offsetBasis)
    -> UInt64
  {
    var hash = hash
    for byte in bytes {
      hash ^= UInt64(byte)
      hash &*= prime
    }
    return hash
  }

  private static func littleEndianBytes(_ value: UInt64) -> [UInt8] {
    (0..<8).map { UInt8(truncatingIfNeeded: value >> (8 * $0)) }
  }
}
