#if USG_RECORDER
  import CaptureCore
  import CoreMotion
  import Foundation

  /// What Core Motion delivered since the last hand-over: the module's motion samples, in the
  /// order they came.
  struct MotionBatch {
    var imu: [ImuSample] = []
    var motion: [MotionSample] = []
    var altitude: [AltitudeSample] = []

    var isEmpty: Bool { imu.isEmpty && motion.isEmpty && altitude.isEmpty }
  }

  /// Core Motion for the recorder (the lean recorder design, sections 4 and 5): the accelerometer
  /// and the gyro at 100 Hz paired by ImuPairer, device motion at 100 Hz in the reference frame
  /// of open question Q3, and the barometer's relative altitude. Their handlers run on
  /// `Queues.motion` (an OperationQueue, one operation at a time, over its own serial queue),
  /// turn each CMLogItem into a CaptureCore sample with the session's `t` (CMLogItem timestamps
  /// are on the uptime clock, as ARFrame's are; design D26) and hand them to the capture queue
  /// in batches of 10, so the capture queue wakes about 10 times a second for them.
  ///
  /// The reference frame and the altimeter's state are read when it is made, at `start`, for
  /// recording.json and the events at the open. Made only with a grant (RecorderHost), so the
  /// development build never starts Core Motion. Never logs a value.
  final class MotionSource: @unchecked Sendable {
    /// Device motion's reference frame: magnetic north if this phone has it, else the corrected
    /// arbitrary frame, else the arbitrary one; nil without device motion (design section 5).
    let referenceFrame: MotionFrame?
    /// Whether the altimeter runs. Denied or restricted Motion & Fitness counts as denied; not
    /// yet asked counts as available (starting it asks; a refusal then just gives no samples).
    let altimeter: AltimeterStatus

    private let manager = CMMotionManager()
    private let altimeterSensor = CMAltimeter()
    private let lock = NSLock()
    /// Guarded by `lock`: the run whose handlers are live.
    private var current: MotionRun?

    /// Samples per hand-over to the capture queue.
    static let batchSize = 10
    /// Core Motion's update interval: 100 Hz.
    static let intervalS = 0.01

    /// Main queue, at `start`, before the session clock is read.
    init() {
      if manager.isDeviceMotionAvailable {
        let frames = CMMotionManager.availableAttitudeReferenceFrames()
        if frames.contains(.xMagneticNorthZVertical) {
          referenceFrame = .xMagneticNorthZVertical
        } else if frames.contains(.xArbitraryCorrectedZVertical) {
          referenceFrame = .xArbitraryCorrectedZVertical
        } else {
          referenceFrame = .xArbitraryZVertical
        }
      } else {
        referenceFrame = nil
      }
      if !CMAltimeter.isRelativeAltitudeAvailable() {
        altimeter = .unavailable
      } else {
        switch CMAltimeter.authorizationStatus() {
        case .denied, .restricted: altimeter = .denied
        case .notDetermined, .authorized: altimeter = .available
        @unknown default: altimeter = .denied
        }
      }
    }

    /// Main queue. Starts the sensors; `deliver` gets each batch on the motion queue.
    func start(clock: SessionClock, deliver: @escaping (MotionBatch) -> Void) {
      lock.lock()
      let running = current != nil
      lock.unlock()
      guard !running else { return }
      let run = MotionRun(clock: clock, frame: referenceFrame, deliver: deliver)
      lock.lock()
      current = run
      lock.unlock()

      let queue = Queues.motion
      if manager.isAccelerometerAvailable && manager.isGyroAvailable {
        manager.accelerometerUpdateInterval = MotionSource.intervalS
        manager.gyroUpdateInterval = MotionSource.intervalS
        manager.startAccelerometerUpdates(to: queue) { data, _ in
          if let data { run.accelerometer(data) }
        }
        manager.startGyroUpdates(to: queue) { data, _ in
          if let data { run.gyro(data) }
        }
      }
      if let frame = referenceFrame {
        manager.deviceMotionUpdateInterval = MotionSource.intervalS
        manager.startDeviceMotionUpdates(using: MotionSource.attitudeFrame(frame), to: queue) {
          motion, _ in
          if let motion { run.deviceMotion(motion) }
        }
      }
      if altimeter == .available {
        altimeterSensor.startRelativeAltitudeUpdates(to: queue) { data, _ in
          // An error (Motion & Fitness refused at the prompt) just means no samples.
          if let data { run.altitude(data) }
        }
      }
    }

    /// Main queue. Stops the sensors; what was batched goes out first.
    func stop() {
      lock.lock()
      let run = current
      current = nil
      lock.unlock()
      guard let run else { return }
      manager.stopAccelerometerUpdates()
      manager.stopGyroUpdates()
      manager.stopDeviceMotionUpdates()
      altimeterSensor.stopRelativeAltitudeUpdates()
      Queues.motion.addOperation {
        run.flush()
      }
    }

    /// Any queue. Runs `then` on the motion queue after every handler already queued there, once
    /// the batch it holds has been handed over: the first link of the chained finalize (design
    /// section 4), so every sample delivered before the window closed reaches the recorder first.
    func barrier(_ then: @escaping () -> Void) {
      lock.lock()
      let run = current
      lock.unlock()
      Queues.motion.addBarrierBlock {
        run?.flush()
        then()
      }
    }

    private static func attitudeFrame(_ frame: MotionFrame) -> CMAttitudeReferenceFrame {
      switch frame {
      case .xArbitraryZVertical: return .xArbitraryZVertical
      case .xArbitraryCorrectedZVertical: return .xArbitraryCorrectedZVertical
      case .xMagneticNorthZVertical: return .xMagneticNorthZVertical
      case .xTrueNorthZVertical: return .xTrueNorthZVertical
      }
    }
  }

  /// One run's state, confined to the motion queue: the IMU pairer and the batch being filled.
  private final class MotionRun: @unchecked Sendable {
    private let clock: SessionClock
    private let frame: MotionFrame?
    private let deliver: (MotionBatch) -> Void
    private var pairer = ImuPairer()
    private var batch = MotionBatch()

    init(clock: SessionClock, frame: MotionFrame?, deliver: @escaping (MotionBatch) -> Void) {
      self.clock = clock
      self.frame = frame
      self.deliver = deliver
    }

    func accelerometer(_ data: CMAccelerometerData) {
      guard let t = clock.t(uptime: data.timestamp) else { return }
      let a = data.acceleration
      batch.imu += pairer.accelerometer(t: t, g: SIMD3(a.x, a.y, a.z))
      sendIfFull()
    }

    func gyro(_ data: CMGyroData) {
      guard let t = clock.t(uptime: data.timestamp) else { return }
      let r = data.rotationRate
      batch.imu += pairer.gyro(t: t, rate: SIMD3(r.x, r.y, r.z))
      sendIfFull()
    }

    func deviceMotion(_ motion: CMDeviceMotion) {
      guard frame != nil, let t = clock.t(uptime: motion.timestamp) else { return }
      let q = motion.attitude.quaternion
      let g = motion.gravity
      let u = motion.userAcceleration
      let r = motion.rotationRate
      let field = motion.magneticField.field
      batch.motion.append(
        MotionSample(
          t: t, attitude: SIMD4(q.x, q.y, q.z, q.w), gravityG: SIMD3(g.x, g.y, g.z),
          userAccelG: SIMD3(u.x, u.y, u.z), rotation: SIMD3(r.x, r.y, r.z),
          magneticField: SIMD3(field.x, field.y, field.z),
          magneticAccuracy: MotionRun.accuracy(motion.magneticField.accuracy),
          heading: motion.heading))
      sendIfFull()
    }

    /// About 1 Hz, so it goes out at once.
    func altitude(_ data: CMAltitudeData) {
      guard let t = clock.t(uptime: data.timestamp) else { return }
      batch.altitude.append(
        AltitudeSample(
          t: t, relativeAltitudeM: data.relativeAltitude.doubleValue,
          pressureKpa: data.pressure.doubleValue))
      send()
    }

    /// Pairs what the pairer still holds and hands everything over.
    func flush() {
      batch.imu += pairer.flush()
      send()
    }

    private func sendIfFull() {
      if batch.imu.count >= MotionSource.batchSize || batch.motion.count >= MotionSource.batchSize {
        send()
      }
    }

    private func send() {
      guard !batch.isEmpty else { return }
      let out = batch
      batch = MotionBatch()
      deliver(out)
    }

    private static func accuracy(_ value: CMMagneticFieldCalibrationAccuracy)
      -> MagneticAccuracyCode
    {
      switch value {
      case .uncalibrated: return .uncalibrated
      case .low: return .low
      case .medium: return .medium
      case .high: return .high
      @unknown default: return .uncalibrated
      }
    }
  }
#endif
