#if USG_RECORDER
import Foundation

// Who may record (ADR 0010; design section 2 and 11). Only the walk build records: a Release
// build with its JavaScript embedded, no dev launcher, and the walk profile in its Info.plist.
// The decision is made once, at `start`, and its only proof is a RecordingGrant, which nothing
// but `RecordPermission.decide` makes. The recorder, the location source and the exporter all
// take one, so a build that is refused can't reach them at all.

/// What the module reads about the build it runs in (BuildFacts in ios/).
public struct BuildFacts: Equatable, Sendable {
  /// Compiled with USG_RECORDER.
  public var recorderCompiled: Bool
  /// A DEBUG build.
  public var debugBuild: Bool
  /// Info.plist's `USGBuildProfile`, or nil.
  public var buildProfile: String?
  /// `main.jsbundle` is in the app: the JavaScript is embedded, not served by Metro.
  public var embeddedBundle: Bool
  /// expo-dev-launcher's controller class exists.
  public var devLauncher: Bool

  public init(
    recorderCompiled: Bool, debugBuild: Bool, buildProfile: String?, embeddedBundle: Bool,
    devLauncher: Bool
  ) {
    self.recorderCompiled = recorderCompiled
    self.debugBuild = debugBuild
    self.buildProfile = buildProfile
    self.embeddedBundle = embeddedBundle
    self.devLauncher = devLauncher
  }

  /// The walk build's facts.
  public static let walk = BuildFacts(
    recorderCompiled: true, debugBuild: false, buildProfile: "walk", embeddedBundle: true,
    devLauncher: false)
}

/// Why `start` refused to record. The raw value is the reason `ERR_RECORD_REFUSED` carries.
public enum RecordRefusal: String, CaseIterable, Error, Sendable {
  case notCompiled
  case debugBuild
  case notWalkBuild
  case notEmbedded
  case devClient
  /// `standard` and `dense` need the blur, which isn't there yet.
  case profileUnavailable
  /// Not 1 to 50 distinct lowercase UUIDs.
  case invalidVenues
  /// Less free space than `RecordLimits.minFreeBytes`.
  case lowDisk
}

/// The thresholds the decision uses.
public struct RecordLimits: Equatable, Sendable {
  /// Twice `maxRecordingBytes` (ADR 0010; open question Q10).
  public var minFreeBytes: Int64
  public var maxVenues: Int
  /// The profiles this build can record.
  public var profiles: Set<RecordProfile>

  public init(minFreeBytes: Int64, maxVenues: Int, profiles: Set<RecordProfile>) {
    self.minFreeBytes = minFreeBytes
    self.maxVenues = maxVenues
    self.profiles = profiles
  }

  /// 16 GiB free, 50 venues, `lean` only until the blur lands.
  public static let current = RecordLimits(
    minFreeBytes: 16 << 30, maxVenues: 50, profiles: [.lean])
}

/// Proof that a recording may be made, and of what. Its init is internal: outside CaptureCore
/// only `RecordPermission.decide` gives one, and inside it only SyntheticSession makes the
/// synthetic kind, which can only write `origin: synthetic`.
public struct RecordingGrant: Sendable {
  public let profile: RecordProfile
  /// The venues chosen before the start, lowercase.
  public let venues: [String]
  /// What the recordings made with it are: a device grant records the phone's sensors, a
  /// synthetic one only generated data.
  public let origin: ManifestBase.Origin

  init(profile: RecordProfile, venues: [String], origin: ManifestBase.Origin) {
    self.profile = profile
    self.venues = venues
    self.origin = origin
  }
}

public enum RecordDecision: Sendable {
  /// `record: off`: a capture without a recording; nothing to grant.
  case off
  case granted(RecordingGrant)
  case refused(RecordRefusal)
}

public enum RecordPermission {
  /// The decision for `start(record:venues:)`. `profile` nil is `record: off`, which needs no
  /// grant. Otherwise the build is checked first (so a development build always says why it
  /// isn't the walk build), then the profile, the venues and the free space.
  public static func decide(
    profile: RecordProfile?, facts: BuildFacts, venues: [String], freeDiskBytes: Int64,
    limits: RecordLimits = .current
  ) -> RecordDecision {
    guard let profile else { return .off }
    if let refusal = buildRefusal(facts) { return .refused(refusal) }
    guard limits.profiles.contains(profile) else { return .refused(.profileUnavailable) }
    guard (1...limits.maxVenues).contains(venues.count), venues.allSatisfy(isLowercaseUUID),
      Set(venues).count == venues.count
    else { return .refused(.invalidVenues) }
    guard freeDiskBytes >= limits.minFreeBytes else { return .refused(.lowDisk) }
    return .granted(RecordingGrant(profile: profile, venues: venues, origin: .device))
  }

  private static func buildRefusal(_ facts: BuildFacts) -> RecordRefusal? {
    if !facts.recorderCompiled { return .notCompiled }
    if facts.debugBuild { return .debugBuild }
    if facts.buildProfile != "walk" { return .notWalkBuild }
    if !facts.embeddedBundle { return .notEmbedded }
    if facts.devLauncher { return .devClient }
    return nil
  }
}
#endif
