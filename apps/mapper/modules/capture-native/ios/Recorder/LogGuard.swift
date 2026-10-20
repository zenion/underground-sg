#if USG_RECORDER
  internal import React

  /// The walk build's native log guard (the lean recorder design, D19 and section 10): React
  /// Native's log function is replaced so that JavaScript's messages never reach the device log,
  /// whatever a screen or a library logs. Native messages go on to the function that was there
  /// before. The JavaScript layers (`installLogGuard()` in src/capture/log-guard.ts: console,
  /// `nativeLoggingHook` and the ErrorUtils handler) cover what doesn't come through here.
  ///
  /// Installed from launch in the walk build only (open question Q9), so the development build
  /// keeps its JavaScript logs for desk work. CI's recorder-symbols step checks that this pod's
  /// objects reference `_RCTSetLogFunction`.
  enum LogGuard {
    private static var installed = false

    /// Installs the guard when Info.plist says this is the walk build. Main queue, once.
    @discardableResult
    static func installIfWalkBuild() -> Bool {
      guard AppBuild.profile == "walk", !installed else { return false }
      installed = true
      let next = RCTGetLogFunction()
      RCTSetLogFunction { level, source, fileName, lineNumber, message in
        if source == RCTLogSource.javaScript { return }
        next?(level, source, fileName, lineNumber, message)
      }
      captureNote("log_guard_installed")
      return true
    }
  }
#endif
