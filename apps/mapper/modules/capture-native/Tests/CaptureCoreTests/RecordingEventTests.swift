#if USG_RECORDER
import Foundation
import Testing

@testable import CaptureCore

/// A copy of `RECORDING_EVENT_DETAILS` in packages/contracts/src/recording.ts: what each event
/// kind's detail holds. packages/contracts/test/swift-event-details.test.ts checks that this
/// copy matches the TypeScript table, so the two can't drift apart.
private let recordingEventDetails: [String: DetailRule] = [
  "recording_opened": .null,
  "recording_closed": .ended,
  "configuration": .code,
  "session_failed": .integer,
  "interruption_began": .null,
  "interruption_ended": .null,
  "relocalization_began": .null,
  "relocalization_ended": .null,
  "image_anchor_detected": .uuid,
  "thermal": .thermal,
  "memory_warning": .null,
  "background": .null,
  "foreground": .null,
  "screenshot": .null,
  "screen_capture_began": .null,
  "screen_capture_ended": .null,
  "altimeter_unavailable": .null,
  "altimeter_denied": .null,
  "motion_unavailable": .null,
  "degradation": .degradation,
]

/// `EventDetailRule`, and `eventDetailAllowed` from the same file, in Swift.
private enum DetailRule {
  case null, ended, thermal, degradation, uuid, integer, code

  func allows(_ detail: String?) -> Bool {
    if self == .null { return detail == nil }
    guard let detail else { return false }
    let bytes = Array(detail.utf8)
    func all(_ test: (UInt8) -> Bool) -> Bool { bytes.allSatisfy(test) }
    let digit = { (b: UInt8) in b >= 48 && b <= 57 }
    let lower = { (b: UInt8) in b >= 97 && b <= 122 }
    let hex = { (b: UInt8) in digit(b) || (b >= 97 && b <= 102) }
    switch self {
    case .null: return false
    case .ended:
      return [
        "end_anchor", "stop", "idle", "background", "heat", "disk", "limit", "interrupted",
      ].contains(detail)
    case .thermal: return ["nominal", "fair", "serious", "critical"].contains(detail)
    case .degradation:
      return ["fewer_candidates", "no_mesh_history", "no_recording"].contains(detail)
    case .uuid:
      let groups = detail.split(separator: "-", omittingEmptySubsequences: false)
      return groups.map(\.count) == [8, 4, 4, 4, 12] && all { hex($0) || $0 == 45 }
    case .integer:
      let digits = bytes.first == 45 ? Array(bytes.dropFirst()) : bytes
      return (1...10).contains(digits.count) && digits.allSatisfy(digit)
    case .code:
      return (1...64).contains(bytes.count) && lower(bytes[0])
        && all { lower($0) || digit($0) || $0 == 95 }
    }
  }
}

/// One of every case, with the extremes of each detail.
private let everyEvent: [RecordingEvent] =
  [
    .recordingOpened, .configuration(.lean), .configuration(.motion(.xMagneticNorthZVertical)),
    .sessionFailed(code: 102), .sessionFailed(code: -1), .sessionFailed(code: .max),
    .sessionFailed(code: .min), .interruptionBegan, .interruptionEnded, .relocalizationBegan,
    .relocalizationEnded,
    .imageAnchorDetected(UUID(uuidString: "8F9585DA-8554-4B8A-BA4E-0F390CCD3802")!),
    .memoryWarning, .background, .foreground, .screenshot, .screenCaptureBegan,
    .screenCaptureEnded, .altimeterUnavailable, .altimeterDenied, .motionUnavailable,
  ]
  + WindowEndReason.allCases.map { .recordingClosed($0) }
  + DeviceThermal.allCases.map { .thermal($0) }
  + DegradationStep.allCases.map { .degradation($0) }

@Suite struct RecordingEventTests {
  @Test func everyDetailIsWhatTheTableAllowsForItsKind() {
    for event in everyEvent {
      let rule = recordingEventDetails[event.kind]
      #expect(rule != nil, "no rule for \(event.kind)")
      #expect(rule?.allows(event.detail) == true, "\(event.kind) wrote a detail its rule refuses")
    }
  }

  @Test func everyKindInTheTableHasACaseAndAGeneratedKind() {
    let kinds = Set(everyEvent.map(\.kind))
    #expect(kinds == Set(recordingEventDetails.keys))
    for kind in recordingEventDetails.keys {
      #expect(RecordingEventKind(rawValue: kind) != nil, "the schema has no kind \(kind)")
    }
  }

  @Test func detailsAreTheFormatsCodes() {
    #expect(RecordingEvent.recordingClosed(.endAnchor).detail == "end_anchor")
    #expect(RecordingEvent.degradation(.noMeshHistory).detail == "no_mesh_history")
    #expect(RecordingEvent.thermal(.serious).detail == "serious")
    #expect(RecordingEvent.sessionFailed(code: 102).detail == "102")
    // Clamped to 32 bits, so never more than 10 digits.
    #expect(RecordingEvent.sessionFailed(code: .max).detail == "2147483647")
    #expect(RecordingEvent.sessionFailed(code: .min).detail == "-2147483648")
    #expect(
      RecordingEvent.imageAnchorDetected(UUID(uuidString: "8F9585DA-8554-4B8A-BA4E-0F390CCD3802")!)
        .detail == "8f9585da-8554-4b8a-ba4e-0f390ccd3802")
    #expect(RecordingEvent.configuration(.gnssTFixAge).detail == "gnss_t_fix_age")
    #expect(RecordingEvent.screenshot.detail == nil)
  }

  @Test func theLineWritesANullDetailExplicitly() throws {
    let line = try PendingLine.event(.background, t: 210.4).encode(LineEncoder())
    #expect(
      String(decoding: line, as: UTF8.self) == #"{"detail":null,"kind":"background","t":210.4}"#
        + "\n")
  }
}

@Suite struct ConfigCodeTests {
  @Test func acceptsShortLowercaseCodes() {
    #expect(ConfigCode("lean")?.text == "lean")
    #expect(ConfigCode("a") != nil)
    #expect(ConfigCode("video_1920x1440_60") != nil)
    #expect(ConfigCode("a" + String(repeating: "_", count: 63)) != nil)
  }

  @Test func refusesAnythingElse() {
    for text in [
      "", "Lean", "1lean", "_lean", "lean-mode", "lean mode", "léan", "margin_2.5s",
      "a" + String(repeating: "b", count: 64),
    ] {
      #expect(ConfigCode(text) == nil, "accepted a code of \(text.utf8.count) bytes")
    }
  }

  @Test func theConfigurationCodes() {
    #expect(ConfigCode.lean.text == "lean")
    #expect(ConfigCode.meshWithClassification.text == "mesh_with_classification")
    #expect(ConfigCode.smoothedSceneDepth.text == "smoothed_scene_depth")
    #expect(ConfigCode.gravity.text == "gravity")
    #expect(ConfigCode.gnssTFixAge.text == "gnss_t_fix_age")
    #expect(ConfigCode.video(width: 1920, height: 1440, fps: 60)?.text == "video_1920x1440_60")
    #expect(ConfigCode.video(width: 0, height: 1440, fps: 60) == nil)
    #expect(
      ConfigCode.motion(.xArbitraryCorrectedZVertical).text
        == "motion_x_arbitrary_corrected_z_vertical")
    #expect(ConfigCode.margin(seconds: 5)?.text == "margin_5s")
    #expect(ConfigCode.margin(seconds: 2.5)?.text == "margin_2_5s")
    #expect(ConfigCode.margin(seconds: 0)?.text == "margin_0s")
    #expect(ConfigCode.margin(seconds: -1) == nil)
    #expect(ConfigCode.idle(seconds: 300)?.text == "idle_300s")
    #expect(ConfigCode.idle(seconds: .infinity) == nil)
    for frame in MotionFrame.allCases {
      #expect(ConfigCode(ConfigCode.motion(frame).text) != nil)
    }
  }
}

@Suite struct SessionCallTests {
  @Test func onlyTheSessionsOwnCallsAreLogged() {
    #expect(
      SessionCall.allCases.map(\.rawValue) == ["start", "markAnchor", "addTag", "stop", "discard"])
    for plumbing in ["appendBoundary", "listRecordings", "exportRecording", "deleteRecording"] {
      #expect(SessionCall(rawValue: plumbing) == nil)
    }
  }
}
#endif
