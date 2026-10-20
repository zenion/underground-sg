#if USG_RECORDER
import CaptureCore
import Foundation
import Testing

@testable import CaptureIO

// The recorder's layout on the phone (design 7.1 and 9), on made-up roots.

private let id = UUID(uuidString: "8f9585da-8554-4b8a-ba4e-0f390ccd3802")!
private let paths = RecordingPaths(
  applicationSupport: URL(fileURLWithPath: "/app/Library/Application Support", isDirectory: true),
  documents: URL(fileURLWithPath: "/app/Documents", isDirectory: true))

@Suite struct RecordingPathsTests {
  @Test func everythingIsWhereTheDesignPutsIt() {
    let support = "/app/Library/Application Support"
    let rec = "\(support)/recordings/rec-8f9585da-8554-4b8a-ba4e-0f390ccd3802"
    #expect(paths.recordingsRoot.path == "\(support)/recordings")
    #expect(paths.recording(id).path == rec)
    #expect(paths.manifest(of: id).path == "\(rec)/recording.json")
    #expect(paths.file(.frames, of: id).path == "\(rec)/frames.jsonl")
    #expect(paths.file(.meshBin, of: id).path == "\(rec)/mesh/history.bin")
    #expect(paths.meshDirectory(of: id).path == "\(rec)/mesh")
    #expect(
      paths.journal(id).path
        == "\(support)/recordings/.journal-8f9585da-8554-4b8a-ba4e-0f390ccd3802.jsonl")
    #expect(
      paths.ballast(id).path
        == "\(support)/recordings/.ballast-8f9585da-8554-4b8a-ba4e-0f390ccd3802")
    #expect(paths.staging.path == "\(support)/recordings/.staging")
    #expect(
      paths.exportStaging(id).path
        == "\(support)/exports-staging/replay-8f9585da-8554-4b8a-ba4e-0f390ccd3802")
    #expect(paths.selfTestRoot.path == "\(support)/selftest")
  }

  @Test func onlyExportsIsUnderDocuments() {
    #expect(paths.exportsRoot.path == "/app/Documents/exports")
    #expect(
      paths.export(id).path == "/app/Documents/exports/replay-8f9585da-8554-4b8a-ba4e-0f390ccd3802")
    let documents = paths.documents.path + "/"
    let underDocuments = [
      paths.recordingsRoot, paths.recording(id), paths.journal(id), paths.ballast(id),
      paths.staging, paths.exportsStagingRoot, paths.exportStaging(id), paths.selfTestRoot,
    ].filter { $0.path.hasPrefix(documents) }
    #expect(underDocuments.isEmpty)
  }

  @Test func idsComeBackOutOfTheirNames() {
    #expect(RecordingPaths.recordingID(name: RecordingPaths.recordingName(id)) == id)
    #expect(RecordingPaths.journalID(name: RecordingPaths.journalName(id)) == id)
    #expect(RecordingPaths.ballastID(name: RecordingPaths.ballastName(id)) == id)
    #expect(RecordingPaths.replayID(name: RecordingPaths.replayName(id)) == id)
  }

  @Test func namesThatArentTheRecordersAreRefused() {
    for name in [
      "rec-8F9585DA-8554-4B8A-BA4E-0F390CCD3802",  // not lowercase
      "rec-8f9585da-8554-4b8a-ba4e-0f390ccd380",  // too short
      "rec-8f9585da-8554-4b8a-ba4e-0f390ccd3802x",
      "rec-8f9585da85544b8aba4e0f390ccd3802",
      "replay-8f9585da-8554-4b8a-ba4e-0f390ccd3802",
      ".journal-8f9585da-8554-4b8a-ba4e-0f390ccd3802.jsonl",
      "rec-", "",
    ] {
      #expect(RecordingPaths.recordingID(name: name) == nil, "\(name)")
    }
    #expect(RecordingPaths.journalID(name: ".journal-8f9585da-8554-4b8a-ba4e-0f390ccd3802") == nil)
    #expect(RecordingPaths.journalID(name: "rec-8f9585da-8554-4b8a-ba4e-0f390ccd3802") == nil)
    #expect(RecordingPaths.ballastID(name: ".ballast-not-a-uuid") == nil)
  }
}
#endif
