#if USG_RECORDER
/// A `configuration` event's detail: a short lowercase code saying what the session ran with
/// (design section 5). The format allows `^[a-z][a-z0-9_]{0,63}$`, so a code that can't be
/// written can't be made: the init fails instead.
public struct ConfigCode: Equatable, Hashable, Sendable {
  public let text: String

  /// Nil unless `text` is a lowercase letter followed by at most 63 lowercase letters, digits
  /// and underscores.
  public init?(_ text: String) {
    let bytes = Array(text.utf8)
    guard let first = bytes.first, (1...64).contains(bytes.count), isLower(first) else {
      return nil
    }
    guard bytes.allSatisfy({ isLower($0) || isDigit($0) || $0 == UInt8(ascii: "_") }) else {
      return nil
    }
    self.text = text
  }

  /// For the codes below, which are valid by construction.
  private init(known text: String) {
    guard let code = ConfigCode(text) else { preconditionFailure("an invalid built-in code") }
    self = code
  }

  public static let lean = ConfigCode(known: "lean")
  public static let meshWithClassification = ConfigCode(known: "mesh_with_classification")
  public static let smoothedSceneDepth = ConfigCode(known: "smoothed_scene_depth")
  public static let gravity = ConfigCode(known: "gravity")
  /// GNSS `t` comes from the fix's age (design D15).
  public static let gnssTFixAge = ConfigCode(known: "gnss_t_fix_age")

  /// The video format: `video_1920x1440_60`.
  public static func video(width: Int, height: Int, fps: Int) -> ConfigCode? {
    guard width > 0, height > 0, fps > 0 else { return nil }
    return ConfigCode("video_\(width)x\(height)_\(fps)")
  }

  /// Device motion's reference frame, in snake case: `motion_x_arbitrary_corrected_z_vertical`.
  public static func motion(_ frame: MotionFrame) -> ConfigCode {
    var snake = ""
    for character in frame.rawValue {
      if character.isUppercase { snake += "_" }
      snake += character.lowercased()
    }
    return ConfigCode(known: "motion_" + snake)
  }

  /// The window's margin after an end anchor: `margin_5s`, or `margin_2_5s` for 2.5 s.
  public static func margin(seconds: Double) -> ConfigCode? {
    seconds >= 0 ? secondsCode("margin_", seconds) : nil
  }

  /// The window's idle timeout: `idle_300s`.
  public static func idle(seconds: Double) -> ConfigCode? {
    seconds > 0 ? secondsCode("idle_", seconds) : nil
  }

  /// Seconds to a tenth, with `_` for the decimal point, since the format has no `.`.
  private static func secondsCode(_ prefix: String, _ seconds: Double) -> ConfigCode? {
    guard seconds.isFinite, seconds < 1e9 else { return nil }
    let tenths = Int((seconds * 10).rounded())
    let whole = String(tenths / 10)
    let text = tenths % 10 == 0 ? whole : whole + "_" + String(tenths % 10)
    return ConfigCode(prefix + text + "s")
  }
}

private func isLower(_ byte: UInt8) -> Bool {
  byte >= UInt8(ascii: "a") && byte <= UInt8(ascii: "z")
}

private func isDigit(_ byte: UInt8) -> Bool {
  byte >= UInt8(ascii: "0") && byte <= UInt8(ascii: "9")
}
#endif
