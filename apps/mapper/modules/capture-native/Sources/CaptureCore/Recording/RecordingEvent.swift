#if USG_RECORDER
import Foundation

/// One line of events.jsonl (docs/session-recording.md). Each case carries only the detail its
/// kind allows, as `RECORDING_EVENT_DETAILS` in packages/contracts fixes it, so the recorder can't
/// write a pose, a time or a fix into an event: a code, a count or an id at most.
public enum RecordingEvent: Equatable, Sendable {
  case recordingOpened
  case recordingClosed(WindowEndReason)
  case configuration(ConfigCode)
  /// The ARSession error's code.
  case sessionFailed(code: Int)
  case interruptionBegan
  case interruptionEnded
  case relocalizationBegan
  case relocalizationEnded
  /// The image anchor's identifier.
  case imageAnchorDetected(UUID)
  case thermal(DeviceThermal)
  case memoryWarning
  case background
  case foreground
  case screenshot
  case screenCaptureBegan
  case screenCaptureEnded
  case altimeterUnavailable
  case altimeterDenied
  case motionUnavailable
  case degradation(DegradationStep)

  /// The line's `kind`.
  public var kind: String { eventKind.rawValue }

  /// The generated kind, so a kind the schema doesn't know can't be written.
  var eventKind: RecordingEventKind {
    switch self {
    case .recordingOpened: .recordingOpened
    case .recordingClosed: .recordingClosed
    case .configuration: .configuration
    case .sessionFailed: .sessionFailed
    case .interruptionBegan: .interruptionBegan
    case .interruptionEnded: .interruptionEnded
    case .relocalizationBegan: .relocalizationBegan
    case .relocalizationEnded: .relocalizationEnded
    case .imageAnchorDetected: .imageAnchorDetected
    case .thermal: .thermal
    case .memoryWarning: .memoryWarning
    case .background: .background
    case .foreground: .foreground
    case .screenshot: .screenshot
    case .screenCaptureBegan: .screenCaptureBegan
    case .screenCaptureEnded: .screenCaptureEnded
    case .altimeterUnavailable: .altimeterUnavailable
    case .altimeterDenied: .altimeterDenied
    case .motionUnavailable: .motionUnavailable
    case .degradation: .degradation
    }
  }

  /// The line's `detail`, or nil for the kinds whose detail is always null.
  public var detail: String? {
    switch self {
    case .recordingClosed(let reason): reason.rawValue
    case .configuration(let code): code.text
    // Clamped to 32 bits, so the text is at most 10 digits, as the format allows.
    case .sessionFailed(let code): String(Int32(clamping: code))
    case .imageAnchorDetected(let id): id.uuidString.lowercased()
    case .thermal(let state): state.rawValue
    case .degradation(let step): step.rawValue
    case .recordingOpened, .interruptionBegan, .interruptionEnded, .relocalizationBegan,
      .relocalizationEnded, .memoryWarning, .background, .foreground, .screenshot,
      .screenCaptureBegan, .screenCaptureEnded, .altimeterUnavailable, .altimeterDenied,
      .motionUnavailable:
      nil
    }
  }

  /// The generated line at `t`.
  func line(t: Double) -> RecordingEventLine {
    RecordingEventLine(detail: detail, kind: eventKind, t: t)
  }
}
#endif
