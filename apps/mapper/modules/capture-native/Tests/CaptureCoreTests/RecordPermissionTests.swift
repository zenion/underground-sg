#if USG_RECORDER
import Foundation
import Testing

@testable import CaptureCore

// The decision `start` makes (design section 2 and 11): only the walk build gets a grant, and the
// refusal names the first thing wrong, in a fixed order.

private func decide(
  _ profile: RecordProfile? = .lean, facts: BuildFacts = .walk, venues: [String] = [corridorVenue],
  free: Int64 = 16 << 30
) -> RecordDecision {
  RecordPermission.decide(profile: profile, facts: facts, venues: venues, freeDiskBytes: free)
}

private func refusal(_ decision: RecordDecision) -> RecordRefusal? {
  if case .refused(let refusal) = decision { return refusal }
  return nil
}

@Suite struct RecordPermissionTests {
  /// Every combination of the build facts, with the profile in the Info.plist the walk build's,
  /// a development build's or missing.
  @Test func theBuildTruthTable() {
    var granted = 0
    for compiled in [false, true] {
      for debug in [false, true] {
        for profile in ["walk", "development", nil] as [String?] {
          for embedded in [false, true] {
            for launcher in [false, true] {
              let facts = BuildFacts(
                recorderCompiled: compiled, debugBuild: debug, buildProfile: profile,
                embeddedBundle: embedded, devLauncher: launcher)
              let expected: RecordRefusal? =
                !compiled
                ? .notCompiled
                : debug
                  ? .debugBuild
                  : profile != "walk"
                    ? .notWalkBuild : !embedded ? .notEmbedded : launcher ? .devClient : nil
              let decision = decide(facts: facts)
              #expect(refusal(decision) == expected, "\(facts)")
              if case .granted = decision { granted += 1 }
              // Recording off never needs a grant, whatever the build.
              if case .off = decide(nil, facts: facts) {} else { Issue.record("off is off") }
            }
          }
        }
      }
    }
    #expect(granted == 1)
  }

  @Test func theDevelopmentBuildsRefusalsAreItsOwn() {
    // A development build: a dev client, Debug, Metro-served JavaScript.
    let development = BuildFacts(
      recorderCompiled: true, debugBuild: true, buildProfile: "development", embeddedBundle: false,
      devLauncher: true)
    #expect(refusal(decide(facts: development)) == .debugBuild)
    var release = development
    release.debugBuild = false
    #expect(refusal(decide(facts: release)) == .notWalkBuild)
  }

  @Test func onlyLeanUntilTheBlurLands() {
    #expect(refusal(decide(.standard)) == .profileUnavailable)
    #expect(refusal(decide(.dense)) == .profileUnavailable)
    // The build is checked first.
    #expect(
      refusal(
        decide(
          .dense,
          facts: BuildFacts(
            recorderCompiled: true, debugBuild: true, buildProfile: "walk", embeddedBundle: true,
            devLauncher: false))) == .debugBuild)
  }

  @Test(arguments: [
    [String](),
    ["36632586-E1FA-4E10-800A-81ACF0EAB09A"],
    ["not-a-uuid"],
    [corridorVenue, corridorVenue],
    (0..<51).map { testUUID($0).uuidString.lowercased() },
  ])
  func venuesMustBeOneToFiftyDistinctLowercaseUUIDs(_ venues: [String]) {
    #expect(refusal(decide(venues: venues)) == .invalidVenues)
  }

  @Test func fiftyVenuesAreFine() {
    let venues = (0..<50).map { testUUID($0).uuidString.lowercased() }
    guard case .granted(let grant) = decide(venues: venues) else {
      Issue.record("granted")
      return
    }
    #expect(grant.venues == venues)
  }

  @Test func sixteenGibibytesFreeToStart() {
    #expect(refusal(decide(free: (16 << 30) - 1)) == .lowDisk)
    guard case .granted(let grant) = decide(free: 16 << 30) else {
      Issue.record("granted at exactly 16 GiB")
      return
    }
    #expect(grant.profile == .lean)
    #expect(grant.origin == .device)
    #expect(grant.venues == [corridorVenue])
  }

  @Test func refusalCodesAreStable() {
    #expect(
      RecordRefusal.allCases.map(\.rawValue) == [
        "notCompiled", "debugBuild", "notWalkBuild", "notEmbedded", "devClient",
        "profileUnavailable", "invalidVenues", "lowDisk",
      ])
  }
}
#endif
