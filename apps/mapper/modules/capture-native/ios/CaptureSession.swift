import ARKit
import CaptureCore
import ExpoModulesCore
import QuartzCore
import UIKit

#if USG_RECORDER
  import CaptureIO
#endif

// The CaptureSession shared object (the lean recorder design, 3.3, D4 and D20): the ARSession of
// one capture. JavaScript makes one, hands it to a `<CaptureView>` through its `session` prop, and
// calls `start`, `markAnchor`, `addTag`, `stop` and `discard` on it. The session attaches to that
// view's ARView and runs the ARView's own ARSession, with this module's delegate on
// `Queues.capture` (design D4); the view only renders, behind the privacy shield.
//
// Nothing per frame crosses into JavaScript: the session emits `status` at 5 Hz (counts, rates and
// states), `warning`, `recording` on the recorder's state changes, and `stopped`, through
// `emit(event:payload:)`, which schedules on the JavaScript runtime and is safe from any queue.
// Marks and tags resolve on the frame after the call, with that frame's pose: those results, and
// the `t` every event carries, are the only pose-bearing values that reach JavaScript, where
// src/capture/native.ts traces them and wraps them in Redacted.
//
// With `record: off` (the Capture tab's camera check, desk checks, every build) nothing is
// written. With a profile, `start` asks RecordPermission: only the walk build gets a grant, and
// with it a RecorderHost (ios/Recorder/) records the session from the first start mark. A
// development build refuses with ERR_RECORD_REFUSED and the refusal's name.

// MARK: - Options

/// `start`'s `record`: the recording profile.
enum RecordMode: String, Enumerable {
  case off
  case lean
  case standard
  case dense
}

struct StartOptions: Record {
  @Field var record: RecordMode = .off
  /// The venues the session covers: 1 to 50 lowercase UUIDs (checked when recording).
  @Field var venues: [String] = []
}

enum MarkRole: String, Enumerable {
  case start
  case end
}

enum MarkKind: String, Enumerable {
  case floorPoint = "floor_point"
}

struct MarkAnchorOptions: Record {
  @Field var role: MarkRole = .start
  @Field var kind: MarkKind = .floorPoint
  @Field var streetFacing: Bool = false
  @Field var endSessionHere: Bool = false
  @Field var name: String? = nil

  /// The arguments as JavaScript passed them, for actions.jsonl.
  var arguments: [String: Any] {
    [
      "role": role.rawValue, "kind": kind.rawValue, "streetFacing": streetFacing,
      "endSessionHere": endSessionHere, "name": name.map { $0 as Any } ?? NSNull(),
    ]
  }
}

enum TagType: String, Enumerable {
  case node
  case poi
}

struct AddTagOptions: Record {
  @Field var type: TagType = .node
  @Field var kind: String = ""
  @Field var name: String? = nil

  /// The arguments as JavaScript passed them, for actions.jsonl.
  var arguments: [String: Any] {
    ["type": type.rawValue, "kind": kind, "name": name.map { $0 as Any } ?? NSNull()]
  }
}

// MARK: - Errors

/// The module's errors (design 3.3): a constant code and a constant reason, the code itself or,
/// for a refusal, the refusal's name. Never a value, a path or a system error's text.
func captureError(_ code: StaticString, reason: String? = nil) -> Exception {
  Exception(name: "CaptureError", description: reason ?? code.description, code: code.description)
}

// MARK: - The shared object

final class CaptureSession: SharedObject {
  // Main thread only.
  private weak var view: CaptureView?
  private var arSession: ARSession?
  private var running = false
  /// `ProcessInfo.systemUptime` just before `session.run` (design D26): session time 0.
  private var t0 = 0.0
  /// The session time at the last stop, for a `stop` that finds the session stopped.
  private var lastT = 0.0
  /// What `isIdleTimerDisabled` was before `start`, restored at the stop: the dev client's
  /// keep-awake sets it too.
  private var idleTimerWasDisabled = false
  /// The recorder's state, for the view's REC badge.
  private(set) var recorderState = "off"
  #if USG_RECORDER
    /// The recording of the session last started with a grant. It outlives the session's stop
    /// until its files are finished, and is replaced at the next `start`.
    private var host: RecorderHost?
  #endif

  /// The ARSession's delegate, confined to `Queues.capture`.
  private let loop = CaptureLoop()

  // MARK: Attaching to a view (main)

  /// The view's `session` prop now names this session.
  func attach(view next: CaptureView) {
    if view === next { return }
    if let old = view {
      stopRunning()
      old.sessionWasDetached(self)
    }
    view = next
    next.showRecorderState(recorderState)
  }

  /// The view's `session` prop no longer names this session.
  func detach(view old: CaptureView) {
    guard view === old else { return }
    stopRunning()
    view = nil
  }

  /// The view left its window: the camera stops, as it always has when the view goes.
  func viewLeftWindow(_ old: CaptureView) {
    guard view === old else { return }
    stopRunning()
  }

  // MARK: Calls from JavaScript

  /// Starts the ARSession (main queue). Resolves at once: a recording opens only at the first
  /// start mark, so `recordingId` is null here.
  func start(_ options: StartOptions) throws -> [String: Any] {
    let result: [String: Any] = ["recordingId": NSNull()]
    if running { return result }
    #if USG_RECORDER
      let grant = try recordGrant(options)
    #else
      try refuseRecording(options)
    #endif
    guard ARWorldTrackingConfiguration.isSupported else {
      throw captureError("ERR_TRACKING", reason: "worldTrackingUnsupported")
    }
    // Only a view with a secure canvas can show the camera (ADR 0010): without one there is no
    // ARView to run.
    guard let view, let arView = view.prepareCamera() else {
      throw captureError("ERR_NO_VIEW")
    }

    let configuration = CaptureSession.configuration()
    let session = arView.session
    let fps = configuration.videoFormat.framesPerSecond
    let covered = view.isCovered
    #if USG_RECORDER
      // Device motion's reference frame and the altimeter's state, for recording.json.
      let motion: MotionSource? = grant == nil ? nil : MotionSource()
    #endif
    // The session clock (design D26): the three clocks read together just before `session.run`.
    let start = ProcessInfo.processInfo.systemUptime
    #if USG_RECORDER
      let clock = SessionClock(uptime: start, media: CACurrentMediaTime(), wall: Date())
      let recorder = try makeRecorder(
        grant: grant, motion: motion, clock: clock, configuration: configuration, fps: fps)
      host = recorder
    #endif
    // Ordered ahead of the first delegate callback, which ARKit queues on the same serial queue.
    Queues.capture.async { [loop, weak self] in
      loop.begin(owner: self, session: session, t0: start, fps: fps, covered: covered)
      #if USG_RECORDER
        loop.attach(recorder)
      #endif
    }
    session.delegate = loop
    session.delegateQueue = Queues.capture
    t0 = start
    session.run(
      configuration, options: [.resetTracking, .removeExistingAnchors, .resetSceneReconstruction])
    arSession = session
    view.cameraStarted()
    running = true
    idleTimerWasDisabled = UIApplication.shared.isIdleTimerDisabled
    UIApplication.shared.isIdleTimerDisabled = true
    #if USG_RECORDER
      recorder?.startSensors()
    #endif
    captureNote("session_started")
    return result
  }

  /// Resolves on the next frame, with the floor point under the screen's centre (design 3.3).
  func markAnchor(_ options: MarkAnchorOptions, _ promise: Promise) {
    Queues.capture.async { [loop] in
      loop.requestMark(options, promise)
    }
  }

  /// Resolves on the next frame, with the camera's position.
  func addTag(_ options: AddTagOptions, _ promise: Promise) {
    Queues.capture.async { [loop] in
      loop.requestTag(options, promise)
    }
  }

  /// Stops the session. With a recording, the stop is handled on the next frame (design section
  /// 6) and resolves once the recording has settled, with its outcome; without one, `recording`
  /// is null.
  func stop(_ promise: Promise) {
    DispatchQueue.main.async {
      let t = self.running ? self.sessionTime() : self.lastT
      #if USG_RECORDER
        if self.host != nil {
          Queues.capture.async { [loop = self.loop] in
            loop.requestStop(promise, fallbackT: t)
          }
          return
        }
      #endif
      self.stopRunning()
      let result: [String: Any] = ["t": t, "recording": NSNull()]
      promise.resolve(result)
    }
  }

  /// Stops the session and deletes its recording, if any: nothing of it is kept. Rejects with
  /// ERR_RECORDING_BUSY when a recording closed while the phone was locked can't be removed yet,
  /// and with ERR_IO when removing it failed.
  func discard(_ promise: Promise) {
    DispatchQueue.main.async {
      #if USG_RECORDER
        if let host = self.host {
          Queues.capture.async {
            host.discard { result in
              switch result {
              case .removed:
                promise.resolve()
              case .busy:
                promise.reject(captureError("ERR_RECORDING_BUSY"))
              case .failed:
                promise.reject(captureError("ERR_IO"))
              }
            }
            // The recorder has already let the recording go, so the stop keeps nothing.
            DispatchQueue.main.async { self.stopRunning() }
          }
          return
        }
      #endif
      self.stopRunning()
      promise.resolve()
    }
  }

  /// The boundary trace's lines (session-recording.md, boundary.jsonl). Plumbing: nothing traces
  /// it. Without a recording they are dropped.
  func appendBoundary(_ lines: [String], _ isFinal: Bool, _ promise: Promise) {
    Queues.capture.async { [loop] in
      loop.appendBoundary(lines, final: isFinal)
      promise.resolve()
    }
  }

  // MARK: From the view and the delegate (main)

  /// The privacy shield's cover went on or off.
  func coverChanged(_ covered: Bool) {
    Queues.capture.async { [loop] in
      loop.setCovered(covered)
    }
  }

  /// A screenshot was taken while camera pixels were on screen.
  func screenshotTaken() {
    let payload: [String: Any] = ["t": running ? sessionTime() : lastT, "kind": "screenshot"]
    emit(event: "warning", payload: payload)
    #if USG_RECORDER
      if let host { Queues.capture.async { host.event(.screenshot) } }
    #endif
  }

  /// The screen began or stopped being recorded or mirrored (the cover is on while it is).
  func screenCaptureChanged(_ captured: Bool) {
    #if USG_RECORDER
      if let host {
        Queues.capture.async { host.event(captured ? .screenCaptureBegan : .screenCaptureEnded) }
      }
    #endif
  }

  /// The view's scene entered the background, a locked screen included: an open recording
  /// closes as `background` (design section 6), inside a background task that ends once its
  /// files are finished.
  func sceneDidEnterBackground() {
    #if USG_RECORDER
      guard let host else { return }
      let task = BackgroundClose.begin()
      Queues.capture.async {
        host.closeForBackground {
          DispatchQueue.main.async { task.end() }
        }
      }
    #endif
  }

  func sceneWillEnterForeground() {
    #if USG_RECORDER
      if let host { Queues.capture.async { host.event(.foreground) } }
    #endif
  }

  /// The ARSession failed; the delegate has emitted the warning.
  func sessionFailed() {
    DispatchQueue.main.async {
      self.stopRunning()
    }
  }

  /// The delegate handled `stop` on a frame: the session stops now.
  func stopAfterRecorder() {
    DispatchQueue.main.async {
      self.stopRunning()
    }
  }

  /// The recorder's state changed: the REC badge follows it.
  func setRecorderState(_ state: String) {
    recorderState = state
    view?.showRecorderState(state)
  }

  override func sharedObjectWillRelease() {
    // JavaScript let go of the session: the camera stops with it.
    DispatchQueue.main.async {
      self.stopRunning()
    }
  }

  // MARK: Private (main)

  private func stopRunning() {
    guard running else { return }
    arSession?.pause()
    // A paused ARView keeps showing its last camera frame: hide it until the next start.
    view?.cameraStopped()
    running = false
    UIApplication.shared.isIdleTimerDisabled = idleTimerWasDisabled
    lastT = sessionTime()
    let t = lastT
    #if USG_RECORDER
      // Core Motion's last batch is queued ahead of anything the recorder's close asks of it.
      host?.stopSensors()
    #endif
    let session = arSession
    // The last status and `stopped` go out from the capture queue, after any frame in flight. A
    // recording still open is stopped there on the session's last frame.
    Queues.capture.async { [loop] in
      loop.end(at: t, lastFrame: session?.currentFrame)
    }
    captureNote("session_stopped")
  }

  private func sessionTime() -> Double {
    sessionSeconds(ProcessInfo.processInfo.systemUptime - t0)
  }

  #if USG_RECORDER
    /// `record: off` needs nothing. Anything else needs a grant (only the walk build gets one)
    /// and recovery done.
    private func recordGrant(_ options: StartOptions) throws -> RecordingGrant? {
      if options.record == .off { return nil }
      let decision = RecordPermission.decide(
        profile: RecordProfile(rawValue: options.record.rawValue), facts: .current,
        venues: options.venues, freeDiskBytes: RecorderPlumbing.shared.store.freeBytes())
      switch decision {
      case .off:
        return nil
      case .refused(let refusal):
        throw refusalError(refusal)
      case .granted(let grant):
        guard RecorderPlumbing.recorderWired else {
          throw captureError("ERR_PROFILE_UNAVAILABLE")
        }
        guard RecorderPlumbing.shared.recoveryDone else {
          throw captureError("ERR_RECOVERY_PENDING")
        }
        return grant
      }
    }

    /// The session's recorder, with what recording.json says about the build, the phone, the
    /// clocks and the configuration. Nil without a grant.
    private func makeRecorder(
      grant: RecordingGrant?, motion: MotionSource?, clock: SessionClock,
      configuration: ARWorldTrackingConfiguration, fps: Int
    ) throws -> RecorderHost? {
      guard let grant, let motion else { return nil }
      let base = ManifestBase(
        origin: .device, appVersion: AppBuild.appVersion, gitCommit: AppBuild.gitCommit,
        easBuildID: AppBuild.easBuildID, deviceModel: Capabilities.hardwareModel(),
        osVersion: CaptureSession.osVersion(), clock: clock,
        arkit: ARKitAdapter.setup(configuration), motionFrame: motion.referenceFrame,
        altimeter: motion.altimeter)
      guard
        let host = RecorderHost(
          grant: grant, base: base, fps: fps, motion: motion,
          emit: { [weak self] name, payload in
            self?.emit(event: name, payload: payload)
          },
          stopSession: { [weak self] in
            DispatchQueue.main.async { self?.stopRunning() }
          },
          stateChanged: { [weak self] state in
            DispatchQueue.main.async { self?.setRecorderState(state) }
          })
      else {
        throw captureError("ERR_RECORD_REFUSED", reason: RecordRefusal.notWalkBuild.rawValue)
      }
      return host
    }

    /// `os_version` as the bundle manifest writes it: `iOS 26.6.1`, or `iOS 26.7`.
    private static func osVersion() -> String {
      let os = ProcessInfo.processInfo.operatingSystemVersion
      let base = "iOS \(os.majorVersion).\(os.minorVersion)"
      return os.patchVersion > 0 ? base + ".\(os.patchVersion)" : base
    }
  #else
    /// Without the recorder only `record: off` runs.
    private func refuseRecording(_ options: StartOptions) throws {
      if options.record == .off { return }
      throw captureError("ERR_RECORD_REFUSED", reason: "notCompiled")
    }
  #endif

  private static func configuration() -> ARWorldTrackingConfiguration {
    let configuration = ARWorldTrackingConfiguration()
    configuration.worldAlignment = .gravity
    configuration.environmentTexturing = .none
    configuration.providesAudioData = false
    if ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification) {
      configuration.sceneReconstruction = .meshWithClassification
    }
    if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) {
      configuration.frameSemantics.insert(.smoothedSceneDepth)
    }
    return configuration
  }
}

#if USG_RECORDER
  /// `start`'s refusals as the module's error codes (design 3.3): the build's own refusals are
  /// ERR_RECORD_REFUSED with the refusal's name as the reason.
  func refusalError(_ refusal: RecordRefusal) -> Exception {
    switch refusal {
    case .profileUnavailable:
      return captureError("ERR_PROFILE_UNAVAILABLE")
    case .invalidVenues:
      return captureError("ERR_INVALID_VENUES")
    case .lowDisk:
      return captureError("ERR_NO_SPACE")
    case .notCompiled, .debugBuild, .notWalkBuild, .notEmbedded, .devClient:
      return captureError("ERR_RECORD_REFUSED", reason: refusal.rawValue)
    }
  }
#endif

/// Seconds rounded to the microsecond, never negative: a session time.
func sessionSeconds(_ seconds: Double) -> Double {
  guard seconds.isFinite, seconds > 0 else { return 0 }
  return (seconds * 1e6).rounded() / 1e6
}

// MARK: - The delegate

/// The ARSession's delegate (design D4), on `Queues.capture`: every property is read and written
/// only there. An `ARFrame` or `ARAnchor` is read and released within the callback.
///
/// Every frame goes through the candidate gate, as in every capture (ADR 0010), then, with a
/// recording, to the RecorderHost. Marks, tags and a recording's stop wait for the next frame;
/// marks and tags force it to be a candidate. A mark refuses without normal tracking (open
/// question Q11) or without a floor under the screen's centre.
final class CaptureLoop: NSObject, ARSessionDelegate {
  private struct PendingMark {
    let id: Int
    let options: MarkAnchorOptions
    let promise: Promise
  }

  private struct PendingTag {
    let id: Int
    let options: AddTagOptions
    let promise: Promise
  }

  /// How long a mark or tag waits for a frame before it gives up with ERR_TRACKING.
  private static let requestTimeoutS = 2.0
  /// How long a recording's stop waits for a frame before it reads the session's current one.
  private static let stopTimeoutS = 0.5
  /// Emits `status` every 0.2 s, and the debug figures with every fifth.
  private static let statusIntervalS = 0.2
  private static let debugEvery = 5

  private weak var owner: CaptureSession?
  private weak var arSession: ARSession?
  private var running = false
  private var t0 = 0.0
  /// The session time the session stopped at.
  private var endedT = 0.0
  private var fps = 60
  private var covered = true
  private var gate = CandidateGate()
  private var frameRate = RateMeter()
  private var candidateRate = RateMeter()
  private var frames = 0
  private var candidates = 0
  private var meshAnchorIDs = Set<UUID>()
  private var tracking = "notAvailable"
  private var trackingReason: String?
  private var mapping = "notAvailable"
  private var trackingNormal = false
  private var lastFrameT: Double?
  private var gapsTotal = 0
  private var gapMax = 0
  private var lagMs = 0.0
  private var delegateUs = RecentTimings()
  private var statusTimer: DispatchSourceTimer?
  private var statusCount = 0
  private var nextRequestID = 0
  private var pendingMarks: [PendingMark] = []
  private var pendingTags: [PendingTag] = []
  #if USG_RECORDER
    private var host: RecorderHost?
    private var pendingStops: [Promise] = []
    private var stopRound = 0
  #endif

  // MARK: Session lifecycle (capture queue)

  func begin(owner: CaptureSession?, session: ARSession, t0: Double, fps: Int, covered: Bool) {
    self.owner = owner
    arSession = session
    self.t0 = t0
    self.fps = fps
    self.covered = covered
    running = true
    gate = CandidateGate()
    frameRate = RateMeter()
    candidateRate = RateMeter()
    frames = 0
    candidates = 0
    meshAnchorIDs.removeAll()
    tracking = "notAvailable"
    trackingReason = nil
    mapping = "notAvailable"
    trackingNormal = false
    lastFrameT = nil
    gapsTotal = 0
    gapMax = 0
    lagMs = 0
    delegateUs = RecentTimings()
    statusCount = 0
    #if USG_RECORDER
      host = nil
      pendingStops.removeAll()
    #endif
    startStatusTimer()
  }

  #if USG_RECORDER
    /// The session records: its frames, marks, tags, events and stop go to `host`. Right after
    /// `begin`, before the first frame.
    func attach(_ recorder: RecorderHost?) {
      host = recorder
      recorder?.begin()
    }
  #endif

  /// The session stopped at session time `t`; `lastFrame` is the session's current frame, read
  /// on this queue. A recording still open stops on it. Then the last status, and `stopped`.
  func end(at t: Double, lastFrame: ARFrame?) {
    guard running else { return }
    running = false
    endedT = t
    statusTimer?.cancel()
    statusTimer = nil
    for mark in pendingMarks { mark.promise.reject(captureError("ERR_NOT_RUNNING")) }
    for tag in pendingTags { tag.promise.reject(captureError("ERR_NOT_RUNNING")) }
    pendingMarks.removeAll()
    pendingTags.removeAll()
    #if USG_RECORDER
      if let host {
        host.sessionEnded(frame: lastFrame, t: t)
        let stops = pendingStops
        pendingStops.removeAll()
        for promise in stops { resolveStop(promise, t: t, host: host) }
      }
    #endif
    emitStatus(at: t)
    let payload: [String: Any] = ["t": t]
    owner?.emit(event: "stopped", payload: payload)
  }

  func setCovered(_ value: Bool) {
    guard covered != value else { return }
    covered = value
    if running { emitStatus(at: now()) }
  }

  // MARK: Marks, tags and stop (capture queue)

  func requestMark(_ options: MarkAnchorOptions, _ promise: Promise) {
    guard running else {
      promise.reject(captureError("ERR_NOT_RUNNING"))
      return
    }
    nextRequestID += 1
    let id = nextRequestID
    pendingMarks.append(PendingMark(id: id, options: options, promise: promise))
    gate.force()
    Queues.capture.asyncAfter(deadline: .now() + CaptureLoop.requestTimeoutS) { [weak self] in
      self?.expire(id)
    }
  }

  func requestTag(_ options: AddTagOptions, _ promise: Promise) {
    guard running else {
      promise.reject(captureError("ERR_NOT_RUNNING"))
      return
    }
    nextRequestID += 1
    let id = nextRequestID
    pendingTags.append(PendingTag(id: id, options: options, promise: promise))
    gate.force()
    Queues.capture.asyncAfter(deadline: .now() + CaptureLoop.requestTimeoutS) { [weak self] in
      self?.expire(id)
    }
  }

  /// No frame came for a request (the session is interrupted, or ARKit stalled).
  private func expire(_ id: Int) {
    if let index = pendingMarks.firstIndex(where: { $0.id == id }) {
      pendingMarks.remove(at: index).promise.reject(captureError("ERR_TRACKING"))
    }
    if let index = pendingTags.firstIndex(where: { $0.id == id }) {
      pendingTags.remove(at: index).promise.reject(captureError("ERR_TRACKING"))
    }
  }

  #if USG_RECORDER
    /// A recording session's `stop`: handled on the next frame, or on the session's current
    /// frame if none comes within half a second; it resolves once the recording settled.
    /// `fallbackT` is the session time the main queue saw, for a session already stopped.
    func requestStop(_ promise: Promise, fallbackT: Double) {
      guard let host else {
        let result: [String: Any] = ["t": fallbackT, "recording": NSNull()]
        promise.resolve(result)
        return
      }
      guard running else {
        resolveStop(promise, t: endedT, host: host)
        return
      }
      pendingStops.append(promise)
      guard pendingStops.count == 1 else { return }
      stopRound += 1
      let round = stopRound
      Queues.capture.asyncAfter(deadline: .now() + CaptureLoop.stopTimeoutS) { [weak self] in
        self?.stopTimedOut(round)
      }
    }

    private func stopTimedOut(_ round: Int) {
      guard running, round == stopRound, !pendingStops.isEmpty else { return }
      let frame = arSession?.currentFrame
      let t = frame.map { sessionSeconds($0.timestamp - t0) } ?? now()
      handleStops(frame: frame, t: t)
    }

    /// The recorder stops on `frame`, then the session stops; the promises resolve once the
    /// recording settled.
    private func handleStops(frame: ARFrame?, t: Double) {
      guard let host else { return }
      let stops = pendingStops
      pendingStops.removeAll()
      stopRound += 1
      host.stop(frame: frame, t: t)
      for promise in stops { resolveStop(promise, t: t, host: host) }
      owner?.stopAfterRecorder()
    }

    private func resolveStop(_ promise: Promise, t: Double, host: RecorderHost) {
      host.whenSettled { outcome in
        if case .failed = outcome {
          promise.reject(captureError("ERR_IO"))
        } else {
          let result: [String: Any] = ["t": t, "recording": outcome.value]
          promise.resolve(result)
        }
      }
    }
  #endif

  /// TypeScript's boundary lines, for the recording if there is one.
  func appendBoundary(_ lines: [String], final: Bool) {
    #if USG_RECORDER
      host?.boundary(lines, final: final)
    #endif
  }

  private func serviceRequests(_ session: ARSession, _ frame: ARFrame, t: Double, index: Int) {
    let camera = frame.camera.transform
    let cameraValues = matrixValues(camera)
    let marks = pendingMarks
    let tags = pendingTags
    pendingMarks.removeAll()
    pendingTags.removeAll()

    for mark in marks {
      guard trackingNormal else {
        recordAction(.markAnchor, t: t, args: mark.options.arguments, error: "ERR_TRACKING")
        mark.promise.reject(captureError("ERR_TRACKING"))
        continue
      }
      // The floor under the screen's centre: normalised image coordinates, so the centre whatever
      // the orientation.
      let query = frame.raycastQuery(
        from: CGPoint(x: 0.5, y: 0.5), allowing: .estimatedPlane, alignment: .horizontal)
      guard let hit = session.raycast(query).first else {
        recordAction(.markAnchor, t: t, args: mark.options.arguments, error: "ERR_NO_FLOOR_HIT")
        mark.promise.reject(captureError("ERR_NO_FLOOR_HIT"))
        continue
      }
      let anchor = ARAnchor(
        name: "usg.marked.\(mark.options.role.rawValue)", transform: hit.worldTransform)
      session.add(anchor: anchor)
      // The recorder handles the mark on this frame: the first start mark opens the recording.
      #if USG_RECORDER
        let window = host?.marked(mark.options, frame: frame) ?? "not_open"
      #else
        let window = "not_open"
      #endif
      let columns = hit.worldTransform.columns
      let hitValues: [String: Any] = [
        "point": [Double(columns.3.x), Double(columns.3.y), Double(columns.3.z)],
        // The hit's y axis: the floor's normal.
        "normal": [Double(columns.1.x), Double(columns.1.y), Double(columns.1.z)],
        "transform": matrixValues(hit.worldTransform),
      ]
      let facing: Any
      if let direction = horizontalFacing(camera) {
        let values: [Double] = [direction.x, 0, direction.z]
        facing = values
      } else {
        facing = NSNull()
      }
      let result: [String: Any] = [
        "t": t,
        "frame": index,
        "anchorId": anchor.identifier.uuidString.lowercased(),
        "hit": hitValues,
        "facing": facing,
        "camera": cameraValues,
        "window": window,
      ]
      recordAction(.markAnchor, t: t, args: mark.options.arguments, result: result)
      mark.promise.resolve(result)
    }

    for tag in tags {
      guard trackingNormal else {
        recordAction(.addTag, t: t, args: tag.options.arguments, error: "ERR_TRACKING")
        tag.promise.reject(captureError("ERR_TRACKING"))
        continue
      }
      let position = camera.columns.3
      let result: [String: Any] = [
        "t": t,
        "frame": index,
        "position": [Double(position.x), Double(position.y), Double(position.z)],
        "camera": cameraValues,
      ]
      recordAction(.addTag, t: t, args: tag.options.arguments, result: result)
      tag.promise.resolve(result)
    }
  }

  /// A session call's line in actions.jsonl, while a recording is open.
  private func recordAction(
    _ call: CallName, t: Double, args: [String: Any], result: [String: Any]? = nil,
    error: String? = nil
  ) {
    #if USG_RECORDER
      guard let host else { return }
      switch call {
      case .markAnchor: host.recordAction(.markAnchor, t: t, args: args, result: result, error: error)
      case .addTag: host.recordAction(.addTag, t: t, args: args, result: result, error: error)
      }
    #endif
  }

  /// The calls the delegate resolves on a frame.
  private enum CallName {
    case markAnchor
    case addTag
  }

  // MARK: ARSessionDelegate (capture queue)

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    guard running else { return }
    let started = CACurrentMediaTime()
    let t = sessionSeconds(frame.timestamp - t0)
    let index = frames
    frames += 1
    frameRate.tick(t)
    if let lastFrameT {
      let skipped = framesSkipped(previousT: lastFrameT, t: t, fps: fps)
      gapsTotal += skipped
      gapMax = max(gapMax, skipped)
    }
    lastFrameT = t
    lagMs = max(0, (ProcessInfo.processInfo.systemUptime - frame.timestamp) * 1000)

    let camera = frame.camera
    switch camera.trackingState {
    case .normal:
      tracking = "normal"
      trackingReason = nil
      trackingNormal = true
    case .notAvailable:
      tracking = "notAvailable"
      trackingReason = nil
      trackingNormal = false
    case .limited(let reason):
      tracking = "limited"
      trackingReason = trackingReasonName(reason)
      trackingNormal = false
    }
    mapping = mappingName(frame.worldMappingStatus)

    // The gate first: a mark or tag forced this frame to be a candidate.
    let gateStarted = CACurrentMediaTime()
    let trigger = gate.offer(
      t: t, transform: WorldTransform(camera.transform), trackingNormal: trackingNormal)
    if trigger != nil {
      candidates += 1
      candidateRate.tick(t)
    }
    // Then the recorder sees the frame, so a mark handled on it opens or ends the window there.
    #if USG_RECORDER
      if let host {
        let gateMs = (CACurrentMediaTime() - gateStarted) * 1000
        host.frame(frame, index: index, candidate: trigger != nil, gateMs: gateMs)
      }
    #else
      _ = gateStarted
    #endif
    if !pendingMarks.isEmpty || !pendingTags.isEmpty {
      serviceRequests(session, frame, t: t, index: index)
    }
    #if USG_RECORDER
      if !pendingStops.isEmpty {
        handleStops(frame: frame, t: t)
      }
    #endif
    delegateUs.add((CACurrentMediaTime() - started) * 1e6, at: t)
  }

  func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
    guard running else { return }
    for anchor in anchors where anchor is ARMeshAnchor {
      meshAnchorIDs.insert(anchor.identifier)
      #if USG_RECORDER
        host?.meshUpdated(anchor.identifier)
      #endif
    }
  }

  func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
    guard running else { return }
    #if USG_RECORDER
      guard let host else { return }
      for anchor in anchors where anchor is ARMeshAnchor {
        host.meshUpdated(anchor.identifier)
      }
    #endif
  }

  func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
    for anchor in anchors {
      meshAnchorIDs.remove(anchor.identifier)
      #if USG_RECORDER
        if running, anchor is ARMeshAnchor { host?.meshRemoved(anchor.identifier) }
      #endif
    }
  }

  func session(_ session: ARSession, didFailWithError error: Error) {
    // ARKit's error code is a number from a fixed list: no value of the session.
    let code = (error as NSError).code
    captureLog.error("session failed with ARKit error \(code, privacy: .public)")
    LogRing.shared.add("session_failed")
    guard running else { return }
    #if USG_RECORDER
      host?.event(.sessionFailed(code: code))
    #endif
    let payload: [String: Any] = ["t": now(), "kind": "sessionFailed", "code": code]
    owner?.emit(event: "warning", payload: payload)
    owner?.sessionFailed()
  }

  func sessionWasInterrupted(_ session: ARSession) {
    guard running else { return }
    #if USG_RECORDER
      host?.event(.interruptionBegan)
    #endif
    let payload: [String: Any] = ["t": now(), "kind": "interrupted"]
    owner?.emit(event: "warning", payload: payload)
  }

  func sessionInterruptionEnded(_ session: ARSession) {
    guard running else { return }
    #if USG_RECORDER
      host?.event(.interruptionEnded)
    #endif
    let payload: [String: Any] = ["t": now(), "kind": "interruptionEnded"]
    owner?.emit(event: "warning", payload: payload)
  }

  // MARK: Status (capture queue)

  private func startStatusTimer() {
    statusTimer?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: Queues.capture)
    timer.schedule(
      deadline: .now() + CaptureLoop.statusIntervalS, repeating: CaptureLoop.statusIntervalS,
      leeway: .milliseconds(20))
    timer.setEventHandler { [weak self] in
      guard let self, self.running else { return }
      self.emitStatus(at: self.now())
    }
    statusTimer = timer
    timer.resume()
  }

  private func now() -> Double {
    sessionSeconds(ProcessInfo.processInfo.systemUptime - t0)
  }

  private func emitStatus(at t: Double) {
    statusCount += 1
    let off: [String: Any] = [
      "state": "off",
      "degradation": NSNull(),
      "closingInS": NSNull(),
    ]
    #if USG_RECORDER
      let recorder = host?.statusValue() ?? off
    #else
      let recorder = off
    #endif
    var status: [String: Any] = [
      "t": t,
      "running": running,
      "covered": covered,
      "tracking": tracking,
      "mapping": mapping,
      // A stopped session has no rate, whatever the last second held.
      "fps": running ? frameRate.rate(at: t) : 0.0,
      "candidateHz": running ? candidateRate.rate(at: t) : 0.0,
      "frames": frames,
      "candidates": candidates,
      "meshAnchors": meshAnchorIDs.count,
      "thermal": thermalStateName(ProcessInfo.processInfo.thermalState),
      "recorder": recorder,
    ]
    if let trackingReason {
      status["trackingReason"] = trackingReason
    }
    if statusCount % CaptureLoop.debugEvery == 0 {
      status["debug"] = debugFigures(at: t)
    }
    owner?.emit(event: "status", payload: status)
  }

  /// The debug card's figures (design 13): counts and timings, never a pose or a time of day.
  private func debugFigures(at t: Double) -> [String: Any] {
    let timings = delegateUs.percentiles(at: t)
    let figures: [String: Any] = [
      "delegateP50Us": timings.p50,
      "delegateP95Us": timings.p95,
      "gapsTotal": gapsTotal,
      "gapMax": gapMax,
      "deliveryLagMs": (lagMs * 10).rounded() / 10,
    ]
    #if USG_RECORDER
      if let host {
        return figures.merging(host.debugFigures()) { mine, _ in mine }
      }
    #endif
    return figures
  }
}

/// Durations over the last second, for the delegate's p50 and p95.
private struct RecentTimings {
  private var samples: [(t: Double, value: Double)] = []

  mutating func add(_ value: Double, at t: Double) {
    guard value.isFinite, value >= 0 else { return }
    samples.append((t, value))
    if samples.count > 512 { samples.removeFirst(samples.count - 512) }
  }

  mutating func percentiles(at t: Double) -> (p50: Double, p95: Double) {
    samples.removeAll { $0.t <= t - 1 }
    let values = samples.map { $0.value }.sorted()
    guard !values.isEmpty else { return (0, 0) }
    func rank(_ percent: Int) -> Double {
      let index = max(1, (percent * values.count + 99) / 100) - 1
      return (values[index] * 10).rounded() / 10
    }
    return (rank(50), rank(95))
  }
}

/// A transform's 16 values, column-major, as ARKit's simd_float4x4.
private func matrixValues(_ matrix: simd_float4x4) -> [Double] {
  let c = matrix.columns
  return [
    c.0.x, c.0.y, c.0.z, c.0.w,
    c.1.x, c.1.y, c.1.z, c.1.w,
    c.2.x, c.2.y, c.2.z, c.2.w,
    c.3.x, c.3.y, c.3.z, c.3.w,
  ].map { Double($0) }
}

/// The camera's horizontal facing, as CaptureCore's Facing gives it for a recording: its −z axis
/// projected onto y = 0 and normalised, or nil within about 11.5° of straight up or down.
private func horizontalFacing(_ camera: simd_float4x4) -> (x: Double, z: Double)? {
  let x = -Double(camera.columns.2.x)
  let z = -Double(camera.columns.2.z)
  let length = (x * x + z * z).squareRoot()
  guard length.isFinite, length >= 0.2 else { return nil }
  return (x / length, z / length)
}

extension WorldTransform {
  /// ARKit's column-major matrix as CaptureCore's 16 floats.
  init(_ matrix: simd_float4x4) {
    let c = matrix.columns
    self.init(columnMajor: [
      c.0.x, c.0.y, c.0.z, c.0.w,
      c.1.x, c.1.y, c.1.z, c.1.w,
      c.2.x, c.2.y, c.2.z, c.2.w,
      c.3.x, c.3.y, c.3.z, c.3.w,
    ])
  }
}

private func trackingReasonName(_ reason: ARCamera.TrackingState.Reason) -> String {
  switch reason {
  case .initializing: return "initializing"
  case .excessiveMotion: return "excessiveMotion"
  case .insufficientFeatures: return "insufficientFeatures"
  case .relocalizing: return "relocalizing"
  @unknown default: return "unknown"
  }
}

private func mappingName(_ status: ARFrame.WorldMappingStatus) -> String {
  switch status {
  case .notAvailable: return "notAvailable"
  case .limited: return "limited"
  case .extending: return "extending"
  case .mapped: return "mapped"
  @unknown default: return "unknown"
  }
}
