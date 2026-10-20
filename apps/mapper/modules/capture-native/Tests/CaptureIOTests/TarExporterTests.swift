#if USG_RECORDER
import CaptureCore
import Foundation
import Testing

@testable import CaptureIO

// The export (design 9 and 14): the parts and parts.json, the raw files deleted only after the
// rename; refused when too large, without room, without a device grant or with a corrupt file
// (the raw files kept, no staging left); and a crash between the rename and the delete finished
// by recovery.

private func sha(_ data: Data) -> String { Sha256Stream.hex(of: data) }

/// A device grant, as RecordPermission gives the walk build.
private func walkGrant() throws -> RecordingGrant {
  let decision = RecordPermission.decide(
    profile: .lean, facts: .walk, venues: ["5d6e7f80-1a2b-4c3d-8e9f-a0b1c2d3e4f5"],
    freeDiskBytes: 1 << 40)
  guard case .granted(let grant) = decision else { throw ExportError.refused }
  return grant
}

/// The tar the parts make, joined in memory for the test.
private func joinedParts(_ fixture: StoreFixture, _ id: UUID) throws -> (Data, ExportPartsFacts) {
  let facts = try #require(fixture.store().exportFacts(id))
  var tar = Data()
  for part in facts.parts {
    tar.append(
      try #require(
        FileManager.default.contents(
          atPath: fixture.paths.export(id).appendingPathComponent(part.name).path)))
  }
  return (tar, facts)
}

@Suite struct TarExporterTests {
  let fixture: StoreFixture
  let session = SyntheticSession(seed: 31, durationS: 30)

  init() throws {
    fixture = try StoreFixture()
    let sink = FileSink(store: fixture.store())
    SyntheticRecording.record(session, into: sink)
  }

  private var id: UUID { session.recordingID }

  @Test func anExportWritesThePartsThenDeletesTheRawFiles() throws {
    let raw = fixture.files(of: id)
    let exporter = TarExporter(store: fixture.store())
    var progress: [ExportProgress] = []
    let result = try exporter.export(id: id, grant: try walkGrant()) { progress.append($0) }
    #expect(!fixture.exists(fixture.paths.recording(id)))
    #expect(fixture.names(fixture.paths.exportsStagingRoot).isEmpty)
    #expect(fixture.names(fixture.paths.documents) == ["exports"])
    let (tar, parts) = try joinedParts(fixture, id)
    #expect(result.parts == parts.parts.count)
    #expect(result.tarBytes == Int64(tar.count))
    #expect(parts.tarBytes == Int64(tar.count))
    #expect(parts.tarSha256 == sha(tar))
    #expect(parts.recordingID == id)
    let total = Int64(tar.count)
    #expect(progress.last == ExportProgress(bytesDone: total, bytesTotal: total))
    // Every member is the raw file, under rec-<id>/, in TarLayout's order and headers.
    let layout = try TarLayout(
      files: raw.map { ("rec-\(id.uuidString.lowercased())/\($0.key)", Int64($0.value.count)) })
    #expect(Int64(tar.count) == layout.tarBytes)
    for entry in layout.entries {
      let start = Int(entry.headerOffset)
      #expect(
        tar.subdata(in: start..<(start + 512))
          == (try TarLayout.header(name: entry.name, size: entry.size)))
      let path = String(entry.name.split(separator: "/", maxSplits: 1)[1])
      let data = tar.subdata(in: Int(entry.dataOffset)..<(Int(entry.dataOffset) + Int(entry.size)))
      #expect(data == raw[path], "\(path)")
    }
    // Class A from their first byte (the rename keeps it) and excluded from backup; the list
    // reports it as exported.
    let staged = fixture.paths.exportStaging(id)
    for name in ["0000.part", "parts.json"] {
      #expect(
        fixture.security.calls.contains(
          .createFile(staged.appendingPathComponent(name).path, .complete)), "\(name)")
    }
    #expect(fixture.security.calls.contains(.createDirectory(staged.path, .complete)))
    #expect(fixture.security.isExcludedFromBackup(fixture.paths.exportsRoot))
    let listed = try #require(fixture.store().list().first)
    #expect(listed.state == .exported)
    #expect(listed.origin == .synthetic)
    #expect(listed.exportParts == parts.parts.count)
  }

  @Test func syntheticExportsNeedNoGrantButOnlyExportSyntheticSets() throws {
    let result = try TarExporter(store: fixture.store()).exportSynthetic(id: id)
    #expect(result.parts == 1)
    #expect(!fixture.exists(fixture.paths.recording(id)))
  }

  @Test func tooLargeIsRefusedBeforeAnythingIsWritten() throws {
    let exporter = TarExporter(store: fixture.store())
    exporter.maxParts = 0
    #expect(throws: ExportError.tooLarge) { try exporter.export(id: id, grant: try walkGrant()) }
    #expect(ExportError.tooLarge.code == "ERR_EXPORT_TOO_LARGE")
    #expect(fixture.exists(fixture.paths.recording(id)))
    #expect(fixture.names(fixture.paths.exportsStagingRoot).isEmpty)
    #expect(!fixture.exists(fixture.paths.exportsRoot))
  }

  @Test func withoutRoomForThePartsItIsRefused() throws {
    fixture.freeBytes = 10 << 20
    #expect(throws: ExportError.noSpace) {
      try TarExporter(store: fixture.store()).export(id: id, grant: try walkGrant())
    }
    #expect(fixture.exists(fixture.paths.recording(id)))
  }

  @Test func aCorruptSourceStopsTheExportAndKeepsTheRawFiles() throws {
    let url = fixture.paths.file(.imu, of: id)
    var data = try #require(FileManager.default.contents(atPath: url.path))
    data[data.count / 2] ^= 0x01
    try data.write(to: url)
    #expect(throws: ExportError.corrupt) {
      try TarExporter(store: fixture.store()).export(id: id, grant: try walkGrant())
    }
    #expect(fixture.exists(fixture.paths.recording(id)))
    #expect(fixture.names(fixture.paths.exportsStagingRoot).isEmpty)
    #expect(fixture.names(fixture.paths.exportsRoot).isEmpty)
  }

  @Test func aFileWithTheWrongSizeIsCorruptToo() throws {
    try Data("{}\n".utf8).write(to: fixture.paths.file(.frames, of: id))
    #expect(throws: ExportError.corrupt) {
      try TarExporter(store: fixture.store()).export(id: id, grant: try walkGrant())
    }
  }

  @Test func anOpenRecordingIsRefused() throws {
    try Data().write(to: fixture.paths.journal(id))
    #expect(throws: ExportError.notClosed) {
      try TarExporter(store: fixture.store()).export(id: id, grant: try walkGrant())
    }
  }

  @Test func aBusyRecordingIsRefused() throws {
    let store = fixture.store()
    #expect(store.markBusy(id))
    #expect(throws: ExportError.busy) {
      try TarExporter(store: store).export(id: id, grant: try walkGrant())
    }
  }

  @Test func aCrashBetweenTheRenameAndTheDeleteIsFinishedByRecovery() throws {
    let exporter = TarExporter(store: fixture.store())
    exporter.fault = { step in if step == .deleteRaw { throw ExportError.io } }
    #expect(throws: ExportError.io) { try exporter.export(id: id, grant: try walkGrant()) }
    #expect(fixture.exists(fixture.paths.recording(id)))
    #expect(fixture.exists(fixture.paths.export(id).appendingPathComponent("parts.json")))
    let report = RecoveryRunner(store: fixture.store()).run()
    #expect(report.exportsCompleted == 1)
    #expect(!fixture.exists(fixture.paths.recording(id)))
    #expect(fixture.exists(fixture.paths.export(id)))
  }

  @Test func aBadExportNextToTheRawFilesIsRemovedByRecovery() throws {
    let exporter = TarExporter(store: fixture.store())
    exporter.fault = { step in if step == .deleteRaw { throw ExportError.io } }
    _ = try? exporter.export(id: id, grant: try walkGrant())
    let part = fixture.paths.export(id).appendingPathComponent("0000.part")
    var data = try #require(FileManager.default.contents(atPath: part.path))
    data[0] ^= 0x01
    try data.write(to: part)
    let report = RecoveryRunner(store: fixture.store()).run()
    #expect(report.exportsRemoved == 1)
    #expect(fixture.exists(fixture.paths.recording(id)))
    #expect(!fixture.exists(fixture.paths.export(id)))
  }

  @Test func theTarSplitsAtSixteenMiB() throws {
    // TarPartWriter on its own, with a tar just over one part.
    let directory = try fixture.directory.directory("parts")
    let plan = try PartPlan(tarBytes: PartPlan.partBytes + 1024)
    let writer = TarPartWriter(
      directory: directory, plan: plan, protection: .complete, security: fixture.security)
    let chunk = noiseBytes(1 << 20)
    var whole = Data()
    for _ in 0..<16 {
      try writer.write(chunk)
      whole.append(chunk)
    }
    try writer.write(Data(count: 1024))
    whole.append(Data(count: 1024))
    #expect(throws: TarPartsError.lengthMismatch) { try writer.write(Data(count: 1)) }
    let (parts, tarSha) = try writer.finish()
    #expect(parts.map(\.name) == ["0000.part", "0001.part"])
    #expect(parts.map(\.bytes) == [PartPlan.partBytes, 1024])
    #expect(tarSha == sha(whole))
    #expect(parts[1].sha256 == sha(Data(count: 1024)))
    let reader = PartsReader(directory: directory, parts: parts.map { ($0.name, $0.bytes) })
    let boundary = Int(PartPlan.partBytes)
    #expect(
      try reader.read(offset: PartPlan.partBytes - 4, count: 8)
        == whole.subdata(in: (boundary - 4)..<(boundary + 4)))
  }
}
#endif
