#if USG_RECORDER
import Foundation
import Testing

@testable import CaptureCore

/// Synthetic mesh anchor ids; ARKit's would be random. Times are frame times at 60 Hz.
private func id(_ suffix: String) -> UUID {
  UUID(
    uuidString: "00000000-0000-4000-8000-" + String(repeating: "0", count: 12 - suffix.count)
      + suffix)!
}

/// Offers every frame of `seconds` to the schedule and returns the frames that took a snapshot.
private func snapshotFrames(_ schedule: inout MeshHistorySchedule, seconds: Int) -> [Int] {
  var frames: [Int] = []
  for frame in 0..<(seconds * 60) {
    let t = Double(frame) / 60
    if schedule.isDue(at: t) {
      _ = schedule.take(at: t)
      frames.append(frame)
    }
  }
  return frames
}

@Suite struct MeshHistoryScheduleTests {
  @Test func snapshotsEveryIntervalFromTheFirstCall() {
    var lean = MeshHistorySchedule(intervalS: 5)
    #expect(snapshotFrames(&lean, seconds: 21) == [0, 300, 600, 900, 1200])
    var dense = MeshHistorySchedule(intervalS: 2)
    #expect(snapshotFrames(&dense, seconds: 7) == [0, 120, 240, 360])
  }

  @Test func theFirstCallIsDueWhenever() {
    var schedule = MeshHistorySchedule(intervalS: 5)
    #expect(schedule.isDue(at: 37.25))
    _ = schedule.take(at: 37.25)
    #expect(!schedule.isDue(at: 42.2))
    #expect(schedule.isDue(at: 42.25))
  }

  @Test func theIntervalCountsFromTheLastSnapshot() {
    var schedule = MeshHistorySchedule(intervalS: 5)
    _ = schedule.take(at: 0)
    // Taken late (the phone was busy): the next one is 5 s after that.
    _ = schedule.take(at: 6.5)
    #expect(!schedule.isDue(at: 10))
    #expect(schedule.isDue(at: 11.5))
  }

  @Test func eachSnapshotHoldsOnlyWhatChangedSinceTheLast() {
    var schedule = MeshHistorySchedule(intervalS: 5)
    schedule.anchorUpdated(id("d"))
    schedule.anchorUpdated(id("c"))
    #expect(
      schedule.take(at: 0)
        == MeshSnapshotPlan(t: 0, updated: [id("c"), id("d")], removed: [], final: false))
    #expect(schedule.take(at: 5) == MeshSnapshotPlan(t: 5, updated: [], removed: [], final: false))
  }

  @Test func updatesAndRemovalsAreDeduplicated() {
    var schedule = MeshHistorySchedule(intervalS: 2)
    for suffix in ["a", "b", "c", "d", "e"] { schedule.anchorUpdated(id(suffix)) }
    _ = schedule.take(at: 0)
    // Updated many times: once.
    schedule.anchorUpdated(id("b"))
    schedule.anchorUpdated(id("a"))
    schedule.anchorUpdated(id("b"))
    // Updated, then removed: only removed.
    schedule.anchorUpdated(id("c"))
    schedule.anchorRemoved(id("c"))
    // Removed twice: once.
    schedule.anchorRemoved(id("d"))
    schedule.anchorRemoved(id("d"))
    // Removed, then added again: only updated.
    schedule.anchorRemoved(id("e"))
    schedule.anchorUpdated(id("e"))
    #expect(
      schedule.take(at: 2)
        == MeshSnapshotPlan(
          t: 2, updated: [id("a"), id("b"), id("e")], removed: [id("c"), id("d")], final: false))
  }

  @Test func idsAreSortedByLowercaseUUID() {
    var schedule = MeshHistorySchedule(intervalS: 5)
    let ids = ["f0", "0a", "a0", "09", "ff", "10"].map(id)
    for anchor in ids { schedule.anchorUpdated(anchor) }
    let plan = schedule.take(at: 0)
    #expect(
      plan.updated.map { $0.uuidString.lowercased() }
        == ids.map { $0.uuidString.lowercased() }.sorted())
    for anchor in ids.reversed() { schedule.anchorRemoved(anchor) }
    #expect(schedule.take(at: 5).removed == plan.updated)
  }

  @Test func theFinalSnapshotHoldsEveryAnchorAndEndsTheSchedule() {
    var schedule = MeshHistorySchedule(intervalS: 5)
    for suffix in ["1", "2", "3"] { schedule.anchorUpdated(id(suffix)) }
    _ = schedule.take(at: 0)
    schedule.anchorRemoved(id("3"))
    schedule.anchorUpdated(id("4"))
    // Stop 3 s later: every remaining anchor, unchanged ones too, and the removal since the last.
    let final = schedule.takeFinal(at: 3, all: [id("4"), id("2"), id("1"), id("2")])
    #expect(
      final
        == MeshSnapshotPlan(
          t: 3, updated: [id("1"), id("2"), id("4")], removed: [id("3")], final: true))
    #expect(!schedule.isDue(at: 8))
    #expect(!schedule.isDue(at: 1000))
  }

  @Test func aFinalListingARemovedAnchorKeepsIt() {
    var schedule = MeshHistorySchedule(intervalS: 5)
    schedule.anchorUpdated(id("5"))
    _ = schedule.take(at: 0)
    schedule.anchorRemoved(id("5"))
    let final = schedule.takeFinal(at: 1, all: [id("5")])
    #expect(final.updated == [id("5")])
    #expect(final.removed.isEmpty)
  }

  @Test func aFinalBeforeAnySnapshotStillListsEverything() {
    var schedule = MeshHistorySchedule(intervalS: 5)
    let final = schedule.takeFinal(at: 0.5, all: [id("b"), id("a")])
    #expect(
      final == MeshSnapshotPlan(t: 0.5, updated: [id("a"), id("b")], removed: [], final: true))
  }
}

#endif
