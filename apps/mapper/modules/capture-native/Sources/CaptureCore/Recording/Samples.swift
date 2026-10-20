#if USG_RECORDER
import Foundation

// The values the module copies out of ARKit and Core Motion for the recorder (design 3.1 and 5).
// Plain values only: an ARFrame or a CMLogItem never outlives its callback, so the module copies
// what a line needs into these and lets the original go. Each becomes one line through
// `PendingLine`, whose encoders do the unit conversions (g to m/s², float32 to its shortest
// decimal), so the sources stay as the APIs report them.

/// A sample with a session time, for the buffers that hold samples by time.
public protocol TimedSample: Sendable {
  /// Seconds since the ARKit session started.
  var t: Double { get }
}

/// ARKit's tracking state, written as poses.jsonl writes it: `normal`, `notAvailable` or
/// `limited:<reason>`.
public enum TrackingCode: Equatable, Sendable {
  case normal
  case notAvailable
  case limited(LimitedReason)

  /// ARCamera.TrackingState.Reason. `unknown` stands for a reason a later iOS adds.
  public enum LimitedReason: String, CaseIterable, Sendable {
    case initializing
    case excessiveMotion
    case insufficientFeatures
    case relocalizing
    case unknown
  }

  /// The text frames.jsonl writes.
  public var text: String {
    switch self {
    case .normal: "normal"
    case .notAvailable: "notAvailable"
    case .limited(let reason): "limited:" + reason.rawValue
    }
  }
}

/// ARFrame.worldMappingStatus. The raw values are the format's.
public enum MappingCode: String, CaseIterable, Sendable {
  case notAvailable
  case limited
  case extending
  case mapped
}

/// Why a candidate was not kept: `dropped:<reason>` in frames.jsonl.
public enum DropReason: String, CaseIterable, Sendable {
  /// The profile keeps no candidates, as in `lean`.
  case profile
  case heat
  case backpressure
  case disk
  /// A detector failed, so the frame was never written.
  case blur
}

/// What became of a frame the candidate gate passed: `candidate` in frames.jsonl. A frame the
/// gate didn't pass has none.
public enum CandidateMark: Equatable, Sendable {
  case keyframe
  /// Written to candidates/.
  case kept
  case dropped(DropReason)

  /// The text frames.jsonl writes.
  public var text: String {
    switch self {
    case .keyframe: "keyframe"
    case .kept: "kept"
    case .dropped(let reason): "dropped:" + reason.rawValue
    }
  }
}

/// One ARFrame, as frames.jsonl needs it. ARKit's float32 values stay Float here.
public struct FrameSample: TimedSample, Equatable {
  /// The session frame index, counted from 0 across the whole session.
  public var frame: Int
  public var t: Double
  /// `camera.transform`.
  public var camera: WorldTransform
  /// fx, fy, cx, cy: the intrinsics matrix's [0][0], [1][1], [2][0] and [2][1].
  public var intrinsics: SIMD4<Float>
  public var tracking: TrackingCode
  public var mapping: MappingCode
  /// `camera.exposureDuration`, in seconds.
  public var exposureDurationS: Double
  /// `camera.exposureOffset`, in EV.
  public var exposureOffsetEV: Float
  /// The light estimate's ambient intensity (lumens) and colour temperature (kelvin), or nil.
  public var light: SIMD2<Float>?
  /// The video format's frame rate, for the frame gap.
  public var fps: Int
  public var candidate: CandidateMark?
  /// The candidate gate's time for this frame, in milliseconds.
  public var gateMs: Double

  public init(
    frame: Int, t: Double, camera: WorldTransform, intrinsics: SIMD4<Float>,
    tracking: TrackingCode, mapping: MappingCode, exposureDurationS: Double,
    exposureOffsetEV: Float, light: SIMD2<Float>?, fps: Int, candidate: CandidateMark?,
    gateMs: Double
  ) {
    self.frame = frame
    self.t = t
    self.camera = camera
    self.intrinsics = intrinsics
    self.tracking = tracking
    self.mapping = mapping
    self.exposureDurationS = exposureDurationS
    self.exposureOffsetEV = exposureOffsetEV
    self.light = light
    self.fps = fps
    self.candidate = candidate
    self.gateMs = gateMs
  }
}

/// One accelerometer sample paired with a gyro sample (ImuPairer), in Core Motion's device axes.
public struct ImuSample: TimedSample, Equatable {
  public var t: Double
  /// Raw acceleration in g, gravity included, as CMAccelerometerData reports it.
  public var accelG: SIMD3<Double>
  /// Rotation rate in rad/s.
  public var gyro: SIMD3<Double>

  public init(t: Double, accelG: SIMD3<Double>, gyro: SIMD3<Double>) {
    self.t = t
    self.accelG = accelG
    self.gyro = gyro
  }
}

/// The Core Motion reference frame device motion was started with: `motion.reference_frame` in
/// recording.json. The raw values are the format's.
public enum MotionFrame: String, CaseIterable, Sendable {
  case xArbitraryZVertical
  case xArbitraryCorrectedZVertical
  case xMagneticNorthZVertical
  case xTrueNorthZVertical

  /// The two arbitrary frames have no north, so motion.jsonl's heading is null in them.
  public var isArbitrary: Bool {
    self == .xArbitraryZVertical || self == .xArbitraryCorrectedZVertical
  }
}

/// CMMagneticFieldCalibrationAccuracy. The raw values are the format's.
public enum MagneticAccuracyCode: String, CaseIterable, Sendable {
  case uncalibrated
  case low
  case medium
  case high
}

/// One device-motion sample, as CMDeviceMotion reports it.
public struct MotionSample: TimedSample, Equatable {
  public var t: Double
  /// The attitude quaternion x, y, z, w, as reported: not renormalised.
  public var attitude: SIMD4<Double>
  /// In g.
  public var gravityG: SIMD3<Double>
  /// In g.
  public var userAccelG: SIMD3<Double>
  /// In rad/s.
  public var rotation: SIMD3<Double>
  /// The calibrated magnetic field, in µT.
  public var magneticField: SIMD3<Double>
  public var magneticAccuracy: MagneticAccuracyCode
  /// `heading` in degrees, as reported. Core Motion gives a negative value when it has none.
  public var heading: Double

  public init(
    t: Double, attitude: SIMD4<Double>, gravityG: SIMD3<Double>, userAccelG: SIMD3<Double>,
    rotation: SIMD3<Double>, magneticField: SIMD3<Double>, magneticAccuracy: MagneticAccuracyCode,
    heading: Double
  ) {
    self.t = t
    self.attitude = attitude
    self.gravityG = gravityG
    self.userAccelG = userAccelG
    self.rotation = rotation
    self.magneticField = magneticField
    self.magneticAccuracy = magneticAccuracy
    self.heading = heading
  }
}

/// One altimeter sample, as CMAltitudeData reports it. Never absolute altitude.
public struct AltitudeSample: TimedSample, Equatable {
  public var t: Double
  /// `relativeAltitude`, in metres since the altimeter started. AltitudeRebaser moves its zero to
  /// the first sample written.
  public var relativeAltitudeM: Double
  /// `pressure`, in kilopascals.
  public var pressureKpa: Double

  public init(t: Double, relativeAltitudeM: Double, pressureKpa: Double) {
    self.t = t
    self.relativeAltitudeM = relativeAltitudeM
    self.pressureKpa = pressureKpa
  }
}

/// One second of the phone's state, for telemetry.jsonl.
public struct TelemetrySample: TimedSample, Equatable {
  public var t: Double
  public var thermal: DeviceThermal
  /// The app's memory footprint (`phys_footprint`), in bytes.
  public var memoryBytes: Int64
  /// The app's CPU use in percent of one core; it can pass 100.
  public var cpuPercent: Double
  /// Free space on the phone, in bytes.
  public var freeDiskBytes: Int64
  /// Frames waiting for the keyframe and candidate stages.
  public var queue: Int
  /// Counts since the recording opened.
  public var candidatesBlurred: Int
  /// Only drops the profile didn't intend (heat, backpressure, disk, blur), not `dropped:profile`.
  public var candidatesDropped: Int
  /// StageTimer's percentiles for the last second.
  public var stageMs: [Stage: StagePercentileValue]

  public init(
    t: Double, thermal: DeviceThermal, memoryBytes: Int64, cpuPercent: Double,
    freeDiskBytes: Int64, queue: Int, candidatesBlurred: Int, candidatesDropped: Int,
    stageMs: [Stage: StagePercentileValue]
  ) {
    self.t = t
    self.thermal = thermal
    self.memoryBytes = memoryBytes
    self.cpuPercent = cpuPercent
    self.freeDiskBytes = freeDiskBytes
    self.queue = queue
    self.candidatesBlurred = candidatesBlurred
    self.candidatesDropped = candidatesDropped
    self.stageMs = stageMs
  }
}
#endif
