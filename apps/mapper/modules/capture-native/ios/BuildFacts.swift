import Foundation

#if USG_RECORDER
  import CaptureCore
#endif

/// What the module reads about the build it runs in (the lean recorder design, section 2), for
/// `getCapabilities()` and, with the recorder, `RecordPermission.decide`. Read once, from the
/// bundle and the Objective-C runtime, which any thread may do.
enum AppBuild {
  /// Compiled with the recorder switch (`USG_RECORDER`).
  static var recorderCompiled: Bool {
    #if USG_RECORDER
      return true
    #else
      return false
    #endif
  }

  /// A DEBUG build. CocoaPods defines DEBUG in the pods' Debug configuration only.
  static var debugBuild: Bool {
    #if DEBUG
      return true
    #else
      return false
    #endif
  }

  /// Info.plist's `USGBuildProfile` when it is one the config plugin writes (`development` or
  /// `walk`), else nil.
  static let profile: String? = {
    guard let value = Bundle.main.object(forInfoDictionaryKey: "USGBuildProfile") as? String,
      value == "development" || value == "walk"
    else { return nil }
    return value
  }()

  /// `main.jsbundle` is in the app: the JavaScript is embedded, not served by Metro.
  static let embeddedBundle: Bool =
    Bundle.main.url(forResource: "main", withExtension: "jsbundle") != nil

  /// expo-dev-launcher's controller is linked: a development client (debugOnly in Expo, so a
  /// Release build has none).
  static let devLauncher: Bool = NSClassFromString("EXDevLauncherController") != nil

  /// Info.plist's `USGGitCommit` (40 lowercase hex digits, checked by the config plugin), or nil.
  static let gitCommit: String? =
    Bundle.main.object(forInfoDictionaryKey: "USGGitCommit") as? String

  /// Info.plist's `USGEasBuildId` (a UUID, checked by the config plugin), or nil.
  static let easBuildID: String? =
    Bundle.main.object(forInfoDictionaryKey: "USGEasBuildId") as? String

  /// The app's version, for example 0.1.0.
  static let appVersion: String =
    (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.0.0"
}

#if USG_RECORDER
  extension BuildFacts {
    /// This build's facts, for `RecordPermission.decide`.
    static var current: BuildFacts {
      BuildFacts(
        recorderCompiled: AppBuild.recorderCompiled, debugBuild: AppBuild.debugBuild,
        buildProfile: AppBuild.profile, embeddedBundle: AppBuild.embeddedBundle,
        devLauncher: AppBuild.devLauncher)
    }
  }
#endif
