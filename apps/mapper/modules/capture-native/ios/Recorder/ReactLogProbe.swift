#if USG_RECORDER
internal import React

/// The React import probe (the lean recorder design, D19 and PR3). LogGuard, which comes with the
/// native glue, replaces React Native's log function at launch in the walk build so that
/// JavaScript's messages never reach the device log. This file proves, in CI's Release build with
/// the recorder switch on, that this pod can import React and reach the two names LogGuard needs,
/// `RCTSetLogFunction` and `RCTLogSourceJavaScript`. CI's recorder-symbols step checks that the
/// pod's objects reference `_RCTSetLogFunction`.
///
/// Nothing calls it: it is compiled, not run. It is public only so that the optimiser keeps it.
/// LogGuard replaces it, with the walk-build check and the forwarding rules of design section 10.
public enum ReactLogProbe {
  /// The filter LogGuard will install: JavaScript's messages are dropped, native ones are passed
  /// on to the log function that was there before.
  public static func installFilter() {
    let next = RCTGetLogFunction()
    RCTSetLogFunction { level, source, fileName, lineNumber, message in
      if source == RCTLogSource.javaScript { return }
      next?(level, source, fileName, lineNumber, message)
    }
  }
}
#endif
