import ARKit
import ExpoModulesCore
import RealityKit
import UIKit

/// `<CaptureView>`: renders the camera with the live mesh over it, inside the privacy shield, for
/// the CaptureSession its `session` prop names (the lean recorder design, D4). The view only
/// renders and attaches: the session runs the ARView's own ARSession, starts it on `start`, never
/// when the view mounts, and stops it on `stop`, when the prop changes or when the view leaves
/// its window. A red REC badge, driven on the main queue from the session's recorder state,
/// mirrors the walk screen's.
final class CaptureView: ExpoView {
  private let shield = PrivacyShield(frame: .zero)
  private let badge = RecordingBadge()
  private var arView: ARView?
  /// The session the `session` prop names. The session holds this view weakly.
  private var session: CaptureSession?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    addSubview(shield)
    addSubview(badge)
    badge.isHidden = true
    shield.onScreenshot = { [weak self] in self?.screenshotTaken() }
    shield.onCoveredChange = { [weak self] covered in self?.session?.coverChanged(covered) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    shield.frame = bounds
    let size = badge.intrinsicContentSize
    badge.frame = CGRect(x: 8, y: 8, width: size.width, height: size.height)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      session?.viewLeftWindow(self)
      tearDown()
    }
  }

  // MARK: The session prop

  /// The `session` prop: attaches the named session, detaching the one before.
  func attach(_ next: CaptureSession?) {
    if next === session { return }
    let previous = session
    session = next
    previous?.detach(view: self)
    if let next {
      next.attach(view: self)
    } else {
      showRecorderState("off")
    }
  }

  /// The session was attached to another view.
  func sessionWasDetached(_ old: CaptureSession) {
    guard session === old else { return }
    session = nil
    showRecorderState("off")
  }

  // MARK: For the session (main)

  /// Whether the shield's cover is over the camera.
  var isCovered: Bool { shield.isCovered }

  /// The ARView inside the shield's secure canvas, made on first use, or nil when this iOS has
  /// no secure canvas: there is then nowhere safe to show the camera (ADR 0010).
  func prepareCamera() -> ARView? {
    if let arView { return arView }
    guard let container = shield.secureContent else { return nil }
    return makeARView(in: container)
  }

  func cameraStarted() {
    arView?.isHidden = false
  }

  /// A paused ARView keeps showing its last camera frame: hidden until the next start.
  func cameraStopped() {
    arView?.isHidden = true
  }

  /// REC while a recording window is open, closing or being saved.
  func showRecorderState(_ state: String) {
    badge.isHidden = !(state == "open" || state == "closing" || state == "finalizing")
  }

  // MARK: Private

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
    view.isHidden = true
    container.addSubview(view)
    arView = view
    return view
  }

  private func screenshotTaken() {
    // Only a screenshot taken while camera pixels were on screen could hold them: the ARView is
    // shown (it is hidden whenever the session is stopped) and not under the cover.
    guard let arView, !arView.isHidden, !shield.isCovered else { return }
    captureNote("screenshot_during_capture")
    session?.screenshotTaken()
  }
}

/// The native REC badge: white on red, in the top-left corner, above the cover.
private final class RecordingBadge: UILabel {
  override init(frame: CGRect) {
    super.init(frame: frame)
    text = "REC"
    textColor = .white
    backgroundColor = .systemRed
    font = .boldSystemFont(ofSize: 12)
    textAlignment = .center
    layer.cornerRadius = 4
    layer.masksToBounds = true
    isUserInteractionEnabled = false
    accessibilityLabel = "Recording"
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override var intrinsicContentSize: CGSize {
    let size = super.intrinsicContentSize
    return CGSize(width: size.width + 12, height: size.height + 6)
  }
}
