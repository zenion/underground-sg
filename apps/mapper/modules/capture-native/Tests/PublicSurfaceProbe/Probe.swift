#if USG_RECORDER
import CaptureCore

// Stand-ins for members that must stay internal to CaptureCore. While the real one is internal,
// code outside CaptureCore sees only this one; once it is public, a use of the name is ambiguous
// and CaptureCorePublicSurfaceTests doesn't compile.

/// What the stand-ins return.
public struct NotReachable: Equatable, Sendable {
  public init() {}
}

extension RecorderCore {
  /// RecorderCore's grant: a synthetic recorder's would be a RecordingGrant made without
  /// `RecordPermission.decide`.
  public var grant: NotReachable { NotReachable() }
}
#endif
