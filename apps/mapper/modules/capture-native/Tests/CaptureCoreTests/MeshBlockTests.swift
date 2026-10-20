import Foundation
import Testing

@testable import CaptureCore

/// Two vertices and one (degenerate) face: small enough to spell out byte by byte.
private let vertices: [Float] = [1, 2, 3, 4, 5, 6]

@Suite struct MeshBlockLayoutTests {
  @Test func writesVerticesThenIndicesThenClassesLittleEndian() throws {
    let mesh = try MeshBlockLayout.pack(vertices: vertices, faces: .uint32([0, 1, 1]), classes: [7])
    #expect(mesh.vertices == 2)
    #expect(mesh.faces == 1)
    #expect(mesh.data.count == 12 * 2 + 13 * 1)
    #expect(
      Array(mesh.data) == [
        0x00, 0x00, 0x80, 0x3F, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x40, 0x40,
        0x00, 0x00, 0x80, 0x40, 0x00, 0x00, 0xA0, 0x40, 0x00, 0x00, 0xC0, 0x40,
        0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
        0x07,
      ])
  }

  @Test func widensSixteenBitIndices() throws {
    let wide = try MeshBlockLayout.pack(
      vertices: vertices, faces: .uint32([1, 0, 1]), classes: [3])
    let narrow = try MeshBlockLayout.pack(
      vertices: vertices, faces: .uint16([1, 0, 1]), classes: [3])
    #expect(wide == narrow)
  }

  @Test func writesNoneWithoutAClassification() throws {
    let mesh = try MeshBlockLayout.pack(
      vertices: vertices, faces: .uint32([0, 1, 1, 1, 0, 0]), classes: nil)
    #expect(mesh.data.count == 24 + 26)
    #expect(mesh.data.suffix(2) == Data([0, 0]))
  }

  @Test func anEmptyMeshIsAnEmptyBlock() throws {
    let mesh = try MeshBlockLayout.pack(vertices: [], faces: .uint16([]), classes: [])
    #expect(mesh.data.isEmpty)
    #expect(mesh.vertices == 0 && mesh.faces == 0)
  }

  @Test func refusesGeometryThatDoesntAddUp() {
    #expect(throws: MeshBlockError.vertexCount) {
      try MeshBlockLayout.pack(vertices: [1, 2], faces: .uint32([]), classes: nil)
    }
    #expect(throws: MeshBlockError.indexCount) {
      try MeshBlockLayout.pack(vertices: vertices, faces: .uint32([0, 1]), classes: nil)
    }
    #expect(throws: MeshBlockError.indexOutOfRange) {
      try MeshBlockLayout.pack(vertices: vertices, faces: .uint32([0, 1, 2]), classes: nil)
    }
    #expect(throws: MeshBlockError.indexOutOfRange) {
      try MeshBlockLayout.pack(vertices: vertices, faces: .uint16([0, 1, 9]), classes: nil)
    }
    #expect(throws: MeshBlockError.classCount) {
      try MeshBlockLayout.pack(vertices: vertices, faces: .uint32([0, 1, 1]), classes: [1, 2])
    }
  }

  @Test func refusesABlockOverTheLimit() throws {
    #expect(MeshBlockLayout.maxBlockBytes == 64 * 1024 * 1024)
    // 37 bytes inflated.
    _ = try MeshBlockLayout.pack(
      vertices: vertices, faces: .uint32([0, 1, 1]), classes: nil, limit: 37)
    #expect(throws: MeshBlockError.tooLarge) {
      try MeshBlockLayout.pack(
        vertices: vertices, faces: .uint32([0, 1, 1]), classes: nil, limit: 36)
    }
  }
}

@Suite struct MeshFingerprintTests {
  @Test func isFnv1a64() {
    // The reference vectors of the FNV specification.
    #expect(MeshFingerprint.fnv1a([UInt8]()) == 0xcbf2_9ce4_8422_2325)
    #expect(MeshFingerprint.fnv1a(Array("a".utf8)) == 0xaf63_dc4c_8601_ec8c)
    #expect(MeshFingerprint.fnv1a(Array("foobar".utf8)) == 0x8594_4171_f739_67e8)
  }

  @Test func changesWithAnyByteOrCount() throws {
    let mesh = try MeshBlockLayout.pack(vertices: vertices, faces: .uint32([0, 1, 1]), classes: [7])
    let same = try MeshBlockLayout.pack(vertices: vertices, faces: .uint16([0, 1, 1]), classes: [7])
    #expect(MeshFingerprint.of(mesh) == MeshFingerprint.of(same))
    let reclassified = try MeshBlockLayout.pack(
      vertices: vertices, faces: .uint32([0, 1, 1]), classes: [8])
    #expect(MeshFingerprint.of(mesh) != MeshFingerprint.of(reclassified))
    let counted = PackedMesh(data: mesh.data, vertices: 1, faces: 2)
    #expect(MeshFingerprint.of(mesh) != MeshFingerprint.of(counted))
  }
}
