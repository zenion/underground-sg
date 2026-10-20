import ARKit
import CaptureCore
import ExpoModulesCore
import RealityKit
import UIKit

/// `<CaptureView>`: the camera with the live mesh over it, inside the privacy shield, and the
/// ARSession behind it (ADR 0007). The session starts on `start()`, when the mapper taps Start,
/// never when the view mounts, and stops on `stop()` or when the view leaves the window.
///
/// Every frame goes through the candidate gate here, as in every capture (ADR 0010), but nothing
/// is written yet and nothing per frame crosses into JavaScript: `onStatus` sends counts, rates
/// and states at 5 Hz, never a pose. The `ARFrame` is read and released within the delegate call.
final class CaptureView: ExpoView, ARSessionDelegate {
  let onStatus = EventDispatcher()
  let onWarning = EventDispatcher()

  private let shield = PrivacyShield(frame: .zero)
  private var arView: ARView?
  private var running = false
  private var statusTimer: Timer?
  private var gate = CandidateGate()
  private var frameRate = RateMeter()
  private var candidateRate = RateMeter()
  private var frames = 0
  private var candidates = 0
  private var meshAnchors = 0
  private var tracking = "notAvailable"
  private var trackingReason: String?
  private var mapping = "notAvailable"

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    addSubview(shield)
    shield.onScreenshot = { [weak self] in self?.screenshotTaken() }
    shield.onCoveredChange = { [weak self] _ in self?.emitStatus() }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    shield.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      stop()
      tearDown()
    }
  }

  func start() throws {
    if running { return }
    guard ARWorldTrackingConfiguration.isSupported else {
      throw WorldTrackingUnsupportedException()
    }
    guard let container = shield.secureContent else {
      throw ScreenshotShieldUnavailableException()
    }
    let view = arView ?? makeARView(in: container)

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

    gate = CandidateGate()
    frameRate = RateMeter()
    candidateRate = RateMeter()
    frames = 0
    candidates = 0
    meshAnchors = 0
    view.session.delegate = self
    view.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
    running = true
    UIApplication.shared.isIdleTimerDisabled = true
    startStatusTimer()
    captureLog.info("session started")
  }

  func stop() {
    guard running else { return }
    arView?.session.pause()
    running = false
    UIApplication.shared.isIdleTimerDisabled = false
    statusTimer?.invalidate()
    statusTimer = nil
    emitStatus()
    captureLog.info("session stopped")
  }

  private func tearDown() {
    arView?.session.delegate = nil
    arView?.removeFromSuperview()
    arView = nil
  }

  private func makeARView(in container: UIView) -> ARView {
    let view = ARView(frame: container.bounds, cameraMode: .ar, automaticallyConfigureSession: false)
    view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    // Less GPU work and heat: none of these help a mapper.
    view.renderOptions = [
      .disableMotionBlur, .disableDepthOfField, .disableHDR, .disableCameraGrain,
      .disableGroundingShadows, .disablePersonOcclusion, .disableAREnvironmentLighting,
    ]
    // The live mesh: RealityKit draws the reconstructed mesh over the camera.
    view.debugOptions = [.showSceneUnderstanding]
    container.addSubview(view)
    arView = view
    return view
  }

  // MARK: - ARSessionDelegate (on the main queue: the session's delegateQueue is nil)

  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    let t = frame.timestamp
    frames += 1
    frameRate.tick(t)
    let camera = frame.camera
    var normal = false
    switch camera.trackingState {
    case .normal:
      tracking = "normal"
      trackingReason = nil
      normal = true
    case .notAvailable:
      tracking = "notAvailable"
      trackingReason = nil
    case .limited(let reason):
      tracking = "limited"
      trackingReason = trackingReasonName(reason)
    }
    mapping = mappingName(frame.worldMappingStatus)
    if gate.offer(t: t, transform: Transform(camera.transform), trackingNormal: normal) != nil {
      candidates += 1
      candidateRate.tick(t)
    }
  }

  func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
    meshAnchors += anchors.reduce(0) { $0 + ($1 is ARMeshAnchor ? 1 : 0) }
  }

  func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
    meshAnchors -= anchors.reduce(0) { $0 + ($1 is ARMeshAnchor ? 1 : 0) }
  }

  func session(_ session: ARSession, didFailWithError error: Error) {
    let code = (error as NSError).code
    captureLog.error("session failed with ARKit error \(code, privacy: .public)")
    stop()
    onWarning(["kind": "sessionFailed", "code": code])
  }

  func sessionWasInterrupted(_ session: ARSession) {
    onWarning(["kind": "interrupted"])
  }

  func sessionInterruptionEnded(_ session: ARSession) {
    onWarning(["kind": "interruptionEnded"])
  }

  // MARK: - Status and warnings

  private func startStatusTimer() {
    statusTimer?.invalidate()
    let timer = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in
      self?.emitStatus()
    }
    RunLoop.main.add(timer, forMode: .common)
    statusTimer = timer
  }

  private func emitStatus() {
    // ARFrame times are on the system uptime clock.
    let now = ProcessInfo.processInfo.systemUptime
    var status: [String: Any] = [
      "running": running,
      "covered": shield.isCovered,
      "tracking": tracking,
      "mapping": mapping,
      "fps": frameRate.rate(at: now),
      "candidateHz": candidateRate.rate(at: now),
      "frames": frames,
      "candidates": candidates,
      "meshAnchors": meshAnchors,
      "thermal": thermalStateName(ProcessInfo.processInfo.thermalState),
    ]
    if let trackingReason {
      status["trackingReason"] = trackingReason
    }
    onStatus(status)
  }

  private func screenshotTaken() {
    // Only a screenshot taken while the camera runs could have caught it.
    guard running else { return }
    captureLog.notice("screenshot taken during a capture")
    onWarning(["kind": "screenshot"])
  }
}

extension Transform {
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

final class WorldTrackingUnsupportedException: Exception, @unchecked Sendable {
  override var reason: String {
    "ARKit world tracking isn't supported on this device"
  }
}

final class ScreenshotShieldUnavailableException: Exception, @unchecked Sendable {
  override var reason: String {
    "This iOS version offers no way to keep the camera out of screenshots, so the camera stays off"
  }
}
