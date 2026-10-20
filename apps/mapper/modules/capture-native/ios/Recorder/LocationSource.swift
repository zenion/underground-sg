#if USG_RECORDER
  import CaptureCore
  import CoreLocation
  import Foundation

  /// Core Location for the recorder's GNSS windows (ADR 0010; the lean recorder design, D14, D15
  /// and section 5): the best accuracy, no distance filter, no automatic pause, from `start` to
  /// the recording's close. Each fix becomes a GnssFix whose `t` is the session time now less
  /// the fix's age (D15: only the age comes from the wall clock), and goes to the capture queue,
  /// where GnssWindows keeps it in memory and writes it only inside a window at a street-facing
  /// anchor.
  ///
  /// It needs a RecordingGrant, which only the walk build gets, so the development build never
  /// creates a CLLocationManager (and has no usage key, so Location Services never lists it). It
  /// never asks for authorization itself: `requestRecorderPermissions` does, before the walk.
  /// Main queue only. Never logs a fix, a time or an accuracy.
  final class LocationSource: NSObject, CLLocationManagerDelegate {
    private let manager: CLLocationManager
    private let clock: SessionClock
    private let deliver: (GnssFix) -> Void
    /// Whether the recorder wants fixes now.
    private var wanted = false
    private var updating = false

    /// Nil unless the grant is the phone's own (a synthetic grant never reaches here, but it is
    /// checked anyway, design section 2).
    init?(grant: RecordingGrant, clock: SessionClock, deliver: @escaping (GnssFix) -> Void) {
      guard grant.origin == .device else { return nil }
      manager = CLLocationManager()
      self.clock = clock
      self.deliver = deliver
      super.init()
      manager.desiredAccuracy = kCLLocationAccuracyBest
      manager.distanceFilter = kCLDistanceFilterNone
      manager.pausesLocationUpdatesAutomatically = false
      manager.activityType = .fitness
      manager.delegate = self
    }

    /// Starts updates if the owner allowed location; otherwise waits for that answer.
    func start() {
      wanted = true
      updateIfAllowed()
    }

    func stop() {
      wanted = false
      if updating {
        updating = false
        manager.stopUpdatingLocation()
      }
    }

    private func updateIfAllowed() {
      guard wanted, !updating else { return }
      switch manager.authorizationStatus {
      case .authorizedWhenInUse, .authorizedAlways:
        updating = true
        manager.startUpdatingLocation()
      case .notDetermined, .denied, .restricted:
        break
      @unknown default:
        break
      }
    }

    // MARK: CLLocationManagerDelegate (main queue: the manager was made there)

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
      updateIfAllowed()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
      guard updating else { return }
      let nowUptime = ProcessInfo.processInfo.systemUptime
      let nowWall = Date()
      for location in locations {
        let age = nowWall.timeIntervalSince(location.timestamp)
        guard let t = clock.t(fixAgeS: age, nowUptime: nowUptime) else { continue }
        let coordinate = location.coordinate
        deliver(
          GnssFix(
            t: t, lat: coordinate.latitude, lon: coordinate.longitude,
            horizontalAccuracyM: location.horizontalAccuracy))
      }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
      // Core Location's error code only; never the error's text.
      captureLog.notice(
        "location failed with CLError \((error as NSError).code, privacy: .public)")
    }
  }
#endif
