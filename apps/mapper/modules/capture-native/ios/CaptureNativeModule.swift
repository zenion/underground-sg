import ExpoModulesCore

/// The capture module's bindings (ADR 0007; the lean recorder design, 3.3). Nothing per frame
/// crosses into JavaScript: it gets the capabilities, the CaptureSession shared object with its
/// 5 Hz status and its events, the view that renders a session, and the recorder's plumbing.
///
/// Every recorder function exists in every build. Without the recorder switch (`USG_RECORDER`)
/// each rejects with ERR_RECORDER_NOT_COMPILED; with it, the development build lists, deletes,
/// recovers and self-tests, and only the walk build exports or asks for permissions (design 11).
public final class CaptureNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CaptureNative")

    // Module-level events. A session's events go out through `emit(event:payload:)` on the
    // session itself, so its Class has no Events() (design D20).
    Events("exportProgress")

    // At launch: the walk build's log guard, and recovery once protected data is available.
    OnCreate {
      RecorderEntry.launch()
    }

    Function("getCapabilities") { () -> [String: Any] in
      Capabilities.current()
    }

    // Up to 200 value-free codes.
    Function("getLogTail") { () -> [String] in
      LogRing.shared.lines()
    }

    Class(CaptureSession.self) {
      Constructor { () -> CaptureSession in
        CaptureSession()
      }

      // The ARSession starts here, when the mapper taps Start, never when the view mounts.
      AsyncFunction("start") {
        (session: CaptureSession, options: StartOptions) throws -> [String: Any] in
        try session.start(options)
      }.runOnQueue(.main)

      // Resolved on the next frame.
      AsyncFunction("markAnchor") {
        (session: CaptureSession, options: MarkAnchorOptions, promise: Promise) in
        session.markAnchor(options, promise)
      }

      AsyncFunction("addTag") {
        (session: CaptureSession, options: AddTagOptions, promise: Promise) in
        session.addTag(options, promise)
      }

      AsyncFunction("stop") { (session: CaptureSession, promise: Promise) in
        session.stop(promise)
      }

      AsyncFunction("discard") { (session: CaptureSession, promise: Promise) in
        session.discard(promise)
      }

      // Plumbing: the boundary trace's lines.
      AsyncFunction("appendBoundary") {
        (session: CaptureSession, lines: [String], isFinal: Bool, promise: Promise) in
        session.appendBoundary(lines, isFinal, promise)
      }
    }

    View(CaptureView.self) {
      Prop("session") { (view: CaptureView, session: CaptureSession?) in
        view.attach(session)
      }
    }

    AsyncFunction("listRecordings") { (promise: Promise) in
      RecorderEntry.listRecordings(promise)
    }

    AsyncFunction("exportRecording") { (id: String, promise: Promise) in
      RecorderEntry.exportRecording(id, promise) { [weak self] payload in
        self?.sendEvent("exportProgress", payload)
      }
    }

    AsyncFunction("deleteRecording") { (id: String, promise: Promise) in
      RecorderEntry.deleteRecording(id, promise)
    }

    AsyncFunction("recoveryStatus") { (promise: Promise) in
      RecorderEntry.recoveryStatus(promise)
    }

    AsyncFunction("recorderSelfTest") { (keep: Bool, promise: Promise) in
      RecorderEntry.selfTest(keep, promise)
    }

    AsyncFunction("requestRecorderPermissions") { (promise: Promise) in
      RecorderEntry.requestPermissions(promise)
    }
  }
}

/// The recorder functions' entry points, the same in every build: with the recorder switch they
/// go to RecorderPlumbing (ios/Recorder/), without it they reject with ERR_RECORDER_NOT_COMPILED.
enum RecorderEntry {
  static func launch() {
    #if USG_RECORDER
      RecorderPlumbing.shared.launch()
    #endif
  }

  static func listRecordings(_ promise: Promise) {
    #if USG_RECORDER
      RecorderPlumbing.shared.listRecordings(promise)
    #else
      promise.reject(notCompiled())
    #endif
  }

  static func exportRecording(
    _ id: String, _ promise: Promise, progress: @escaping ([String: Any?]) -> Void
  ) {
    #if USG_RECORDER
      RecorderPlumbing.shared.exportRecording(id, progress: progress, promise)
    #else
      promise.reject(notCompiled())
    #endif
  }

  static func deleteRecording(_ id: String, _ promise: Promise) {
    #if USG_RECORDER
      RecorderPlumbing.shared.deleteRecording(id, promise)
    #else
      promise.reject(notCompiled())
    #endif
  }

  static func recoveryStatus(_ promise: Promise) {
    #if USG_RECORDER
      promise.resolve(RecorderPlumbing.shared.recoveryStatus())
    #else
      promise.reject(notCompiled())
    #endif
  }

  static func selfTest(_ keep: Bool, _ promise: Promise) {
    #if USG_RECORDER
      RecorderPlumbing.shared.selfTest(keep: keep, promise)
    #else
      promise.reject(notCompiled())
    #endif
  }

  static func requestPermissions(_ promise: Promise) {
    #if USG_RECORDER
      RecorderPlumbing.shared.requestPermissions(promise)
    #else
      promise.reject(notCompiled())
    #endif
  }

  private static func notCompiled() -> Exception {
    captureError("ERR_RECORDER_NOT_COMPILED")
  }
}
