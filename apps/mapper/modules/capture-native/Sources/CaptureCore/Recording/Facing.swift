#if USG_RECORDER
/// Which way the camera faces across the floor, for a marked anchor's `facing` (design 3.1): the
/// camera looks along its −z axis, projected onto the horizontal plane (y = 0 in ARKit's
/// gravity-aligned world) and normalised. Looking almost straight up or down leaves too little
/// of it to say which way the owner faced, so then there is none.
public enum Facing {
  /// The shortest horizontal part kept, as a fraction of the unit view direction.
  public static let minHorizontal = 0.2

  /// The unit horizontal direction the camera faces, y = 0, or nil when it faces within about
  /// 11.5° of straight up or down (a horizontal part under 0.2).
  public static func horizontal(camera: WorldTransform) -> SIMD3<Double>? {
    // Column 2 of the rotation is the camera's +z axis in world coordinates.
    let x = -Double(camera.m[8])
    let z = -Double(camera.m[10])
    let length = (x * x + z * z).squareRoot()
    guard length.isFinite, length >= minHorizontal else { return nil }
    return SIMD3(x / length, 0, z / length)
  }
}
#endif
