import ExpoModulesCore

/// The capture module's bindings (ADR 0007). Nothing per frame crosses into JavaScript: it gets
/// the capabilities, the view, status events at about 5 Hz and warnings.
public final class CaptureNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CaptureNative")

    Function("getCapabilities") { () -> [String: Any] in
      Capabilities.current()
    }

    View(CaptureView.self) {
      Events("onStatus", "onWarning")

      // The ARSession starts here, when the mapper taps Start, never when the view mounts.
      AsyncFunction("start") { (view: CaptureView) in
        try view.start()
      }.runOnQueue(.main)

      AsyncFunction("stop") { (view: CaptureView) in
        view.stop()
      }.runOnQueue(.main)
    }
  }
}
