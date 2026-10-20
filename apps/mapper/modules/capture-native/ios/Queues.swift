import Foundation

/// The module's queues (the lean recorder design, section 4). No queue blocks on another: work
/// moves between them with `async` only, and `.sync` appears only in tests.
///
/// - main: UIKit, the ARView and the privacy shield, `session.run` and `pause`, background tasks
///   and the idle timer. Nothing per frame.
/// - `capture`: the ARSession's delegate queue (design D4). Frames, the candidate gate, marks and
///   tags (handled on the next frame), the 5 Hz status timer; the recorder's state machine.
/// - `motion`: Core Motion's handlers (an OperationQueue that runs one operation at a time on
///   its own serial queue), batched onto `capture`.
/// - `mesh`: packing, fingerprinting and compressing mesh geometry for the history.
/// - `recorderIO`: the recording's files (encoding, writes, syncs, finalize).
/// - `store`: the recordings as a whole: recovery at launch, list, export, delete and the
///   self-test, one at a time.
enum Queues {
  static let capture = DispatchQueue(label: "usg.capture", qos: .userInitiated)
  static let mesh = DispatchQueue(label: "usg.mesh", qos: .utility)
  static let recorderIO = DispatchQueue(label: "usg.recorder.io", qos: .utility)
  static let store = DispatchQueue(label: "usg.recordings.store", qos: .utility)

  /// The serial queue under `motion`.
  static let motionUnderlying = DispatchQueue(label: "usg.capture.motion", qos: .userInitiated)

  static let motion: OperationQueue = {
    let queue = OperationQueue()
    queue.name = "usg.capture.motion"
    queue.maxConcurrentOperationCount = 1
    queue.qualityOfService = .userInitiated
    queue.underlyingQueue = motionUnderlying
    return queue
  }()
}
