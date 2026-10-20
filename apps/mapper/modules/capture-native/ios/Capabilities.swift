import ARKit
import Foundation

/// What this phone can capture: ARKit's own checks, which the model name can only guess at.
/// Called from the JavaScript thread, so it reads nothing from UIKit.
enum Capabilities {
  static func current() -> [String: Any] {
    let formats: [[String: Any]] = ARWorldTrackingConfiguration.supportedVideoFormats.map { format in
      [
        "width": Int(format.imageResolution.width),
        "height": Int(format.imageResolution.height),
        "fps": format.framesPerSecond,
      ]
    }
    let os = ProcessInfo.processInfo.operatingSystemVersion
    return [
      "worldTracking": ARWorldTrackingConfiguration.isSupported,
      // LiDAR: scene reconstruction with per-face classification.
      "sceneReconstruction": ARWorldTrackingConfiguration.supportsSceneReconstruction(
        .meshWithClassification),
      "sceneDepth": ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth),
      "smoothedSceneDepth": ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth),
      "videoFormats": formats,
      "deviceModel": hardwareModel(),
      "osVersion": "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
      "thermal": thermalStateName(ProcessInfo.processInfo.thermalState),
      "recorder": recorder(),
    ]
  }

  /// The session recorder (ADR 0010): whether it is compiled in (the development and walk builds
  /// only), whether `start({ record: "lean" })` would be granted now, and if not, why.
  static func recorder() -> [String: Any] {
    #if USG_RECORDER
      return RecorderPlumbing.shared.recorderCapabilities()
    #else
      return [
        "compiled": false,
        "canRecord": false,
        "refusal": "notCompiled",
        "buildProfile": NSNull(),
      ]
    #endif
  }

  /// The hardware identifier, for example iPhone18,2, as the bundle manifest records it.
  static func hardwareModel() -> String {
    var info = utsname()
    uname(&info)
    return withUnsafeBytes(of: &info.machine) { raw in
      String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
    }
  }
}

func thermalStateName(_ state: ProcessInfo.ThermalState) -> String {
  switch state {
  case .nominal: return "nominal"
  case .fair: return "fair"
  case .serious: return "serious"
  case .critical: return "critical"
  @unknown default: return "unknown"
  }
}
