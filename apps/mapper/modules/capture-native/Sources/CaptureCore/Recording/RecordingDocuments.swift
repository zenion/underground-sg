#if USG_RECORDER
import Foundation

// recording.json and parts.json (docs/session-recording.md; design 3.1). The generated types are
// internal, so the recorder and the I/O module pass plain values in and get the document's bytes
// back. Every field the schema requires is written, null included, by the generated encoders.

/// What the recorder knows before a recording opens about the build, the phone and the session:
/// everything recording.json holds except the window, the rates, the files and the grant's
/// profile and venues.
public struct ManifestBase: Sendable {
  /// `origin` in recording.json. `build.profile` follows it (`walk` or `synthetic`), so the two
  /// always agree, as the format wants.
  public enum Origin: String, Sendable {
    case device
    case synthetic
  }

  public var origin: Origin
  /// The mapper app's version, for example 0.1.0.
  public var appVersion: String
  /// The commit built. Anything but 40 lowercase hex digits is written as null.
  public var gitCommit: String?
  /// The EAS build's id. Anything but a lowercase UUID is written as null.
  public var easBuildID: String?
  public var deviceModel: String
  public var osVersion: String
  public var clock: SessionClock
  public var arkit: ArkitSetup
  /// Device motion's reference frame, or nil when device motion is unavailable.
  public var motionFrame: MotionFrame?

  public init(
    origin: Origin, appVersion: String, gitCommit: String?, easBuildID: String?,
    deviceModel: String, osVersion: String, clock: SessionClock, arkit: ArkitSetup,
    motionFrame: MotionFrame?
  ) {
    self.origin = origin
    self.appVersion = appVersion
    self.gitCommit = gitCommit
    self.easBuildID = easBuildID
    self.deviceModel = deviceModel
    self.osVersion = osVersion
    self.clock = clock
    self.arkit = arkit
    self.motionFrame = motionFrame
  }
}

/// The ARWorldTrackingConfiguration the session ran: recording.json's `arkit`.
public struct ArkitSetup: Equatable, Sendable {
  /// The raw values are the format's.
  public enum Reconstruction: String, Sendable {
    case meshWithClassification
    case mesh
    case none
  }

  public enum Semantic: String, Sendable {
    case sceneDepth
    case smoothedSceneDepth
  }

  public enum Alignment: String, Sendable {
    case gravity
    case gravityAndHeading
    case camera
  }

  public var reconstruction: Reconstruction
  public var semantics: [Semantic]
  /// The video format's image size, landscape, and frame rate.
  public var videoWidth: Int
  public var videoHeight: Int
  public var fps: Int
  public var alignment: Alignment

  public init(
    reconstruction: Reconstruction, semantics: [Semantic], videoWidth: Int, videoHeight: Int,
    fps: Int, alignment: Alignment
  ) {
    self.reconstruction = reconstruction
    self.semantics = semantics
    self.videoWidth = videoWidth
    self.videoHeight = videoHeight
    self.fps = fps
    self.alignment = alignment
  }

  /// What a lean capture runs: the classified mesh, smoothed scene depth, gravity alignment and
  /// the 1920 × 1440 format at 60 fps.
  public static let lean = ArkitSetup(
    reconstruction: .meshWithClassification, semantics: [.smoothedSceneDepth], videoWidth: 1920,
    videoHeight: 1440, fps: 60, alignment: .gravity)
}

/// How a recording's window closed, as recording.json's `window` and the journal's `closed`
/// record write it. Times only: never logged.
public struct WindowClose: Equatable, Sendable {
  public let startT: Double
  public let endT: Double
  public let reason: WindowEndReason
  /// Cut back to the last end anchor plus the margin.
  public let trimmed: Bool
  /// A final sample was taken at `endT` (only for `end_anchor` and `idle`, design D1).
  public let finalSample: Bool

  public init(
    startT: Double, endT: Double, reason: WindowEndReason, trimmed: Bool, finalSample: Bool
  ) {
    self.startT = startT
    self.endT = endT
    self.reason = reason
    self.trimmed = trimmed
    self.finalSample = finalSample
  }
}

/// recording.json's `rates`: what the recording achieved over its window.
public struct AchievedRates: Equatable, Sendable {
  public var framesHz: Double
  public var candidatesHz: Double
  public var imuHz: Double
  public var motionHz: Double
  /// Mean seconds between mesh snapshots, nil without two of them.
  public var meshIntervalS: Double?

  public init(
    framesHz: Double, candidatesHz: Double, imuHz: Double, motionHz: Double,
    meshIntervalS: Double?
  ) {
    self.framesHz = framesHz
    self.candidatesHz = candidatesHz
    self.imuHz = imuHz
    self.motionHz = motionHz
    self.meshIntervalS = meshIntervalS
  }

  /// Lines written divided by the window's length (design 7.5), and the mean gap between the
  /// distinct snapshot times inside the window. Rounded to a thousandth, which is all a rate
  /// needs. A window of no length has rates of 0.
  public static func over(
    startT: Double, endT: Double, frames: Int, candidates: Int, imu: Int, motion: Int,
    snapshotTs: [Double]
  ) -> AchievedRates {
    let length = endT - startT
    func rate(_ count: Int) -> Double {
      guard length > 0, length.isFinite else { return 0 }
      return thousandth(Double(count) / length)
    }
    let snapshots = Set(snapshotTs.filter { $0 >= startT && $0 <= endT }).sorted()
    var interval: Double? = nil
    if snapshots.count >= 2, let first = snapshots.first, let last = snapshots.last {
      interval = thousandth((last - first) / Double(snapshots.count - 1))
    }
    return AchievedRates(
      framesHz: rate(frames), candidatesHz: rate(candidates), imuHz: rate(imu),
      motionHz: rate(motion), meshIntervalS: interval)
  }
}

/// One file of a recording with its size and digest: an entry of recording.json's `files`.
public struct FileDigest: Equatable, Sendable {
  /// The path in `rec-<recording_id>/`, with `/`.
  public let path: String
  public let bytes: Int64
  /// Lowercase hex SHA-256.
  public let sha256: String

  public init(path: String, bytes: Int64, sha256: String) {
    self.path = path
    self.bytes = bytes
    self.sha256 = sha256
  }
}

/// One part of an export with its digest: an entry of parts.json's `parts`.
public struct PartDigest: Equatable, Sendable {
  /// `0000.part` and so on.
  public let name: String
  public let bytes: Int64
  public let sha256: String

  public init(name: String, bytes: Int64, sha256: String) {
    self.name = name
    self.bytes = bytes
    self.sha256 = sha256
  }
}

/// Why a document could not be made. No case carries a value from the recording.
public enum RecordingDocumentError: Error, Equatable, Sendable {
  /// The opening recording.json given to `closed` doesn't decode.
  case unreadableOpening
}

/// recording.json at open and at close, and an export's parts.json, as bytes ready to write
/// atomically.
public enum RecordingDocuments {
  /// recording.json as written when the recording opens: `closed` false, `files` and `segments`
  /// empty, `rates`, `window.end_t` and `window.ended` null, `detector_versions` null (lean runs
  /// no detectors).
  public static func opening(
    id: UUID, base: ManifestBase, profile: RecordProfile, venues: [String], startT: Double
  ) throws -> Data {
    let manifest = RecordingManifest(
      arkit: ArkitConfiguration(
        frameSemantics: base.arkit.semantics.compactMap { FrameSemantic(rawValue: $0.rawValue) },
        sceneReconstruction: SceneReconstruction(rawValue: base.arkit.reconstruction.rawValue)
          ?? .none,
        videoFormat: ArVideoFormat(
          fps: base.arkit.fps, height: base.arkit.videoHeight, width: base.arkit.videoWidth),
        worldAlignment: WorldAlignment(rawValue: base.arkit.alignment.rawValue) ?? .gravity),
      build: RecordingBuild(
        appVersion: bounded(base.appVersion),
        easBuildID: base.easBuildID.flatMap { isLowercaseUUID($0) ? $0 : nil },
        gitCommit: base.gitCommit.flatMap { isCommit($0) ? $0 : nil },
        profile: base.origin == .synthetic ? .synthetic : .walk),
      clocks: base.clock.clocks, closed: false, detectorVersions: nil,
      deviceModel: bounded(base.deviceModel), files: [],
      motion: base.motionFrame.flatMap { frame in
        MotionReferenceFrame(rawValue: frame.rawValue).map {
          MotionConfiguration(referenceFrame: $0)
        }
      },
      origin: base.origin == .synthetic ? .synthetic : .device, osVersion: bounded(base.osVersion),
      profile: RecordingProfile(rawValue: profile.rawValue) ?? .lean, rates: nil,
      recordingID: id.uuidString.lowercased(), recordingVersion: recordingVersion, segments: [],
      sessionStartedAt: base.clock.sessionStartedAt, venues: venues,
      window: RecordingWindow(endT: nil, ended: nil, startT: startT, trimmed: false))
    return try LineEncoder().document(manifest)
  }

  /// recording.json at close: the opening document with its window closed, the rates and the
  /// files. `files` is sorted by path, bytewise, without recording.json, which can't list
  /// itself. `closed` is true when the recorder finished the recording in process, false when
  /// recovery cut it back (design D2).
  public static func closed(
    opening: Data, window: WindowClose, rates: AchievedRates?, files: [FileDigest], closed: Bool
  ) throws -> Data {
    guard let open = try? JSONDecoder().decode(RecordingManifest.self, from: opening) else {
      throw RecordingDocumentError.unreadableOpening
    }
    let manifest = RecordingManifest(
      arkit: open.arkit, build: open.build, clocks: open.clocks, closed: closed,
      detectorVersions: open.detectorVersions, deviceModel: open.deviceModel,
      files: sortedFiles(files), motion: open.motion, origin: open.origin,
      osVersion: open.osVersion, profile: open.profile,
      rates: rates.map {
        RecordingRates(
          candidatesHz: $0.candidatesHz, framesHz: $0.framesHz, imuHz: $0.imuHz,
          meshIntervalS: $0.meshIntervalS, motionHz: $0.motionHz)
      },
      recordingID: open.recordingID, recordingVersion: open.recordingVersion,
      segments: open.segments, sessionStartedAt: open.sessionStartedAt, venues: open.venues,
      window: RecordingWindow(
        endT: window.endT, ended: RecordingEnded(rawValue: window.reason.rawValue),
        startT: open.window.startT, trimmed: window.trimmed))
    return try LineEncoder().document(manifest)
  }

  /// parts.json beside an export's parts.
  public static func exportParts(
    recordingID: UUID, tarBytes: Int64, tarSha256: String, parts: [PartDigest]
  ) throws -> Data {
    let document = ExportParts(
      parts: parts.map { ExportPart(bytes: Int($0.bytes), name: $0.name, sha256: $0.sha256) },
      recordingID: recordingID.uuidString.lowercased(), recordingVersion: recordingVersion,
      tarBytes: Int(tarBytes), tarSha256: tarSha256)
    return try LineEncoder().document(document)
  }

  /// RECORDING_VERSION in packages/contracts.
  static let recordingVersion = 1

  /// The files entries: recording.json left out, sorted by the path's UTF-8 bytes.
  static func sortedFiles(_ files: [FileDigest]) -> [RecordingFile] {
    files.filter { $0.path != "recording.json" }
      .sorted { Array($0.path.utf8).lexicographicallyPrecedes(Array($1.path.utf8)) }
      .map { RecordingFile(bytes: Int($0.bytes), path: $0.path, sha256: $0.sha256) }
  }
}

/// The format's 1 to 100 characters: an empty value becomes `unknown`, a long one is cut.
private func bounded(_ text: String) -> String {
  if text.isEmpty { return "unknown" }
  return String(text.unicodeScalars.prefix(100).map(Character.init))
}

private func isCommit(_ text: String) -> Bool {
  let bytes = Array(text.utf8)
  return bytes.count == 40 && bytes.allSatisfy(isLowerHex)
}

/// The canonical lowercase form, as the schemas' `uuid`.
func isLowercaseUUID(_ text: String) -> Bool {
  let bytes = Array(text.utf8)
  guard bytes.count == 36 else { return false }
  for (index, byte) in bytes.enumerated() {
    if [8, 13, 18, 23].contains(index) {
      guard byte == UInt8(ascii: "-") else { return false }
    } else if !isLowerHex(byte) {
      return false
    }
  }
  return true
}

private func isLowerHex(_ byte: UInt8) -> Bool {
  (byte >= UInt8(ascii: "0") && byte <= UInt8(ascii: "9"))
    || (byte >= UInt8(ascii: "a") && byte <= UInt8(ascii: "f"))
}

private func thousandth(_ value: Double) -> Double {
  value.isFinite ? (value * 1000).rounded() / 1000 : 0
}
#endif
