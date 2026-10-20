import UIKit

/// Keeps the live camera view out of everything iOS saves or shares (ADR 0005, ADR 0010, "The
/// camera view, iOS's snapshot and screenshots"):
///
/// - The camera goes inside the canvas of a secure-entry text field, whose contents iOS leaves
///   out of screenshots and screen recordings. Apple doesn't document this, so the device check
///   (spike criterion 5) confirms it on the iOS in use. Without such a canvas there is nowhere
///   safe to show the camera, and `secureContent` is nil: the capture view then refuses to start.
/// - An opaque cover goes over the camera whenever the scene isn't foreground-active, so it is in
///   place before iOS takes the app-switcher snapshot, and while the screen is being recorded or
///   mirrored.
/// - A screenshot taken anyway is reported through `onScreenshot`, so the app can ask the owner to
///   delete it.
///
/// Scene-aware: it follows the scene of the window it is in, never a key window or the app
/// delegate.
final class PrivacyShield: UIView {
  /// Where the camera view goes, or nil when this iOS has no secure canvas.
  let secureContent: UIView?
  var onScreenshot: (() -> Void)?
  var onCoveredChange: ((Bool) -> Void)?
  private(set) var isCovered = true

  /// Kept alive: its secure-entry state is what keeps the canvas out of captures.
  private let field = UITextField()
  private let cover = CoverView()
  private weak var observedScene: UIWindowScene?

  override init(frame: CGRect) {
    field.isSecureTextEntry = true
    field.isUserInteractionEnabled = false
    secureContent = PrivacyShield.secureCanvas(of: field)
    super.init(frame: frame)
    backgroundColor = .black
    if let secureContent {
      secureContent.subviews.forEach { $0.removeFromSuperview() }
      secureContent.backgroundColor = .black
      secureContent.isUserInteractionEnabled = true
      addSubview(secureContent)
    }
    addSubview(cover)
    applyCover(true)

    NotificationCenter.default.addObserver(
      self, selector: #selector(screenshotTaken),
      name: UIApplication.userDidTakeScreenshotNotification, object: nil)
    NotificationCenter.default.addObserver(
      self, selector: #selector(refresh), name: UIScreen.capturedDidChangeNotification, object: nil)
    if #available(iOS 17.0, *) {
      registerForTraitChanges([UITraitSceneCaptureState.self], action: #selector(refresh))
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    secureContent?.frame = bounds
    cover.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    observe(window?.windowScene)
  }

  /// The secure text field's canvas: the subview it draws its text into.
  private static func secureCanvas(of field: UITextField) -> UIView? {
    func find() -> UIView? {
      field.subviews.first { String(describing: type(of: $0)).contains("CanvasView") }
        ?? (field.layer.sublayers?.first?.delegate as? UIView)
    }
    if let canvas = find() { return canvas }
    field.layoutIfNeeded()
    return find()
  }

  private func observe(_ scene: UIWindowScene?) {
    if scene !== observedScene {
      let center = NotificationCenter.default
      if let old = observedScene {
        for name in [
          UIScene.willDeactivateNotification, UIScene.didEnterBackgroundNotification,
          UIScene.didActivateNotification,
        ] {
          center.removeObserver(self, name: name, object: old)
        }
      }
      observedScene = scene
      if let scene {
        // Selector observers run on the posting thread before the post returns, so the cover is
        // up before iOS takes its snapshot.
        center.addObserver(
          self, selector: #selector(coverNow), name: UIScene.willDeactivateNotification,
          object: scene)
        center.addObserver(
          self, selector: #selector(coverNow), name: UIScene.didEnterBackgroundNotification,
          object: scene)
        center.addObserver(
          self, selector: #selector(refresh), name: UIScene.didActivateNotification, object: scene)
      }
    }
    refresh()
  }

  @objc private func coverNow() {
    applyCover(true)
  }

  /// Uncovers only in a foreground-active scene whose screen isn't being captured.
  @objc private func refresh() {
    guard let scene = observedScene else {
      applyCover(true)
      return
    }
    applyCover(scene.activationState != .foregroundActive || isCaptured(scene))
  }

  private func isCaptured(_ scene: UIWindowScene) -> Bool {
    if #available(iOS 17.0, *), scene.traitCollection.sceneCaptureState == .active {
      return true
    }
    return scene.screen.isCaptured
  }

  private func applyCover(_ covered: Bool) {
    cover.isHidden = !covered
    // Nothing for a snapshot to find under the cover either.
    secureContent?.isHidden = covered
    if covered != isCovered {
      isCovered = covered
      onCoveredChange?(covered)
    }
  }

  @objc private func screenshotTaken() {
    onScreenshot?()
  }
}

/// The opaque cover: black, with a line saying why.
private final class CoverView: UIView {
  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    isOpaque = true
    let label = UILabel()
    label.text = "Camera hidden"
    label.textColor = .lightGray
    label.font = .preferredFont(forTextStyle: .footnote)
    label.translatesAutoresizingMaskIntoConstraints = false
    addSubview(label)
    NSLayoutConstraint.activate([
      label.centerXAnchor.constraint(equalTo: centerXAnchor),
      label.centerYAnchor.constraint(equalTo: centerYAnchor),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }
}
