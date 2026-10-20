#if USG_RECORDER
  import CaptureCore
  import CaptureIO
  import CoreLocation
  import CoreMotion
  import ExpoModulesCore
  import Foundation
  import UIKit

  /// The recorder's plumbing (the lean recorder design, sections 3.3, 7, 9 and 11): what runs
  /// outside a capture. The shared RecordingStore with the phone's FileSecurity, recovery at
  /// launch, and the module's recorder functions: list, export (with progress through the
  /// module's `exportProgress` event), delete, the self-test and the permission prompts. Each
  /// runs on `Queues.store`, one at a time, recovery first.
  ///
  /// The development build lists, deletes, recovers and runs the self-test, but never exports,
  /// keeps a self-test set or asks for location: those need a grant, which only the walk build
  /// gets (design 11). Everything it reports is counts, sizes, durations, ages in days, states
  /// and codes.
  final class RecorderPlumbing: @unchecked Sendable {
    static let shared = RecorderPlumbing()

    /// Whether `start` can record yet. RecorderHost, which runs a recording, lands with the rest
    /// of design PR5; until then `canRecord` is false and `start` refuses a profile.
    static let recorderWired = false

    /// A well-formed venue id, for the decisions that are about the build alone (export, the
    /// self-test's set, the permission prompts, `canRecord`). The venues are chosen at `start`,
    /// which decides again with the real ones.
    private static let placeholderVenue = "00000000-0000-4000-8000-000000000000"

    let security: DarwinFileSecurity
    let store: RecordingStore
    let probe: DeviceProbe

    private let lock = NSLock()
    /// Guarded by `lock`.
    private var recovery = RecoveryReport()
    private var recoveryRunning = false
    /// Main queue only.
    private var launched = false
    private var permissionRequest: PermissionRequest?

    private init() {
      let fm = FileManager.default
      let home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
      let support =
        fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        ?? home.appendingPathComponent("Library/Application Support", isDirectory: true)
      let documents =
        fm.urls(for: .documentDirectory, in: .userDomainMask).first
        ?? home.appendingPathComponent("Documents", isDirectory: true)
      let security = DarwinFileSecurity()
      let store = RecordingStore(
        paths: RecordingPaths(applicationSupport: support, documents: documents),
        security: security)
      self.security = security
      self.store = store
      probe = DeviceProbe(store: store)
    }

    // MARK: - Launch

    /// At launch (the module's OnCreate): the walk build's log guard, then recovery as soon as
    /// protected data is available, and again at each unlock until it has run.
    func launch() {
      DispatchQueue.main.async {
        guard !self.launched else { return }
        self.launched = true
        LogGuard.installIfWalkBuild()
        self.security.startObserving { [weak self] in
          self?.scheduleRecovery()
        }
        self.scheduleRecovery()
      }
    }

    /// Runs RecoveryRunner on the store queue, unless it has run or is running. Ahead of any
    /// list, export, delete or self-test queued after it; `start` refuses to record until it is
    /// done (ERR_RECOVERY_PENDING).
    func scheduleRecovery() {
      guard security.protectedDataAvailable else { return }
      lock.lock()
      let skip = recovery.done || recoveryRunning
      if !skip { recoveryRunning = true }
      lock.unlock()
      if skip { return }
      Queues.store.async {
        let report = RecoveryRunner(store: self.store).run()
        self.lock.lock()
        self.recoveryRunning = false
        if report.done { self.recovery = report }
        self.lock.unlock()
        if report.done {
          captureNote("recovery_done")
        } else {
          captureNote("recovery_waiting")
        }
      }
    }

    var recoveryDone: Bool {
      lock.lock()
      defer { lock.unlock() }
      return recovery.done
    }

    func recoveryStatus() -> [String: Any] {
      lock.lock()
      let report = recovery
      lock.unlock()
      return [
        "done": report.done,
        "recovered": report.recovered,
        "finished": report.finished,
        "discarded": report.discarded,
        "swept": report.swept,
        "exportsCompleted": report.exportsCompleted,
        "exportsRemoved": report.exportsRemoved,
        "failed": report.failed,
      ]
    }

    // MARK: - Decisions

    /// `getCapabilities().recorder`: whether `start({ record: "lean" })` would be granted now.
    func recorderCapabilities() -> [String: Any] {
      var canRecord = false
      var refusal: Any = NSNull()
      switch RecordPermission.decide(
        profile: .lean, facts: .current, venues: [RecorderPlumbing.placeholderVenue],
        freeDiskBytes: store.freeBytes())
      {
      case .granted:
        if RecorderPlumbing.recorderWired {
          canRecord = true
        } else {
          refusal = RecordRefusal.profileUnavailable.rawValue
        }
      case .refused(let reason):
        refusal = reason.rawValue
      case .off:
        break
      }
      var profile: Any = NSNull()
      if let value = AppBuild.profile { profile = value }
      return ["compiled": true, "canRecord": canRecord, "refusal": refusal, "buildProfile": profile]
    }

    /// The walk build's grant, decided on the build alone, or nil in any other build.
    func buildGrant() -> RecordingGrant? {
      if case .granted(let grant) = RecordPermission.decide(
        profile: .lean, facts: .current, venues: [RecorderPlumbing.placeholderVenue],
        freeDiskBytes: Int64.max)
      {
        return grant
      }
      return nil
    }

    /// Why this build gets no grant, or nil in the walk build.
    func buildRefusal() -> RecordRefusal? {
      if case .refused(let refusal) = RecordPermission.decide(
        profile: .lean, facts: .current, venues: [RecorderPlumbing.placeholderVenue],
        freeDiskBytes: Int64.max)
      {
        return refusal
      }
      return nil
    }

    // MARK: - List and delete

    func listRecordings(_ promise: Promise) {
      Queues.store.async {
        let rows: [[String: Any]] = self.store.list().map(RecorderPlumbing.summaryValue)
        promise.resolve(rows)
      }
    }

    /// Removes the raw recording, its export and its journal. Refuses one being written,
    /// exported or recovered (ERR_RECORDING_BUSY); an id that isn't there is already gone.
    func deleteRecording(_ id: String, _ promise: Promise) {
      Queues.store.async {
        guard let uuid = RecorderPlumbing.recordingID(id) else {
          promise.resolve()
          return
        }
        do {
          try self.store.delete(uuid)
          captureNote("recording_deleted")
          promise.resolve()
        } catch RecordingStoreError.busy {
          promise.reject(captureError("ERR_RECORDING_BUSY"))
        } catch RecordingStoreError.notFound {
          promise.resolve()
        } catch {
          captureFault("recording_delete_failed")
          promise.reject(captureError("ERR_IO"))
        }
      }
    }

    // MARK: - Export

    /// Exports a closed or recovered recording into `Documents/exports/replay-<id>/` (design 9),
    /// with the idle timer off and inside a background task. `progress` gets at most 5 calls a
    /// second, then one at the end.
    func exportRecording(
      _ id: String, progress: @escaping ([String: Any?]) -> Void, _ promise: Promise
    ) {
      guard let uuid = RecorderPlumbing.recordingID(id), let grant = buildGrant() else {
        promise.reject(captureError("ERR_EXPORT_REFUSED"))
        return
      }
      DispatchQueue.main.async {
        let activity = ForegroundActivity.begin(name: "usg.export")
        Queues.store.async {
          do {
            let result = try TarExporter(store: self.store).export(id: uuid, grant: grant) { step in
              let payload: [String: Any?] = [
                "id": id, "bytesDone": Double(step.bytesDone), "bytesTotal": Double(step.bytesTotal),
              ]
              progress(payload)
            }
            captureNote("export_done")
            let value: [String: Any] = ["parts": result.parts, "tarBytes": Double(result.tarBytes)]
            promise.resolve(value)
          } catch let error as ExportError {
            captureFault("export_failed")
            promise.reject(RecorderPlumbing.exportException(error))
          } catch {
            captureFault("export_failed")
            promise.reject(captureError("ERR_IO"))
          }
          DispatchQueue.main.async {
            activity.end()
          }
        }
      }
    }

    // MARK: - Self-test

    /// The synthetic session through the real recorder and files (design D18). `keep` keeps the
    /// set for export only with the walk build's grant.
    func selfTest(keep: Bool, _ promise: Promise) {
      let grant = keep ? buildGrant() : nil
      DispatchQueue.main.async {
        let activity = ForegroundActivity.begin(name: "usg.selftest")
        Queues.store.async {
          let report = SelfTest(store: self.store).run(keep: keep, grant: grant)
          if report.passed {
            captureNote("selftest_passed")
          } else {
            captureFault("selftest_failed")
          }
          promise.resolve(RecorderPlumbing.selfTestValue(report))
          DispatchQueue.main.async {
            activity.end()
          }
        }
      }
    }

    // MARK: - Permissions

    /// Location (when in use) and Motion & Fitness, in the walk build only: the development build
    /// has no location usage key, so it never asks (design D14).
    func requestPermissions(_ promise: Promise) {
      if let refusal = buildRefusal() {
        promise.reject(refusalError(refusal))
        return
      }
      DispatchQueue.main.async {
        guard self.permissionRequest == nil else {
          promise.reject(captureError("ERR_RECORDING_BUSY"))
          return
        }
        let request = PermissionRequest()
        self.permissionRequest = request
        request.run { value in
          self.permissionRequest = nil
          promise.resolve(value)
        }
      }
    }

    // MARK: - Values for JavaScript

    /// A lowercase UUID, as the recorder names recordings, or nil.
    static func recordingID(_ text: String) -> UUID? {
      guard let id = UUID(uuidString: text), id.uuidString.lowercased() == text else { return nil }
      return id
    }

    static func summaryValue(_ summary: RecordingSummary) -> [String: Any] {
      var value: [String: Any] = [
        "id": summary.id.uuidString.lowercased(),
        "origin": summary.origin.rawValue,
        "profile": summary.profile.rawValue,
        "state": summary.state.rawValue,
        "ended": NSNull(),
        "trimmed": summary.trimmed,
        "durationS": NSNull(),
        "bytes": Double(summary.bytes),
        "files": summary.files,
        "ageDays": summary.ageDays,
        "venues": summary.venues,
        "exportParts": NSNull(),
      ]
      if let ended = summary.ended { value["ended"] = ended.rawValue }
      if let duration = summary.durationS { value["durationS"] = duration }
      if let parts = summary.exportParts { value["exportParts"] = parts }
      return value
    }

    static func selfTestValue(_ report: SelfTestReport) -> [String: Any] {
      var value: [String: Any] = [
        "passed": report.passed,
        "recordingFinished": report.recordingFinished,
        "protectionWhileWriting": NSNull(),
        "protectionAfterClose": NSNull(),
        "excludedFromBackup": report.excludedFromBackup,
        "compressionMatches": report.compressionMatches,
        "sha256Matches": report.sha256Matches,
        "encodeMBps": report.encodeMBps,
        "deflateMBps": report.deflateMBps,
        "sha256MBps": report.sha256MBps,
        "documentsNames": report.documentsNames,
        "keptId": NSNull(),
      ]
      if let cls = report.protectionWhileWriting { value["protectionWhileWriting"] = cls.rawValue }
      if let cls = report.protectionAfterClose { value["protectionAfterClose"] = cls.rawValue }
      if let id = report.keptID { value["keptId"] = id.uuidString.lowercased() }
      return value
    }

    static func exportException(_ error: ExportError) -> Exception {
      switch error {
      case .refused, .notClosed, .locked:
        return captureError("ERR_EXPORT_REFUSED")
      case .busy:
        return captureError("ERR_RECORDING_BUSY")
      case .tooLarge:
        return captureError("ERR_EXPORT_TOO_LARGE")
      case .noSpace:
        return captureError("ERR_NO_SPACE")
      case .corrupt:
        return captureError("ERR_RECORDING_CORRUPT")
      case .io:
        return captureError("ERR_IO")
      }
    }
  }

  /// Keeps the app working while the store queue exports or self-tests: the idle timer off, and
  /// a background task so a lock or a switch away doesn't suspend it at once. Main queue only.
  final class ForegroundActivity: @unchecked Sendable {
    private var task: UIBackgroundTaskIdentifier = .invalid
    private var idleTimerWasDisabled = false
    private var ended = false

    static func begin(name: String) -> ForegroundActivity {
      let activity = ForegroundActivity()
      let app = UIApplication.shared
      activity.idleTimerWasDisabled = app.isIdleTimerDisabled
      app.isIdleTimerDisabled = true
      activity.task = app.beginBackgroundTask(withName: name) { [weak activity] in
        activity?.endTask()
      }
      return activity
    }

    func end() {
      guard !ended else { return }
      ended = true
      UIApplication.shared.isIdleTimerDisabled = idleTimerWasDisabled
      endTask()
    }

    private func endTask() {
      guard task != .invalid else { return }
      UIApplication.shared.endBackgroundTask(task)
      task = .invalid
    }
  }

  /// The walk build's permission prompts, one after the other on the main queue: location when
  /// in use (Core Location), then Motion & Fitness (the barometer's authorisation). Made only
  /// with a grant, so the development build never creates a CLLocationManager.
  final class PermissionRequest: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private let altimeter = CMAltimeter()
    private var locationDone: ((String) -> Void)?
    private var motionDone = false

    /// Main queue. `completion` gets `{ location, preciseLocation, motion }`.
    func run(_ completion: @escaping ([String: Any]) -> Void) {
      requestLocation { location in
        self.requestMotion { motion in
          let value: [String: Any] = [
            "location": location,
            "preciseLocation": self.manager.accuracyAuthorization == .fullAccuracy,
            "motion": motion,
          ]
          completion(value)
        }
      }
    }

    private func requestLocation(_ done: @escaping (String) -> Void) {
      guard manager.authorizationStatus == .notDetermined else {
        done(PermissionRequest.locationName(manager.authorizationStatus))
        return
      }
      locationDone = done
      manager.delegate = self
      manager.requestWhenInUseAuthorization()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
      // Also called when the delegate is set, with the state before the prompt.
      let status = manager.authorizationStatus
      guard status != .notDetermined, let done = locationDone else { return }
      locationDone = nil
      done(PermissionRequest.locationName(status))
    }

    /// Motion & Fitness: starting the barometer asks, and its first answer, data or an error,
    /// means the owner has chosen. It stops at once; nothing is read.
    private func requestMotion(_ done: @escaping (String) -> Void) {
      let status = CMAltimeter.authorizationStatus()
      guard status == .notDetermined, CMAltimeter.isRelativeAltitudeAvailable() else {
        done(PermissionRequest.motionName(status))
        return
      }
      altimeter.startRelativeAltitudeUpdates(to: .main) { [weak self] _, _ in
        guard let self, !self.motionDone else { return }
        self.motionDone = true
        self.altimeter.stopRelativeAltitudeUpdates()
        done(PermissionRequest.motionName(CMAltimeter.authorizationStatus()))
      }
    }

    static func locationName(_ status: CLAuthorizationStatus) -> String {
      switch status {
      case .notDetermined: return "notDetermined"
      case .restricted: return "restricted"
      case .denied: return "denied"
      case .authorizedAlways: return "always"
      case .authorizedWhenInUse: return "whenInUse"
      @unknown default: return "unknown"
      }
    }

    static func motionName(_ status: CMAuthorizationStatus) -> String {
      switch status {
      case .notDetermined: return "notDetermined"
      case .restricted: return "restricted"
      case .denied: return "denied"
      case .authorized: return "authorized"
      @unknown default: return "unknown"
      }
    }
  }
#endif
