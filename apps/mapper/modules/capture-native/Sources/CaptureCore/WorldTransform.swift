import Foundation

/// A rigid transform in the session's world frame: 16 floats, column-major, as ARKit's
/// `simd_float4x4` and the capture bundle store it (docs/capture-bundle.md). CaptureCore can't
/// import simd, so the module copies ARKit's matrix into this.
public struct WorldTransform: Equatable, Sendable {
  /// Column-major: `m[column * 4 + row]`. The translation is `m[12]`, `m[13]`, `m[14]`.
  public let m: [Float]

  public init(columnMajor m: [Float]) {
    precondition(m.count == 16, "a transform has 16 values")
    self.m = m
  }

  public static let identity = WorldTransform(columnMajor: [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ])

  /// A rotation of `radians` about the vertical (y) axis, then a translation.
  public static func yaw(_ radians: Double, x: Double = 0, y: Double = 0, z: Double = 0)
    -> WorldTransform
  {
    let c = Float(cos(radians))
    let s = Float(sin(radians))
    return WorldTransform(columnMajor: [
      c, 0, -s, 0,
      0, 1, 0, 0,
      s, 0, c, 0,
      Float(x), Float(y), Float(z), 1,
    ])
  }

  public var translation: (x: Double, y: Double, z: Double) {
    (Double(m[12]), Double(m[13]), Double(m[14]))
  }

  /// Straight-line distance between the two origins, in metres.
  public func distance(to other: WorldTransform) -> Double {
    let a = translation
    let b = other.translation
    let dx = a.x - b.x
    let dy = a.y - b.y
    let dz = a.z - b.z
    return (dx * dx + dy * dy + dz * dz).squareRoot()
  }

  /// The angle of the rotation that takes this orientation to the other's, in degrees (0 to 180).
  /// From the trace of Rᵀ R': cos θ = (tr − 1) / 2, where tr sums the products of matching
  /// elements of the two 3 × 3 rotation parts.
  public func rotationDegrees(to other: WorldTransform) -> Double {
    var trace = 0.0
    for column in 0..<3 {
      for row in 0..<3 {
        trace += Double(m[column * 4 + row]) * Double(other.m[column * 4 + row])
      }
    }
    let cosine = min(1, max(-1, (trace - 1) / 2))
    return acos(cosine) * 180 / Double.pi
  }
}
