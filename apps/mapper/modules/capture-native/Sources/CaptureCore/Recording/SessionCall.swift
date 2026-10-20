#if USG_RECORDER
/// The module calls actions.jsonl logs (docs/session-recording.md): the session's own calls,
/// and nothing else. The recorder's plumbing (`appendBoundary`, `listRecordings`,
/// `exportRecording`, `deleteRecording`) has no case, so it can't be logged. The raw values are
/// the method names JavaScript calls.
public enum SessionCall: String, CaseIterable, Sendable {
  case start
  case markAnchor
  case addTag
  case stop
  case discard
}
#endif
