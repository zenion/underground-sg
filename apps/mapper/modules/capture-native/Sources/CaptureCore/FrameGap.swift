/// The frames ARKit skipped between two ARFrames, for `frames.jsonl`'s `gap`
/// (docs/session-recording.md): the time between them at the video format's rate, less the one
/// step that is no skip. 0 for the first frame (`previousT` nil). Frame times are multiples of
/// the frame interval only in floating point, so the count is rounded: 1/60 s apart at 60 fps is
/// 0 skipped, never -1 or 1. Non-finite or non-positive inputs (a clock error, a repeated time)
/// give 0, since a gap that can't be measured is not evidence of a dropped frame.
public func framesSkipped(previousT: Double?, t: Double, fps: Int) -> Int {
  guard let previousT, previousT.isFinite, t.isFinite, fps > 0 else { return 0 }
  let dt = t - previousT
  guard dt > 0 else { return 0 }
  let steps = (dt * Double(fps)).rounded()
  // Far beyond any session's length; keeps the conversion to Int from trapping.
  guard steps.isFinite, steps < 1e15 else { return 0 }
  return max(0, Int(steps) - 1)
}
