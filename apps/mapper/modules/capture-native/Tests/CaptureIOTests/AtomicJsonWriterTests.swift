import Foundation
import Testing

@testable import CaptureIO

#if canImport(Darwin)
  import Darwin
#elseif canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#endif

// AtomicJsonWriter leaves the old version or the new one whatever step fails (design 7.5 and
// 14), and nothing in the staging directory.

private struct Injected: Error, Equatable {}

@Suite struct AtomicJsonWriterTests {
  let directory: TemporaryDirectory
  let staging: URL
  let security = RecordingFileSecurity()
  let old = Data("{\"closed\":false}\n".utf8)
  let new = Data("{\"closed\":true}\n".utf8)

  init() throws {
    directory = try TemporaryDirectory()
    staging = try directory.directory(".staging")
  }

  private var target: URL { directory.file("recording.json") }

  private func replace(_ data: Data, failAt step: AtomicJsonWriter.Step? = nil) throws {
    try AtomicJsonWriter.replace(
      data, at: target, staging: staging, protection: .completeUnlessOpen, security: security,
      fault: { current in if current == step { throw Injected() } })
  }

  @Test func writesADocumentThatDidntExist() throws {
    try AtomicJsonWriter.replace(
      new, at: target, staging: staging, protection: .completeUnlessOpen, security: security)
    #expect(directory.contents("recording.json") == new)
    #expect(try directory.names(in: staging).isEmpty)
  }

  @Test func replacesTheOldVersion() throws {
    try replace(old)
    try replace(new)
    #expect(directory.contents("recording.json") == new)
    #expect(try directory.names(in: staging).isEmpty)
  }

  @Test func theTemporaryFileGetsTheClassThroughFileSecurity() throws {
    try AtomicJsonWriter.replace(
      new, at: target, staging: staging, protection: .complete, security: security)
    #expect(security.calls.count == 1)
    guard case .createFile(let path, let cls)? = security.calls.first else {
      Issue.record("the temporary file wasn't created through FileSecurity")
      return
    }
    #expect(cls == .complete)
    #expect(path.hasPrefix(staging.path))
    #expect(path.hasSuffix(".tmp"))
  }

  @Test func aFailureBeforeTheRenameLeavesTheOldVersion() throws {
    for step in [AtomicJsonWriter.Step.create, .write, .sync, .rename] {
      try replace(old)
      #expect(throws: Injected()) { try replace(new, failAt: step) }
      #expect(directory.contents("recording.json") == old, "failed at \(step)")
      #expect(try directory.names(in: staging).isEmpty, "failed at \(step)")
    }
  }

  @Test func aFailureBeforeTheRenameLeavesNoDocumentWhenThereWasNone() throws {
    for step in [AtomicJsonWriter.Step.create, .write, .sync, .rename] {
      #expect(throws: Injected()) { try replace(new, failAt: step) }
      #expect(directory.contents("recording.json") == nil, "failed at \(step)")
      #expect(try directory.names(in: staging).isEmpty, "failed at \(step)")
    }
  }

  @Test func aFailureAfterTheRenameLeavesTheNewVersion() throws {
    try replace(old)
    #expect(throws: Injected()) { try replace(new, failAt: .syncDirectory) }
    #expect(directory.contents("recording.json") == new)
    #expect(try directory.names(in: staging).isEmpty)
  }

  @Test func aRefusedCreateLeavesTheOldVersion() throws {
    try replace(old)
    security.failNext(.createFile)
    #expect(throws: IOFailure.system(.create, errno: EACCES)) { try replace(new) }
    #expect(directory.contents("recording.json") == old)
    #expect(try directory.names(in: staging).isEmpty)
  }

  @Test func aStagingDirectoryThatIsMissingFailsWithoutTouchingTheTarget() throws {
    try replace(old)
    #expect(throws: IOFailure.system(.create, errno: ENOENT)) {
      try AtomicJsonWriter.replace(
        new, at: target, staging: directory.url.appendingPathComponent("missing"),
        protection: .completeUnlessOpen, security: security)
    }
    #expect(directory.contents("recording.json") == old)
  }
}
