#if USG_RECORDER
import Foundation
import Testing

@testable import CaptureCore

// Scripted sessions through RecorderCore and a MemorySink, one or more tests for each row of the
// state table (design section 6), and the files read back line by line through the generated
// types. Values are synthetic: a walk along the Raffles City link at 1.2 m/s.

private let meshA = testUUID(0xa)
private let meshB = testUUID(0xb)
private let marked = testUUID(0x5)

extension Harness {
  var journaled: [JournalRecord] {
    commands.compactMap { if case .journal(let record) = $0 { record } else { nil } }
  }

  var registeredCuts: [Double] {
    commands.compactMap { if case .registerCut(let t) = $0 { t } else { nil } }
  }

  var meshJobs: [MeshJob] {
    commands.compactMap { if case .mesh(let job) = $0 { job } else { nil } }
  }

  /// Two mesh anchors with geometry and a marked anchor, as the session has them at the start.
  func addAnchors() {
    anchors = [
      AnchorSnapshot(id: meshA, kind: .mesh, transform: .yaw(0, x: 0.5, y: 0, z: -2)),
      AnchorSnapshot(id: meshB, kind: .mesh, transform: .yaw(0, x: -0.5, y: 0, z: -4)),
      AnchorSnapshot(id: marked, kind: .marked, transform: .yaw(0.1, x: 0, y: 0, z: 0)),
    ]
    geometry = [meshA: stripGeometry(faces: 4), meshB: stripGeometry(faces: 6)]
  }

  /// Armed, then open at 2 s with the anchors above.
  func openAtTwo(streetFacing: Bool = false) {
    addAnchors()
    frames(from: 0, to: 1.9)
    mark(.start, at: 2, streetFacing: streetFacing)
  }
}

private func events(_ h: Harness) throws -> [RecordingEventLine] {
  try h.decode("events.jsonl", as: RecordingEventLine.self)
}

@Suite struct RecorderCoreArmedTests {
  @Test func armedHoldsEverythingInMemoryAndWritesNothing() {
    let h = Harness()
    h.addAnchors()
    h.frames(from: 0, to: 1)
    h.imu([0.5, 0.51])
    h.motion([0.5])
    h.run(h.core.altitude(AltitudeSample(t: 0.6, relativeAltitudeM: 3, pressureKpa: 101.3)))
    h.run(h.core.gnss(GnssFix(t: 0.7, lat: 1.2931, lon: 103.8558, horizontalAccuracyM: 8)))
    h.run(h.core.event(.thermal(.fair), t: 0.8))
    h.telemetry(0.9)
    h.run(h.core.action(ActionInput(call: .start, t: 0.1, args: "{}", result: nil, error: nil)))
    h.run(h.core.boundary([Harness.boundaryLine(t: 0.9, seq: 0)], final: true))
    h.core.meshUpdated(meshA)
    // An end mark before any start mark opens nothing.
    h.mark(.end, at: 1.1, endSessionHere: true)
    #expect(h.commands.isEmpty)
    #expect(h.requests.isEmpty)
    #expect(h.core.phase == .armed)
    #expect(h.sink.state == .empty)
  }

  @Test(arguments: ["stop", "discard", "background", "heat", "failure"])
  func anEndBeforeTheStartMarkKeepsNothing(_ end: String) {
    let h = Harness()
    h.frames(from: 0, to: 1)
    h.imu([0.5])
    switch end {
    case "stop": h.stop(at: 1.1)
    case "discard": h.run(h.core.discard())
    case "background": h.run(h.core.close(at: 1, reason: .background))
    case "heat": h.telemetry(1, thermal: .critical)
    default: h.run(h.core.close(at: 1, reason: .disk))
    }
    #expect(h.commands.isEmpty)
    if end == "heat" {
      // The ladder isn't run before the recording opens: nothing is recorded to step down.
      #expect(h.core.phase == .armed)
    } else {
      #expect(h.core.phase == .discarded)
      // And a start mark afterwards opens nothing.
      h.mark(.start, at: 1.2)
      #expect(h.commands.isEmpty)
    }
  }
}

@Suite struct RecorderCoreOpenTests {
  @Test func theFirstStartMarkOpensTheRecordingInTheTablesOrder() throws {
    let h = Harness()
    h.addAnchors()
    h.frames(from: 0, to: 1.95)
    // Samples reach the capture queue in batches, so some from the mark on come before it.
    h.imu([1.0, 1.5, 1.99, 2.0, 2.01, 2.05])
    h.motion([1.5, 2.02])
    h.run(h.core.altitude(AltitudeSample(t: 1.25, relativeAltitudeM: 3, pressureKpa: 101.3)))
    h.run(h.core.altitude(AltitudeSample(t: 2.03, relativeAltitudeM: 3.4, pressureKpa: 101.29)))
    for t in [0.5, 1.5] {
      h.run(h.core.gnss(GnssFix(t: t, lat: 1.29318, lon: 103.85288, horizontalAccuracyM: 8)))
    }
    let opened = h.mark(.start, at: 2, streetFacing: true)

    guard case .createRecording(let id, let journalOpen, let manifest)? = opened.first else {
      Issue.record("the first command creates the recording")
      return
    }
    #expect(id == recordingUUID)
    #expect(
      journalOpen
        == .open(
          JournalOpen(
            id: recordingUUID, startT: 2, profile: .lean, marginS: 5, idleS: 3, maxS: 120)))
    #expect(h.core.phase == .open)
    #expect(h.requests == [.everyMeshAnchor])

    // recording.json at open: every null written.
    let object = try #require(try JSONSerialization.jsonObject(with: manifest) as? [String: Any])
    #expect(object["rates"] is NSNull)
    #expect(object["detector_versions"] is NSNull)
    #expect(object["closed"] as? Bool == false)
    #expect((object["files"] as? [Any])?.isEmpty == true)
    let window = try #require(object["window"] as? [String: Any])
    #expect(window["end_t"] is NSNull)
    #expect(window["ended"] is NSNull)
    #expect(window["start_t"] as? Double == 2)

    let opening = try events(h)
    #expect(opening.map(\.t).allSatisfy { $0 == 2 })
    #expect(opening.map(\.kind.rawValue).first == "recording_opened")
    #expect(
      opening.dropFirst().map(\.detail) == [
        "lean", "mesh_with_classification", "smoothed_scene_depth", "gravity",
        "video_1920x1440_60", "motion_x_magnetic_north_z_vertical", "gnss_t_fix_age",
        "margin_5s", "idle_3s",
      ])
    // The pre-open buffer gives up only what is at or after the mark.
    #expect(try h.decode("imu.jsonl", as: ImuLine.self).map(\.t) == [2, 2.01, 2.05])
    #expect(try h.decode("motion.jsonl", as: MotionLine.self).map(\.t) == [2.02])
    let altitude = try h.decode("altitude.jsonl", as: AltitudeLine.self)
    #expect(altitude.map(\.t) == [2.03])
    #expect(altitude.map(\.relativeM) == [0])
    let frames = try h.decode("frames.jsonl", as: RecordingFrameLine.self)
    #expect(frames.map(\.t) == [2])
    #expect(frames.map(\.gap) == [0])
    // The baseline: every anchor an add, and every mesh anchor's geometry.
    let anchors = try h.decode("anchors.jsonl", as: AnchorHistoryLine.self)
    #expect(anchors.map(\.op) == [.add, .add, .add])
    #expect(anchors.allSatisfy { $0.t == 2 && $0.anchorHistoryLineFinal == false })
    let mesh = try h.decode("mesh/history.jsonl", as: MeshHistoryLine.self)
    #expect(mesh.map(\.anchor) == [meshA, meshB].map { $0.uuidString.lowercased() })
    #expect(mesh.map(\.op) == [.add, .add])
    #expect(mesh.map(\.offset) == [0, mesh[0].bytes])
    #expect(mesh.map(\.faces) == [4, 6])
    // GNSS from before the open is never written, even inside the street anchor's window.
    #expect(h.sink.file("location.jsonl") == nil)
    h.frame(2.4)
    h.run(h.core.gnss(GnssFix(t: 2.5, lat: 1.29318, lon: 103.85288, horizontalAccuracyM: 8)))
    #expect(try h.decode("location.jsonl", as: GnssLine.self).map(\.t) == [2.5])
    try checkShapes(h.sink)
  }

  @Test func anEndMarkIsJournaledAndArmsTheCut() {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 9.99)
    let result = h.mark(.end, at: 10)
    #expect(result.count == 2)
    #expect(h.journaled == [.end(t: 10)])
    #expect(h.registeredCuts == [15])
    #expect(h.core.phase == .open)
    // A later end mark moves the cut.
    h.frames(from: 10.0167, to: 11.99)
    h.mark(.end, at: 12)
    #expect(h.journaled == [.end(t: 10), .end(t: 12)])
    #expect(h.registeredCuts == [15, 17])
    // A start mark while open changes nothing.
    #expect(h.mark(.start, at: 12.5).isEmpty)
  }

  @Test func snapshotsEveryFiveSecondsWriteOnlyWhatChanged() throws {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 4)
    h.geometry[meshA] = stripGeometry(faces: 8)
    h.core.meshUpdated(meshA)
    // meshB only moved: ARKit reports it updated, but the geometry is the same.
    h.anchors[1] = AnchorSnapshot(
      id: meshB, kind: .mesh, transform: .yaw(0, x: -0.5, y: 0, z: -4.01))
    h.core.meshUpdated(meshB)
    h.frames(from: 4.0167, to: 7)
    #expect(h.requests.last == .anchors([meshA, meshB]))
    let mesh = try h.decode("mesh/history.jsonl", as: MeshHistoryLine.self)
    #expect(mesh.count == 3)
    #expect(mesh[2].op == .update)
    #expect(mesh[2].t == 7)
    #expect(mesh[2].faces == 8)
    #expect(h.sink.meshRunner.counts.unchanged == 1)
    // The move is in anchors.jsonl.
    let anchors = try h.decode("anchors.jsonl", as: AnchorHistoryLine.self)
    #expect(anchors.last?.op == .update)
    #expect(anchors.last?.anchor == meshB.uuidString.lowercased())
    // A removal is written once, for an anchor that had a block.
    h.anchors.remove(at: 0)
    h.core.meshRemoved(meshA)
    h.core.meshRemoved(testUUID(0xdead))
    h.frames(from: 7.0167, to: 12)
    let after = try h.decode("mesh/history.jsonl", as: MeshHistoryLine.self)
    #expect(after.count == 4)
    #expect(after[3].op == .remove)
    #expect(after[3].offset == nil)
    try checkShapes(h.sink)
  }

  @Test func aBusyMeshQueuePutsTheSnapshotOff() {
    let h = Harness()
    h.openAtTwo()
    h.core.meshQueueIdle = false
    h.core.meshUpdated(meshA)
    h.frames(from: 2.0167, to: 7.5)
    #expect(h.meshJobs.count == 1)
    h.core.meshQueueIdle = true
    h.frame(7.6)
    #expect(h.meshJobs.count == 2)
    #expect(h.meshJobs[1].copies.map(\.id) == [meshA])
  }
}

@Suite struct RecorderCoreEndTests {
  /// Open at 2 and End the session here at 10: closing until 15.
  private func closingAtTen() -> Harness {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 9.99)
    h.mark(.end, at: 10, endSessionHere: true)
    return h
  }

  @Test func endTheSessionHereClosesOnTheFrameAtTheDeadline() throws {
    let h = closingAtTen()
    #expect(h.journaled == [.end(t: 10), .closing(deadline: 15)])
    #expect(h.core.phase == .closing(deadline: 15))
    // After the 12 s snapshot meshA changes, so the final snapshot copies it.
    h.frames(from: 10.0167, to: 13)
    h.core.meshUpdated(meshA)
    h.geometry[meshA] = stripGeometry(faces: 10)
    h.frames(from: 13.0167, to: 15.5)
    // 14.983333 + 1.5/60 reaches 15: the window ends on that real frame (D16).
    let endT = micro(899.0 / 60)
    let order = try #require(h.finalizeOrder)
    #expect(
      order.window
        == WindowClose(startT: 2, endT: endT, reason: .endAnchor, trimmed: false, finalSample: true)
    )
    #expect(order.awaitBoundary)
    #expect(!order.useCut)
    #expect(h.stopSessionCount == 1)
    #expect(h.core.phase == .finalizing(order.window))
    #expect(try h.decode("frames.jsonl", as: RecordingFrameLine.self).last?.t == endT)

    // The final sample: marked anchors in anchors.jsonl, every mesh anchor in the mesh history.
    let anchors = try h.decode("anchors.jsonl", as: AnchorHistoryLine.self)
    let finalAnchors = anchors.filter { $0.anchorHistoryLineFinal }
    #expect(finalAnchors.map(\.anchor) == [marked.uuidString.lowercased()])
    #expect(finalAnchors.allSatisfy { $0.t == endT && $0.op == .update && $0.captureID == nil })
    let mesh = try h.decode("mesh/history.jsonl", as: MeshHistoryLine.self)
    let finalMesh = mesh.filter { $0.meshHistoryLineFinal }
    #expect(finalMesh.map(\.anchor) == [meshA, meshB].map { $0.uuidString.lowercased() })
    #expect(finalMesh.allSatisfy { $0.t == endT && $0.op == .update })
    // meshA changed and was copied; meshB reused its block (D6).
    #expect(h.requests.last == .anchors([meshA]))
    #expect(finalMesh.map(\.faces) == [10, 6])
    let bin = try #require(h.sink.file("mesh/history.bin"))
    let baselineB = mesh[1]
    let reusedB = finalMesh[1]
    #expect(reusedB.bytes == baselineB.bytes)
    let blockAt = { (line: MeshHistoryLine) in
      bin.subdata(in: line.offset!..<(line.offset! + line.bytes!))
    }
    #expect(blockAt(reusedB) == blockAt(baselineB))
    let closedEvent = try #require(try events(h).last)
    #expect(closedEvent.kind == .recordingClosed && closedEvent.detail == "end_anchor")
    #expect(closedEvent.t == endT)

    // Frames after the close are not recorded; the final boundary flush finishes the files.
    #expect(h.frame(15.6).isEmpty)
    #expect(h.sink.state == .awaitingBoundary)
    h.run(h.core.boundary([Harness.boundaryLine(t: endT, seq: 0, kind: "recording")], final: true))
    #expect(h.sink.state == .finished)
    #expect(h.core.phase == .closed(order.window))
    let manifest = try h.manifest()
    #expect(manifest.closed)
    #expect(manifest.window.endT == endT)
    #expect(manifest.window.ended == .endAnchor)
    #expect(!manifest.window.trimmed)
    #expect(manifest.rates?.meshIntervalS != nil)
    #expect(
      h.sink.journal.suffix(2) == [
        .closed(JournalClosed(endT: endT, reason: .endAnchor, trimmed: false, finalSample: true)),
        .manifest,
      ])
    #expect(h.sink.journalDeleted)
    try checkShapes(h.sink)
  }

  @Test func aFrameGapPastTheDeadlineStillTakesTheFinalSampleAtTheDeadline() throws {
    let h = closingAtTen()
    h.frames(from: 10.0167, to: 14.9)
    // ARKit skips frames: the next one is past the deadline.
    h.frame(15.3)
    let order = try #require(h.finalizeOrder)
    #expect(order.window.reason == .endAnchor)
    #expect(order.window.endT == 15)
    #expect(order.window.finalSample)
    #expect(h.stopSessionCount == 1)
    #expect(try h.decode("frames.jsonl", as: RecordingFrameLine.self).last?.t == 14.9)
    let finalLines = try h.decode("anchors.jsonl", as: AnchorHistoryLine.self).filter {
      $0.anchorHistoryLineFinal
    }
    #expect(!finalLines.isEmpty)
    #expect(finalLines.allSatisfy { $0.t == 15 })
    #expect(h.core.counts.outsideWindow >= 1)
  }

  @Test func stopWhileClosingEndsAtTheStopWithAFinalSample() throws {
    let h = closingAtTen()
    h.frames(from: 10.0167, to: 12)
    h.stop(at: 12.5)
    let order = try #require(h.finalizeOrder)
    #expect(
      order.window
        == WindowClose(startT: 2, endT: 12.5, reason: .endAnchor, trimmed: false, finalSample: true)
    )
    // The session is stopping already.
    #expect(h.stopSessionCount == 0)
    let final = try h.decode("mesh/history.jsonl", as: MeshHistoryLine.self).filter {
      $0.meshHistoryLineFinal
    }
    #expect(final.count == 2)
  }

  @Test func stopWhileOpenCutsBackToTheEndAnchorWithoutAFinalSample() throws {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 9.99)
    h.mark(.end, at: 10)
    h.frames(from: 10.0167, to: 19.9)
    h.imu([16, 17, 18])
    h.run(h.core.event(.memoryWarning, t: 18))
    h.stop(at: 20)
    let order = try #require(h.finalizeOrder)
    #expect(
      order.window
        == WindowClose(startT: 2, endT: 15, reason: .stop, trimmed: true, finalSample: false))
    #expect(order.useCut)
    #expect(h.stopSessionCount == 0)
    h.run(h.core.boundary([], final: true))
    #expect(h.sink.state == .finished)
    // Nothing past the end anchor plus the margin is left, and there is no final line.
    for (path, times) in try lineTimes(h.sink) {
      #expect(times.allSatisfy { $0 >= 2 && $0 <= 15 }, "\(path)")
    }
    #expect(
      try h.decode("anchors.jsonl", as: AnchorHistoryLine.self).allSatisfy {
        !$0.anchorHistoryLineFinal
      })
    #expect(
      try h.decode("mesh/history.jsonl", as: MeshHistoryLine.self).allSatisfy {
        !$0.meshHistoryLineFinal
      })
    let closedEvent = try #require(try events(h).last)
    #expect(closedEvent.kind == .recordingClosed && closedEvent.detail == "stop")
    #expect(closedEvent.t == 15)
    let manifest = try h.manifest()
    #expect(manifest.closed)
    #expect(manifest.window.trimmed)
    #expect(manifest.window.ended == .stop)
    try checkShapes(h.sink)
  }

  @Test func stopWithinTheMarginEndsAtTheStop() throws {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 9.99)
    h.mark(.end, at: 10)
    h.frames(from: 10.0167, to: 11.9)
    h.stop(at: 12)
    let order = try #require(h.finalizeOrder)
    #expect(
      order.window
        == WindowClose(startT: 2, endT: 12, reason: .stop, trimmed: false, finalSample: false))
    #expect(!order.useCut)
  }

  @Test(arguments: [false, true])
  func stopWithoutAnEndAnchorOrDiscardDeletesTheRecording(_ discard: Bool) {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 8)
    let commands = discard ? h.run(h.core.discard()) : h.stop(at: 8.5)
    #expect(commands.count == 2)
    #expect(h.journaled == [.discard])
    guard case .deleteRecording(let id)? = commands.last else {
      Issue.record("the last command deletes the recording")
      return
    }
    #expect(id == recordingUUID)
    #expect(h.core.phase == .discarded)
    #expect(h.sink.state == .deleted)
    #expect(h.sink.paths.isEmpty)
    // Nothing is recorded after it.
    #expect(h.frame(9).isEmpty)
    #expect(h.imu([9.1]).isEmpty)
  }

  @Test func discardWhileClosingDeletesTheRecording() {
    let h = closingAtTen()
    h.frames(from: 10.0167, to: 12)
    h.run(h.core.discard())
    #expect(h.journaled.last == .discard)
    #expect(h.sink.state == .deleted)
  }

  @Test func idleClosesWithAFinalSampleAndTheSessionGoesOn() throws {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 5)
    h.speed = 0
    h.frames(from: 5.0167, to: 10)
    let order = try #require(h.finalizeOrder)
    #expect(order.window.reason == .idle)
    #expect(order.window.finalSample)
    #expect(order.window.endT > 7.4 && order.window.endT <= 8.1)
    #expect(h.stopSessionCount == 0)
    let finalLines = try h.decode("anchors.jsonl", as: AnchorHistoryLine.self).filter {
      $0.anchorHistoryLineFinal
    }
    #expect(finalLines.allSatisfy { $0.t == order.window.endT })
    #expect(!finalLines.isEmpty)
  }
}

@Suite struct RecorderCoreCloseWithoutSampleTests {
  @Test func backgroundClosesAtTheLastFrameWithoutWaitingOrAFinalSample() throws {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 6)
    h.imu([6.005])
    h.run(h.core.close(at: 6.2, reason: .background))
    let order = try #require(h.finalizeOrder)
    #expect(
      order.window
        == WindowClose(startT: 2, endT: 6, reason: .background, trimmed: false, finalSample: false))
    #expect(!order.awaitBoundary)
    // A background close doesn't wait for the boundary flush.
    #expect(h.sink.state == .finished)
    #expect(try h.decode("imu.jsonl", as: ImuLine.self).isEmpty)
    #expect(
      try h.decode("anchors.jsonl", as: AnchorHistoryLine.self).allSatisfy {
        !$0.anchorHistoryLineFinal
      })
    #expect(h.run(h.core.boundary([Harness.boundaryLine(t: 5, seq: 0)], final: true)).isEmpty)
    #expect(try h.manifest().window.ended == .background)
    try checkShapes(h.sink)
  }

  @Test func criticalHeatStepsDownTheLadderThenClosesAsHeat() throws {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 6)
    h.telemetry(6.5, thermal: .critical)
    let order = try #require(h.finalizeOrder)
    #expect(order.window.reason == .heat)
    #expect(order.window.endT == 6)
    #expect(!order.window.finalSample)
    let lines = try events(h).filter { $0.kind == .degradation }
    // Lean has no candidates to give up, so it starts at no_mesh_history.
    #expect(lines.map(\.detail) == ["no_mesh_history", "no_recording"])
    #expect(lines.allSatisfy { $0.t == 6 })
    #expect(try events(h).last?.detail == "heat")
  }

  /// The thermal notification comes between frames, so its `t` is past the last frame, where the
  /// close ends the window. The lines that say why still make it into the recording.
  @Test func aCriticalThermalEventAfterTheLastFrameKeepsWhyItClosed() throws {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 6)
    h.run(h.core.event(.thermal(.critical), t: 6.5))
    let order = try #require(h.finalizeOrder)
    #expect(order.window.reason == .heat)
    #expect(order.window.endT == 6)
    let tail = try events(h).suffix(4)
    #expect(tail.map(\.kind) == [.thermal, .degradation, .degradation, .recordingClosed])
    #expect(tail.map(\.detail) == ["critical", "no_mesh_history", "no_recording", "heat"])
    #expect(tail.allSatisfy { $0.t == 6 })
    try checkShapes(h.sink)
  }

  /// An events line already past the last frame (a memory warning) doesn't drag the steps past
  /// the window's end with it.
  @Test func anEventPastTheLastFrameDoesntTakeTheStepsWithIt() throws {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 6)
    h.run(h.core.event(.memoryWarning, t: 6.3))
    h.telemetry(6.5, thermal: .critical)
    let order = try #require(h.finalizeOrder)
    #expect(order.window.endT == 6)
    let tail = try events(h).suffix(3)
    #expect(tail.map(\.detail) == ["no_mesh_history", "no_recording", "heat"])
    #expect(tail.allSatisfy { $0.t == 6 })
  }

  @Test func lowDiskStopsTheMeshHistoryFirstThenClosesAsDisk() throws {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 3)
    h.telemetry(3.5, freeDisk: 3 << 29)
    #expect(try events(h).last?.detail == "no_mesh_history")
    #expect(h.core.phase == .open)
    h.core.meshUpdated(meshA)
    h.frames(from: 3.0167, to: 7.5)
    // The snapshot still samples anchors.jsonl but writes no mesh.
    #expect(h.meshJobs.count == 1)
    #expect(h.requests.last == GeometryRequest.none)
    h.telemetry(7.6, freeDisk: 1 << 29)
    let order = try #require(h.finalizeOrder)
    #expect(order.window.reason == .disk)
    #expect(
      try events(h).filter { $0.kind == .degradation }.map(\.detail) == [
        "no_mesh_history", "no_recording",
      ])
  }

  @Test func afterNoMeshHistoryTheFinalSampleHasNoMeshPart() throws {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 3)
    h.run(h.core.event(.thermal(.serious), t: 3))
    h.frames(from: 3.0167, to: 9.99)
    h.mark(.end, at: 10, endSessionHere: true)
    h.frames(from: 10.0167, to: 15.2)
    let order = try #require(h.finalizeOrder)
    #expect(order.window.finalSample)
    #expect(h.meshJobs.count == 1)
    #expect(h.requests.last == GeometryRequest.none)
    #expect(
      try h.decode("anchors.jsonl", as: AnchorHistoryLine.self).contains {
        $0.anchorHistoryLineFinal
      })
    #expect(
      try h.decode("mesh/history.jsonl", as: MeshHistoryLine.self).allSatisfy {
        !$0.meshHistoryLineFinal
      })
  }

  @Test func theLongestSessionClosesAsLimitAtTheLimit() throws {
    let h = Harness(
      config: RecorderConfig(
        window: RecorderWindowConfig(
          endMarginS: 5, idleTimeoutS: 60, idleRadiusM: 0.5, maxSessionS: 10)))
    h.openAtTwo()
    h.frames(from: 2.0167, to: 11.9)
    h.frame(12.5)
    let order = try #require(h.finalizeOrder)
    #expect(
      order.window
        == WindowClose(startT: 2, endT: 12, reason: .limit, trimmed: false, finalSample: false))
    #expect(h.stopSessionCount == 0)
  }

  @Test func aFramePastTheLastIndexClosesAsLimit() throws {
    let h = Harness(config: RecorderConfig(window: testWindow, maxFrameIndex: 200))
    h.openAtTwo()
    h.frames(from: 2.0167, to: 3.5)
    let lastIndex = try #require(try h.decode("frames.jsonl", as: RecordingFrameLine.self).last)
    #expect(lastIndex.frame == 200)
    let order = try #require(h.finalizeOrder)
    #expect(order.window.reason == .limit)
    #expect(order.window.endT == lastIndex.t)
  }

  @Test(arguments: [WindowEndReason.limit, .disk])
  func theSinkCanCloseForLimitOrDisk(_ reason: WindowEndReason) throws {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 4)
    h.run(h.core.sinkLimitReached(reason))
    let order = try #require(h.finalizeOrder)
    #expect(
      order.window
        == WindowClose(startT: 2, endT: 4, reason: reason, trimmed: false, finalSample: false))
  }

  @Test func closeIgnoresTheReasonsOnlyTheWindowGives() {
    let h = Harness()
    h.openAtTwo()
    for reason in [WindowEndReason.endAnchor, .stop, .idle, .interrupted] {
      #expect(h.run(h.core.close(at: 3, reason: reason)).isEmpty)
    }
    #expect(h.core.sinkLimitReached(.background).isEmpty)
    #expect(h.core.phase == .open)
  }
}

@Suite struct RecorderCoreStreamTests {
  @Test func boundaryLinesAreCheckedAndNumberedFromTheOpen() throws {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 4)
    let lines = [
      Harness.boundaryLine(t: 1.9, seq: 0),  // before the window
      Harness.boundaryLine(t: 2.1, seq: 0),
      Harness.boundaryLine(t: 2.2, seq: 0),  // seq not increasing
      Harness.boundaryLine(t: 2.3, seq: 2),  // a gap is fine
      Harness.boundaryLine(t: 2.25, seq: 3),  // t going back
      "not json",
    ]
    h.run(h.core.boundary(lines, final: false))
    let written = try h.decode("boundary.jsonl", as: BoundarySeq.self)
    #expect(written.map(\.seq) == [0, 2])
    #expect(h.core.counts.boundaryRefused == 4)
    // A final flush while open is only a flush.
    #expect(h.run(h.core.boundary([], final: true)).isEmpty)
  }

  @Test func theFinalFlushIsTakenAfterAForegroundCloseThenNothing() throws {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 9.99)
    h.mark(.end, at: 10)
    h.frames(from: 10.0167, to: 11.9)
    h.stop(at: 12)
    #expect(h.sink.state == .awaitingBoundary)
    let flushed = h.run(
      h.core.boundary(
        [Harness.boundaryLine(t: 11.5, seq: 0), Harness.boundaryLine(t: 12.5, seq: 1)],
        final: true))
    #expect(flushed.count == 2)
    #expect(try h.decode("boundary.jsonl", as: BoundarySeq.self).map(\.t) == [11.5])
    #expect(h.sink.state == .finished)
    #expect(h.run(h.core.boundary([Harness.boundaryLine(t: 11.8, seq: 2)], final: true)).isEmpty)
  }

  @Test func aMissingFlushExpires() {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 9.99)
    h.mark(.end, at: 10)
    h.stop(at: 12)
    #expect(h.sink.state == .awaitingBoundary)
    h.sink.boundaryWaitExpired()
    #expect(h.sink.state == .finished)
  }

  @Test func actionsAreTheSessionsCallsOnlyInsideTheWindow() throws {
    // The plumbing (appendBoundary, listRecordings, exportRecording, deleteRecording) has no case.
    #expect(
      SessionCall.allCases.map(\.rawValue) == ["start", "markAnchor", "addTag", "stop", "discard"])
    let h = Harness()
    h.run(
      h.core.action(
        ActionInput(call: .start, t: 0.1, args: #"{"record":"lean"}"#, result: "null", error: nil)))
    h.openAtTwo()
    h.run(
      h.core.action(
        ActionInput(
          call: .markAnchor, t: 2, args: #"{"role":"start"}"#, result: #"{"window":"opened"}"#,
          error: nil)))
    h.frames(from: 2.0167, to: 4)
    h.run(
      h.core.action(
        ActionInput(call: .addTag, t: 3.5, args: "{}", result: nil, error: "ERR_TRACKING")))
    // Resolved late: stamped so the file doesn't go back.
    h.run(
      h.core.action(
        ActionInput(call: .markAnchor, t: 3.4, args: "{}", result: nil, error: "bad code!")))
    let actions = try h.decode("actions.jsonl", as: ActionLine.self)
    #expect(actions.map(\.call) == ["markAnchor", "addTag", "markAnchor"])
    #expect(actions.map(\.t) == [2, 3.5, 3.5])
    #expect(actions.map(\.error) == [nil, "ERR_TRACKING", "ERR_INVALID_CODE"])
  }

  @Test func eventsAreClampedAndTheRecordersOwnAreRefused() throws {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 4)
    for event in [
      RecordingEvent.recordingOpened, .recordingClosed(.stop), .configuration(.lean),
      .degradation(.noRecording),
    ] {
      #expect(h.run(h.core.event(event, t: 3)).isEmpty)
    }
    #expect(h.core.counts.ignoredEvents == 4)
    h.run(h.core.event(.screenshot, t: 3.5))
    h.run(h.core.event(.foreground, t: 3.2))
    let tail = try events(h).suffix(2)
    #expect(tail.map(\.kind) == [.screenshot, .foreground])
    #expect(tail.map(\.t) == [3.5, 3.5])
  }

  @Test func samplesOutsideTheWindowOrOutOfOrderAreDropped() throws {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 4)
    h.imu([3.0, 3.0, 2.99, 1.5, 3.01])
    #expect(try h.decode("imu.jsonl", as: ImuLine.self).map(\.t) == [3, 3.01])
    #expect(h.core.counts.nonIncreasing >= 2)
    #expect(h.core.counts.outsideWindow >= 1)
  }

  @Test func withoutDeviceMotionMotionStaysEmpty() throws {
    let h = Harness(motion: nil)
    h.motion([1.0])
    h.openAtTwo()
    h.motion([2.5])
    #expect(h.sink.file("motion.jsonl") == Data())
    // The module knew it when the sensors started, while armed: the event is written at the open.
    #expect(try events(h).filter { $0.kind == .motionUnavailable }.map(\.t) == [2])
    #expect(try events(h).contains { $0.detail?.hasPrefix("motion_") == true } == false)
    #expect(try h.manifest().motion == nil)
    // Only the recorder writes it.
    #expect(h.run(h.core.event(.motionUnavailable, t: 3)).isEmpty)
  }

  @Test(arguments: [AltimeterStatus.unavailable, .denied])
  func withoutTheAltimeterAnEventSaysWhy(_ altimeter: AltimeterStatus) throws {
    let h = Harness(altimeter: altimeter)
    h.openAtTwo()
    h.run(h.core.altitude(AltitudeSample(t: 2.5, relativeAltitudeM: 0.2, pressureKpa: 101.3)))
    let expected: RecordingEventKind =
      altimeter == .denied ? .altimeterDenied : .altimeterUnavailable
    #expect(try events(h).filter { $0.kind == expected }.map(\.t) == [2])
    #expect(h.sink.file("altitude.jsonl") == nil)
    for event in [RecordingEvent.altimeterUnavailable, .altimeterDenied] {
      #expect(h.run(h.core.event(event, t: 3)).isEmpty)
    }
    #expect(try events(h).filter { $0.kind == expected }.count == 1)
  }
}

/// A boundary line's number and time.
private struct BoundarySeq: Decodable {
  let seq: Int
  let t: Double
}

@Suite struct RecorderCorePrivacyTests {
  /// Design 12: nothing before the window, nothing past it, from a session with input on every
  /// stream before the start mark and after the close, and samples outside the window while it
  /// is open, which only `RecorderWindow.accepts` stops. Checked on every line the core hands
  /// out, not only on the files, which the sink cuts back to the end on its own.
  @Test func noLineIsOutsideTheWindow() throws {
    let maxSessionS = 20.0
    let h = Harness(
      config: RecorderConfig(
        window: RecorderWindowConfig(
          endMarginS: 5, idleTimeoutS: 3, idleRadiusM: 0.5, maxSessionS: maxSessionS)))
    h.addAnchors()
    for t in stride(from: 0.0, to: 2.0, by: 0.25) {
      h.frame(t)
      h.imu([t + 0.001])
      h.motion([t + 0.002])
      h.run(
        h.core.gnss(GnssFix(t: t + 0.003, lat: 1.29318, lon: 103.85288, horizontalAccuracyM: 8)))
      h.telemetry(t + 0.004)
      h.run(h.core.event(.memoryWarning, t: t + 0.005))
      h.run(
        h.core.action(ActionInput(call: .addTag, t: t + 0.006, args: "{}", result: nil, error: nil))
      )
    }
    h.mark(.start, at: 2, streetFacing: true)
    // Late batches from before the mark, before any later line in their files.
    h.imu([1.95])
    h.motion([1.95])
    var planted = 2
    for i in 121..<720 {
      let t = micro(Double(i) / 60)
      if i == 300 {
        // Past the longest session while the window is still open.
        h.telemetry(2 + maxSessionS + 0.5)
        h.imu([2 + maxSessionS + 0.5])
        planted += 2
      }
      h.frame(t)
      h.imu([micro(t + 0.001)])
      h.run(
        h.core.gnss(
          GnssFix(t: micro(t + 0.003), lat: 1.29318, lon: 103.85288, horizontalAccuracyM: 8)))
      if i == 600 { h.run(h.core.mark(MarkInput(role: .end), readAnchors: h.read)) }
    }
    h.stop(at: 12.5)
    for later in [13.0, 14.0] {
      h.frame(later)
      h.imu([later])
      h.telemetry(later)
    }
    h.run(h.core.boundary([], final: true))
    #expect(h.sink.state == .finished)
    let manifest = try h.manifest()
    let startT = manifest.window.startT
    let endT = try #require(manifest.window.endT)
    #expect(h.core.counts.outsideWindow == planted)
    let handedOut = h.commands.flatMap { command -> [PendingLine] in
      switch command {
      case .lines(let lines): lines
      case .finalize(let order): order.closingLines
      default: []
      }
    }
    #expect(!handedOut.isEmpty)
    for line in handedOut {
      #expect(
        line.t >= startT && line.t <= startT + maxSessionS,
        "a \(line.file.rawValue) line the window doesn't accept")
    }
    for (path, times) in try lineTimes(h.sink) {
      #expect(times.allSatisfy { $0 >= startT && $0 <= endT }, "\(path) stays in the window")
    }
    #expect(try h.decode("location.jsonl", as: GnssLine.self).allSatisfy { $0.t >= 2 })
    #expect(try checkShapes(h.sink) > 0)
  }
}

/// What the app's RecorderHost needs besides the state table: the samples Core Motion still held
/// when the window closed (design section 4, the chained finalize), and the steps for the status.
@Suite struct RecorderCoreHostTests {
  private func imuSample(_ t: Double) -> ImuSample {
    ImuSample(t: t, accelG: SIMD3(0, -1, 0), gyro: SIMD3(0, 0, 0.01))
  }

  private func motionSample(_ t: Double) -> MotionSample {
    MotionSample(
      t: t, attitude: SIMD4(0, 0, 0, 1), gravityG: SIMD3(0, 0, -1), userAccelG: SIMD3(0, 0, 0),
      rotation: SIMD3(0, 0, 0), magneticField: SIMD3(12.5, -31.25, -18.75),
      magneticAccuracy: .high, heading: 90)
  }

  /// The host holds the finalize until the motion queue's last batch is in: those samples, up to
  /// `end_t`, land ahead of it; the rest are dropped as outside the window.
  @Test func lateSamplesLandUpToTheEndAheadOfTheFinalize() throws {
    let h = Harness()
    h.openAtTwo()
    h.frames(from: 2.0167, to: 6)
    h.imu([5.99])
    // The close's commands, held back from the sink as the host holds them.
    let closing = h.core.close(at: 6.2, reason: .background)
    #expect(h.core.phase != .open)
    // The ordinary paths refuse them once the window has closed.
    #expect(h.core.imu([imuSample(5.995)]).isEmpty)
    let outsideBefore = h.core.counts.outsideWindow
    let late = h.core.lateSamples(
      imu: [imuSample(5.995), imuSample(6), imuSample(6.01)],
      motion: [motionSample(5.996), motionSample(6.2)],
      altitude: [AltitudeSample(t: 5.997, relativeAltitudeM: 0.25, pressureKpa: 101.3)])
    #expect(h.core.counts.outsideWindow == outsideBefore + 2)
    h.run(late + closing)
    #expect(h.sink.state == .finished)
    #expect(try h.decode("imu.jsonl", as: ImuLine.self).map(\.t) == [5.99, 5.995, 6])
    #expect(try h.decode("motion.jsonl", as: MotionLine.self).map(\.t) == [5.996])
    let altitude = try h.decode("altitude.jsonl", as: AltitudeLine.self)
    #expect(altitude.map(\.t) == [5.997])
    #expect(try h.manifest().window.endT == 6)
    // Closed: nothing more.
    #expect(h.core.lateSamples(imu: [imuSample(5.999)], motion: [], altitude: []).isEmpty)
    try checkShapes(h.sink)
  }

  @Test func lateSamplesAreRefusedUnlessTheWindowHasClosed() {
    let h = Harness()
    h.frames(from: 0, to: 0.5)
    #expect(h.core.lateSamples(imu: [imuSample(0.4)], motion: [], altitude: []).isEmpty)
    h.openAtTwo()
    h.frames(from: 2.0167, to: 3)
    #expect(h.core.lateSamples(imu: [imuSample(2.9)], motion: [], altitude: []).isEmpty)
    #expect(h.lines("imu.jsonl").isEmpty)
  }

  @Test func theStepsTakenAreReadableForTheStatus() {
    let h = Harness()
    h.openAtTwo()
    #expect(h.core.degradationSteps.isEmpty)
    h.run(h.core.event(.thermal(.serious), t: 2.1))
    #expect(h.core.degradationSteps == [.noMeshHistory])
  }
}
#endif
