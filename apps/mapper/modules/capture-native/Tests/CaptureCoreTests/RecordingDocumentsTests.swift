#if USG_RECORDER
import Foundation
import Testing

@testable import CaptureCore

// recording.json at open and close, and parts.json: every null written, files sorted without
// recording.json, and the bytes decoding back to the generated types unchanged.

private func object(_ data: Data) throws -> [String: Any] {
  try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

private let encoder = LineEncoder()

@Suite struct RecordingDocumentsTests {
  @Test func theOpeningDocumentWritesEveryNull() throws {
    var base = deviceManifestBase(motion: nil)
    base.gitCommit = nil
    base.easBuildID = nil
    let data = try RecordingDocuments.opening(
      id: recordingUUID, base: base, profile: .lean, venues: [corridorVenue], startT: 3.2)
    let json = try object(data)
    for key in ["rates", "detector_versions", "motion"] { #expect(json[key] is NSNull, "\(key)") }
    let window = try #require(json["window"] as? [String: Any])
    #expect(window["end_t"] is NSNull)
    #expect(window["ended"] is NSNull)
    #expect(window["trimmed"] as? Bool == false)
    let build = try #require(json["build"] as? [String: Any])
    #expect(build["git_commit"] is NSNull)
    #expect(build["eas_build_id"] is NSNull)
    #expect(build["profile"] as? String == "walk")
    #expect(json["closed"] as? Bool == false)
    #expect((json["files"] as? [Any])?.isEmpty == true)
    #expect((json["segments"] as? [Any])?.isEmpty == true)
    #expect(json["origin"] as? String == "device")
    #expect(json["recording_id"] as? String == "5d0c6f1e-3b7a-4f7e-9c51-2a8e4b6d1f03")
    #expect(json["session_started_at"] as? String == "2026-10-20T08:15:02.104+08:00")
    let manifest = try JSONDecoder().decode(RecordingManifest.self, from: data)
    #expect(try encoder.document(manifest) == data)
    #expect(data.last == 0x0A)
  }

  @Test func buildIdsThatArentWellFormedAreWrittenAsNull() throws {
    var base = deviceManifestBase()
    base.gitCommit = "E191DB7C0A4B5D6E7F8091A2B3C4D5E6F7081920"
    base.easBuildID = "7A1C9E52-4B3D-4F8A-9C6E-1D2B3A4C5E6F"
    base.deviceModel = ""
    let manifest = try JSONDecoder().decode(
      RecordingManifest.self,
      from: RecordingDocuments.opening(
        id: recordingUUID, base: base, profile: .lean, venues: [], startT: 0))
    #expect(manifest.build.gitCommit == nil)
    #expect(manifest.build.easBuildID == nil)
    #expect(manifest.deviceModel == "unknown")
    #expect(manifest.motion?.referenceFrame == .xMagneticNorthZVertical)
  }

  @Test func aSyntheticOriginIsASyntheticBuild() throws {
    var base = deviceManifestBase()
    base.origin = .synthetic
    let manifest = try JSONDecoder().decode(
      RecordingManifest.self,
      from: RecordingDocuments.opening(
        id: recordingUUID, base: base, profile: .lean, venues: [], startT: 0))
    #expect(manifest.origin == .synthetic)
    #expect(manifest.build.profile == .synthetic)
  }

  @Test func theClosedDocumentSortsTheFilesAndLeavesItselfOut() throws {
    let opening = try RecordingDocuments.opening(
      id: recordingUUID, base: deviceManifestBase(), profile: .lean, venues: [corridorVenue],
      startT: 3.2)
    let hash = String(repeating: "ab", count: 32)
    let files = [
      "mesh/history.jsonl", "recording.json", "frames.jsonl", "mesh/history.bin",
      "boundary.jsonl", "imu.jsonl",
    ].map { FileDigest(path: $0, bytes: 10, sha256: hash) }
    let rates = AchievedRates.over(
      startT: 3.2, endT: 13.2, frames: 600, candidates: 41, imu: 1000, motion: 999,
      snapshotTs: [3.2, 8.2, 13.2, 13.2, 20])
    let data = try RecordingDocuments.closed(
      opening: opening,
      window: WindowClose(
        startT: 3.2, endT: 13.2, reason: .endAnchor, trimmed: false, finalSample: true),
      rates: rates, files: files, closed: true)
    let manifest = try JSONDecoder().decode(RecordingManifest.self, from: data)
    #expect(
      manifest.files.map(\.path) == [
        "boundary.jsonl", "frames.jsonl", "imu.jsonl", "mesh/history.bin", "mesh/history.jsonl",
      ])
    #expect(manifest.closed)
    #expect(
      manifest.window == RecordingWindow(endT: 13.2, ended: .endAnchor, startT: 3.2, trimmed: false)
    )
    #expect(
      manifest.rates
        == RecordingRates(
          candidatesHz: 4.1, framesHz: 60, imuHz: 100, meshIntervalS: 5, motionHz: 99.9))
    #expect(try encoder.document(manifest) == data)
    // What the opening said stays.
    let open = try JSONDecoder().decode(RecordingManifest.self, from: opening)
    #expect(manifest.clocks == open.clocks)
    #expect(manifest.venues == [corridorVenue])
  }

  @Test func aRecoveredDocumentIsNotClosedAndMayHaveNoMeshInterval() throws {
    let opening = try RecordingDocuments.opening(
      id: recordingUUID, base: deviceManifestBase(), profile: .lean, venues: [], startT: 3.2)
    let data = try RecordingDocuments.closed(
      opening: opening,
      window: WindowClose(
        startT: 3.2, endT: 4, reason: .interrupted, trimmed: true, finalSample: false),
      rates: .over(
        startT: 3.2, endT: 4, frames: 48, candidates: 0, imu: 80, motion: 80, snapshotTs: [3.2]),
      files: [], closed: false)
    let json = try object(data)
    #expect(json["closed"] as? Bool == false)
    let rates = try #require(json["rates"] as? [String: Any])
    #expect(rates["mesh_interval_s"] is NSNull)
    #expect((json["window"] as? [String: Any])?["ended"] as? String == "interrupted")
  }

  @Test func ratesOfAnEmptyWindowAreZero() {
    let rates = AchievedRates.over(
      startT: 5, endT: 5, frames: 1, candidates: 0, imu: 0, motion: 0, snapshotTs: [5])
    #expect(
      rates
        == AchievedRates(framesHz: 0, candidatesHz: 0, imuHz: 0, motionHz: 0, meshIntervalS: nil))
  }

  @Test func anUnreadableOpeningIsRefused() {
    #expect(throws: RecordingDocumentError.unreadableOpening) {
      try RecordingDocuments.closed(
        opening: Data("{}".utf8),
        window: WindowClose(startT: 0, endT: 1, reason: .stop, trimmed: false, finalSample: false),
        rates: nil, files: [], closed: true)
    }
  }

  @Test func exportPartsWritesTheGolden() throws {
    let golden = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("Golden/ExportParts.json")
    let hash = "3f2a9c4e8b1d7f6a0c5e2b9d4a7f1c8e6b3d0a9f5c2e7b4d1a8f6c3e0b9d2a7f"
    let data = try RecordingDocuments.exportParts(
      recordingID: recordingUUID, tarBytes: 17_825_792, tarSha256: hash,
      parts: [
        PartDigest(name: "0000.part", bytes: 16_777_216, sha256: hash),
        PartDigest(name: "0001.part", bytes: 1_048_576, sha256: hash),
      ])
    #expect(data == (try Data(contentsOf: golden)))
  }
}
#endif
