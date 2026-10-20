#if USG_RECORDER
  import ARKit
  import CaptureCore
  import Foundation
  import Metal

  /// Copies mesh anchors' geometry out of ARKit's Metal buffers for the mesh history (the lean
  /// recorder design, D5 and section 8). Called only inside an ARSession delegate callback on
  /// `Queues.capture`, while the frame that holds the anchor is alive: ARKit doesn't document
  /// that a buffer stays unchanged after the callback returns, so nothing here is kept or read
  /// later. Each copy is a memcpy from `MTLBuffer.contents()`, which the encoder check allows:
  /// these are vertices, indices and classes, never pixels.
  ///
  /// Every read is checked against the buffer's length first, with the source's `offset`,
  /// `stride` and `format` and the element's `bytesPerIndex` honoured, so a layout this code
  /// doesn't expect gives no geometry (the snapshot then skips the anchor) rather than a read
  /// past the buffer. Logs nothing: geometry is pose-bearing.
  enum MeshCopier {
    /// The anchor's vertices, triangle indices and per-face classes, or nil when the vertices or
    /// faces aren't in a layout the history writes (float3 vertices, triangles of 16- or 32-bit
    /// indices). Classes that aren't one `uchar` a face are left out (written as 0, `none`).
    static func copy(_ geometry: ARMeshGeometry) -> MeshGeometry? {
      guard let vertices = copyVertices(geometry.vertices),
        let faces = copyFaces(geometry.faces)
      else { return nil }
      let classes = copyClasses(geometry.classification, faceCount: geometry.faces.count)
      return MeshGeometry(vertices: vertices, faces: faces, classes: classes)
    }

    /// x, y, z for each vertex: `count` float3 values, `stride` bytes apart from `offset`.
    private static func copyVertices(_ source: ARGeometrySource) -> [Float]? {
      let count = source.count
      let stride = source.stride
      let offset = source.offset
      let vertexBytes = 3 * MemoryLayout<Float>.size
      guard source.format == .float3, source.componentsPerVector == 3, count >= 0,
        stride >= vertexBytes, offset >= 0,
        fits(offset: offset, count: count, stride: stride, size: vertexBytes,
          length: source.buffer.length)
      else { return nil }
      guard count > 0 else { return [] }
      let base = UnsafeRawPointer(source.buffer.contents()).advanced(by: offset)
      var out = [Float](repeating: 0, count: count * 3)
      out.withUnsafeMutableBytes { destination in
        guard let target = destination.baseAddress else { return }
        if stride == vertexBytes {
          target.copyMemory(from: base, byteCount: count * vertexBytes)
        } else {
          for index in 0..<count {
            target.advanced(by: index * vertexBytes).copyMemory(
              from: base.advanced(by: index * stride), byteCount: vertexBytes)
          }
        }
      }
      return out
    }

    /// Three indices a face, packed from the start of the buffer, 4 or 2 bytes each.
    private static func copyFaces(_ element: ARGeometryElement) -> MeshIndices? {
      let faces = element.count
      let bytesPerIndex = element.bytesPerIndex
      guard element.primitiveType == .triangle, element.indexCountPerPrimitive == 3, faces >= 0,
        bytesPerIndex == 4 || bytesPerIndex == 2
      else { return nil }
      let (indexCount, overflowA) = faces.multipliedReportingOverflow(by: 3)
      guard !overflowA else { return nil }
      let (byteCount, overflowB) = indexCount.multipliedReportingOverflow(by: bytesPerIndex)
      guard !overflowB, byteCount <= element.buffer.length else { return nil }
      let base = UnsafeRawPointer(element.buffer.contents())
      if bytesPerIndex == 4 {
        var out = [UInt32](repeating: 0, count: indexCount)
        if byteCount > 0 {
          out.withUnsafeMutableBytes { destination in
            if let target = destination.baseAddress {
              target.copyMemory(from: base, byteCount: byteCount)
            }
          }
        }
        return .uint32(out)
      }
      var out = [UInt16](repeating: 0, count: indexCount)
      if byteCount > 0 {
        out.withUnsafeMutableBytes { destination in
          if let target = destination.baseAddress {
            target.copyMemory(from: base, byteCount: byteCount)
          }
        }
      }
      return .uint16(out)
    }

    /// One `ARMeshClassification` byte a face, `stride` bytes apart from `offset`.
    private static func copyClasses(_ source: ARGeometrySource?, faceCount: Int) -> [UInt8]? {
      guard let source, source.format == .uchar, source.count == faceCount,
        source.componentsPerVector == 1, source.stride >= 1, source.offset >= 0,
        fits(
          offset: source.offset, count: source.count, stride: source.stride, size: 1,
          length: source.buffer.length)
      else { return nil }
      guard faceCount > 0 else { return [] }
      let base = UnsafeRawPointer(source.buffer.contents()).advanced(by: source.offset)
      var out = [UInt8](repeating: 0, count: faceCount)
      if source.stride == 1 {
        out.withUnsafeMutableBytes { destination in
          if let target = destination.baseAddress {
            target.copyMemory(from: base, byteCount: faceCount)
          }
        }
      } else {
        for index in 0..<faceCount {
          out[index] = base.load(fromByteOffset: index * source.stride, as: UInt8.self)
        }
      }
      return out
    }

    /// Whether `count` items of `size` bytes, `stride` apart from `offset`, end inside `length`
    /// bytes, without overflowing.
    static func fits(offset: Int, count: Int, stride: Int, size: Int, length: Int) -> Bool {
      guard offset >= 0, count >= 0, stride >= 0, size >= 0, length >= 0 else { return false }
      guard count > 0 else { return offset <= length }
      let (span, overflowA) = (count - 1).multipliedReportingOverflow(by: stride)
      let (start, overflowB) = offset.addingReportingOverflow(span)
      let (end, overflowC) = start.addingReportingOverflow(size)
      return !overflowA && !overflowB && !overflowC && end <= length
    }
  }
#endif
