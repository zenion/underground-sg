#if USG_RECORDER
import Foundation
import Testing

@testable import CaptureCore

private let gib: Int64 = 1 << 30
/// Plenty of free disk: no disk rule applies.
private let roomy: Int64 = 50 * gib

/// Every generated ThermalState. The switch in `mirror` has no default, so a case the schema adds
/// breaks the build until it is listed here and given a public mirror.
private let generatedThermal: [ThermalState] = [.nominal, .fair, .serious, .critical]
private func mirror(_ generated: ThermalState) -> DeviceThermal {
  switch generated {
  case .nominal: .nominal
  case .fair: .fair
  case .serious: .serious
  case .critical: .critical
  }
}

/// Every generated RecordingProfile, kept complete the same way.
private let generatedProfiles: [RecordingProfile] = [.lean, .standard, .dense]
private func mirror(_ generated: RecordingProfile) -> RecordProfile {
  switch generated {
  case .lean: .lean
  case .standard: .standard
  case .dense: .dense
  }
}

@Suite struct DegradationLadderTests {
  @Test func rawValuesMatchTheGeneratedEnums() {
    // Both ways: every generated case has a public mirror with its raw value, and every public
    // case is a value the recording format allows.
    for generated in generatedThermal {
      #expect(mirror(generated).rawValue == generated.rawValue)
      #expect(DeviceThermal(rawValue: generated.rawValue) != nil)
    }
    for thermal in DeviceThermal.allCases {
      #expect(ThermalState(rawValue: thermal.rawValue) != nil)
    }
    #expect(Set(DeviceThermal.allCases) == Set(generatedThermal.map(mirror)))
    for generated in generatedProfiles {
      #expect(mirror(generated).rawValue == generated.rawValue)
      #expect(RecordProfile(rawValue: generated.rawValue) != nil)
    }
    for profile in RecordProfile.allCases {
      #expect(RecordingProfile(rawValue: profile.rawValue) != nil)
    }
    #expect(Set(RecordProfile.allCases) == Set(generatedProfiles.map(mirror)))
    #expect(
      DegradationStep.allCases.map(\.rawValue) == [
        "fewer_candidates", "no_mesh_history", "no_recording",
      ])
  }

  @Test func stepsAreOrdered() {
    #expect(DegradationStep.allCases == DegradationStep.allCases.sorted())
    #expect(DegradationStep.fewerCandidates < .noMeshHistory)
    #expect(DegradationStep.noMeshHistory < .noRecording)
  }

  @Test func provisionalFloors() {
    #expect(DegradationConfig.provisional.meshFloorBytes == 2 * gib)
    #expect(DegradationConfig.provisional.stopFloorBytes == gib)
  }

  @Test(arguments: RecordProfile.allCases)
  func coolWithRoomChangesNothing(profile: RecordProfile) {
    var ladder = DegradationLadder(profile: profile)
    #expect(ladder.update(thermal: .nominal, freeDiskBytes: roomy).isEmpty)
    #expect(ladder.update(thermal: .fair, freeDiskBytes: roomy).isEmpty)
    #expect(ladder.steps.isEmpty)
    #expect(ladder.keepsMeshHistory)
    #expect(ladder.keepsRecording)
    #expect(ladder.keepsCandidates == (profile != .lean))
  }

  @Test(arguments: [RecordProfile.standard, .dense])
  func seriousHeatGivesUpCandidates(profile: RecordProfile) {
    var ladder = DegradationLadder(profile: profile)
    #expect(ladder.update(thermal: .serious, freeDiskBytes: roomy) == [.fewerCandidates])
    #expect(!ladder.keepsCandidates)
    #expect(ladder.keepsMeshHistory)
    #expect(ladder.keepsRecording)
  }

  @Test func seriousHeatInLeanGivesUpMeshHistory() {
    var ladder = DegradationLadder(profile: .lean)
    #expect(ladder.update(thermal: .serious, freeDiskBytes: roomy) == [.noMeshHistory])
    #expect(!ladder.keepsMeshHistory)
    #expect(ladder.keepsRecording)
  }

  @Test(arguments: RecordProfile.allCases)
  func criticalHeatStopsTheRecording(profile: RecordProfile) {
    var ladder = DegradationLadder(profile: profile)
    let expected: [DegradationStep] =
      profile == .lean
      ? [.noMeshHistory, .noRecording] : [.fewerCandidates, .noMeshHistory, .noRecording]
    #expect(ladder.update(thermal: .critical, freeDiskBytes: roomy) == expected)
    #expect(ladder.steps == expected)
    #expect(!ladder.keepsCandidates)
    #expect(!ladder.keepsMeshHistory)
    #expect(!ladder.keepsRecording)
  }

  @Test(arguments: RecordProfile.allCases)
  func lowDiskStopsTheMeshHistory(profile: RecordProfile) {
    var ladder = DegradationLadder(profile: profile)
    // Exactly at the floor is not below it.
    #expect(ladder.update(thermal: .nominal, freeDiskBytes: 2 * gib).isEmpty)
    let expected: [DegradationStep] =
      profile == .lean ? [.noMeshHistory] : [.fewerCandidates, .noMeshHistory]
    #expect(ladder.update(thermal: .nominal, freeDiskBytes: 2 * gib - 1) == expected)
    #expect(ladder.keepsRecording)
  }

  @Test(arguments: RecordProfile.allCases)
  func veryLowDiskStopsTheRecording(profile: RecordProfile) {
    var ladder = DegradationLadder(profile: profile)
    let expected: [DegradationStep] =
      profile == .lean
      ? [.noMeshHistory, .noRecording] : [.fewerCandidates, .noMeshHistory, .noRecording]
    #expect(ladder.update(thermal: .nominal, freeDiskBytes: gib - 1) == expected)
    #expect(!ladder.keepsRecording)
  }

  @Test(arguments: RecordProfile.allCases)
  func stepsAreNeverLeft(profile: RecordProfile) {
    var ladder = DegradationLadder(profile: profile)
    let first = ladder.update(thermal: .serious, freeDiskBytes: roomy)
    #expect(!first.isEmpty)
    // The phone cools and disk is freed: nothing is entered again and nothing is left.
    #expect(ladder.update(thermal: .nominal, freeDiskBytes: roomy).isEmpty)
    #expect(ladder.update(thermal: .serious, freeDiskBytes: roomy).isEmpty)
    #expect(ladder.steps == first)
  }

  @Test func laterStepsAddOnlyWhatIsNew() {
    var ladder = DegradationLadder(profile: .standard)
    #expect(ladder.update(thermal: .serious, freeDiskBytes: roomy) == [.fewerCandidates])
    #expect(ladder.update(thermal: .fair, freeDiskBytes: 2 * gib - 1) == [.noMeshHistory])
    #expect(ladder.update(thermal: .critical, freeDiskBytes: roomy) == [.noRecording])
    #expect(ladder.update(thermal: .critical, freeDiskBytes: 0).isEmpty)
    #expect(ladder.steps == DegradationStep.allCases)
  }

  @Test func heatAndDiskTogetherTakeTheFurtherStep() {
    var ladder = DegradationLadder(profile: .dense)
    #expect(
      ladder.update(thermal: .serious, freeDiskBytes: gib - 1) == [
        .fewerCandidates, .noMeshHistory, .noRecording,
      ])
  }

  @Test func leanNeverEntersFewerCandidates() {
    var ladder = DegradationLadder(profile: .lean)
    for thermal in DeviceThermal.allCases {
      _ = ladder.update(thermal: thermal, freeDiskBytes: roomy)
    }
    _ = ladder.update(thermal: .nominal, freeDiskBytes: 0)
    #expect(ladder.steps == [.noMeshHistory, .noRecording])
  }

  @Test func customFloors() {
    let config = DegradationConfig(meshFloorBytes: 500_000_000, stopFloorBytes: 100_000_000)
    var ladder = DegradationLadder(profile: .standard, config: config)
    #expect(ladder.update(thermal: .nominal, freeDiskBytes: 600_000_000).isEmpty)
    #expect(
      ladder.update(thermal: .nominal, freeDiskBytes: 300_000_000) == [
        .fewerCandidates, .noMeshHistory,
      ])
    #expect(ladder.update(thermal: .nominal, freeDiskBytes: 99_999_999) == [.noRecording])
  }
}

#endif
