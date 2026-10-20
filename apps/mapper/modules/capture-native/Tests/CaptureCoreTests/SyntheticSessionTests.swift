#if USG_RECORDER
import Foundation
import Testing

@testable import CaptureCore

// The synthetic session through RecorderCore into a MemorySink: deterministic, and a whole lean
// recording whose every file has the schemas' shapes and stays inside its window.

/// Runs the session to the end and returns the finished sink.
private func record(_ session: SyntheticSession) -> (RecorderCore, MemorySink) {
  let core = session.makeRecorder()
  let sink = MemorySink(digest: sha256Hex, deflate: storedDeflate)
  session.drive(core) { sink.apply($0) }
  if sink.state == .finished { core.finalizeCompleted() }
  return (core, sink)
}

private func files(_ sink: MemorySink) -> [String: Data] {
  Dictionary(uniqueKeysWithValues: sink.paths.map { ($0, sink.file($0) ?? Data()) })
}

@Suite struct SyntheticSessionTests {
  @Test func theSameSeedGivesTheSameBytes() {
    let first = record(SyntheticSession(seed: 7, durationS: 30)).1
    let second = record(SyntheticSession(seed: 7, durationS: 30)).1
    #expect(files(first) == files(second))
    let other = record(SyntheticSession(seed: 8, durationS: 30)).1
    #expect(files(first)["frames.jsonl"] != files(other)["frames.jsonl"])
  }

  @Test func aWholeLeanRecordingClosesAtEndTheSessionHere() throws {
    let session = SyntheticSession(seed: 1, durationS: 60)
    let (core, sink) = record(session)
    #expect(sink.state == .finished)
    #expect(sink.stopSessionCount == 1)
    guard case .closed(let close) = core.phase else {
      Issue.record("the recording closed")
      return
    }
    // The end mark at 52 s, the 5 s margin, the first frame within 1.5 frames of 57 s.
    #expect(
      close
        == WindowClose(
          startT: 2, endT: micro(3419.0 / 60), reason: .endAnchor, trimmed: false, finalSample: true
        ))
    #expect(try checkShapes(sink) > 10_000)
    #expect(core.counts.nonIncreasing == 0)

    let manifest = try JSONDecoder().decode(
      RecordingManifest.self, from: #require(sink.recordingJson))
    #expect(manifest.origin == .synthetic)
    #expect(manifest.build.profile == .synthetic)
    #expect(manifest.recordingID == session.recordingID.uuidString.lowercased())
    #expect(manifest.closed)
    #expect(manifest.window.ended == .endAnchor)
    // recording.json lists every other file with its size and hash.
    let listed = Dictionary(uniqueKeysWithValues: manifest.files.map { ($0.path, $0) })
    #expect(Set(listed.keys) == Set(sink.paths.filter { $0 != "recording.json" }))
    for (path, entry) in listed {
      let data = try #require(sink.file(path))
      #expect(entry.bytes == data.count)
      #expect(entry.sha256 == sha256Hex(data))
    }
    #expect(manifest.files.map(\.path) == manifest.files.map(\.path).sorted())
    let rates = try #require(manifest.rates)
    #expect(abs(rates.framesHz - 60) < 0.5)
    #expect(abs(rates.imuHz - 100) < 0.5)
    #expect(rates.candidatesHz > 4 && rates.candidatesHz < 6)
    #expect(rates.meshIntervalS != nil)

    // Every line inside the window.
    for (path, times) in try lineTimes(sink) {
      #expect(times.allSatisfy { $0 >= close.startT && $0 <= close.endT }, "\(path)")
      #expect(times == times.sorted(), "\(path) in order")
    }
    // The gap and the limited stretch are in frames.jsonl.
    let frames = try JSONDecoder().decodeLines(RecordingFrameLine.self, sink.file("frames.jsonl"))
    #expect(frames.contains { $0.gap == 6 })
    #expect(frames.contains { $0.tracking == "limited:excessiveMotion" })
    #expect(frames.allSatisfy { $0.candidate == nil || $0.candidate == .droppedProfile })
    // GNSS only from the open, and only near the street anchor's first fix.
    let fixes = try JSONDecoder().decodeLines(GnssLine.self, sink.file("location.jsonl"))
    #expect(fixes.map(\.t) == [2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5])
    #expect(fixes.allSatisfy { $0.t >= 2 })
    // Actions only from the open: the start call before it isn't kept.
    let actions = try JSONDecoder().decodeLines(ActionLine.self, sink.file("actions.jsonl"))
    #expect(actions.map(\.call) == ["markAnchor", "addTag", "markAnchor"])
    // Boundary lines numbered from 0 at the open, the last the final flush.
    let boundary =
      try sink.file("boundary.jsonl").map { data in
        try data.split(separator: 0x0A).map {
          try #require(try JSONSerialization.jsonObject(with: Data($0)) as? [String: Any])
        }
      } ?? []
    #expect(boundary.first?["seq"] as? Int == 0)
    #expect(boundary.last?["kind"] as? String == "recording")
    #expect(boundary.last?["t"] as? Double == close.endT)
  }

  @Test func theFinalSampleAndTheMeshHistoryHoldTogether() throws {
    let (core, sink) = record(SyntheticSession(seed: 3, durationS: 40))
    guard case .closed(let close) = core.phase else {
      Issue.record("the recording closed")
      return
    }
    let anchors = try JSONDecoder().decodeLines(AnchorHistoryLine.self, sink.file("anchors.jsonl"))
    let finalAnchors = anchors.filter(\.anchorHistoryLineFinal)
    // Both marked anchors exist at the end; mesh anchors aren't in anchors.jsonl's final sample.
    #expect(finalAnchors.count == 2)
    #expect(finalAnchors.allSatisfy { $0.kind == .marked && $0.t == close.endT })
    // Every anchor's first line is an add.
    var seen = Set<String>()
    for line in anchors where !seen.contains(line.anchor) {
      #expect(line.op == .add)
      seen.insert(line.anchor)
    }

    let index = try JSONDecoder().decodeLines(MeshHistoryLine.self, sink.file("mesh/history.jsonl"))
    let bin = try #require(sink.file("mesh/history.bin"))
    var end = 0
    var removed = Set<String>()
    for line in index {
      if line.op == .remove {
        removed.insert(line.anchor)
        continue
      }
      let offset = try #require(line.offset)
      let bytes = try #require(line.bytes)
      #expect(offset == end)
      let block = bin.subdata(in: offset..<(offset + bytes))
      let inflated = try #require(storedInflate(block))
      #expect(inflated.count == 12 * line.vertices! + 13 * line.faces!)
      end = offset + bytes
    }
    #expect(end == bin.count)
    #expect(!removed.isEmpty)
    // The final snapshot holds every mesh anchor still there, once.
    let finalMesh = index.filter(\.meshHistoryLineFinal)
    #expect(!finalMesh.isEmpty)
    #expect(Set(finalMesh.map(\.anchor)).count == finalMesh.count)
    #expect(finalMesh.allSatisfy { $0.t == close.endT && !removed.contains($0.anchor) })
    #expect(sink.meshRunner.counts.reused > 0)
    #expect(sink.meshRunner.counts.unchanged == 1)
    // RecoveryScan reads the finished files as whole.
    for path in sink.paths where path.hasSuffix(".jsonl") {
      let data = try #require(sink.file(path))
      #expect(RecoveryScan.jsonl(data).keepBytes == data.count, "\(path)")
    }
  }

  @Test func theSessionIsSyntheticAndCantPassAsRecorded() {
    let core = SyntheticSession().makeRecorder()
    #expect(core.grant.origin == .synthetic)
    #expect(core.manifestBase.origin == .synthetic)
  }
}

extension JSONDecoder {
  fileprivate func decodeLines<T: Decodable>(_ type: T.Type, _ data: Data?) throws -> [T] {
    try (data ?? Data()).split(separator: 0x0A).map { try decode(T.self, from: Data($0)) }
  }
}
#endif
