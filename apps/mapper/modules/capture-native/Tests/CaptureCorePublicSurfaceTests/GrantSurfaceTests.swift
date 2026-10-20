#if USG_RECORDER
import CaptureCore
import PublicSurfaceProbe
import Testing

// No @testable here: this is CaptureCore as ios/ and CaptureIO see it (design sections 2 and 11).

struct GrantSurfaceTests {
  /// Only `RecordPermission.decide` hands out a grant. A synthetic recorder holds one, but code
  /// outside CaptureCore can't read it back, so the development build can't use it to reach the
  /// location source, the recorder host or the export.
  @Test func aSyntheticRecorderGivesNoGrantOutside() {
    let recorder = SyntheticSession().makeRecorder()
    // No type context, or the compiler would just pick the stand-in.
    let grant = recorder.grant
    #expect(grant == NotReachable())
  }
}
#endif
