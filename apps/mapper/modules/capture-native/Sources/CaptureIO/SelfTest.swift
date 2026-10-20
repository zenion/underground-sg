#if USG_RECORDER
import CaptureCore
import Foundation

// `recorderSelfTest(keep)` (design 9 and D18): a synthetic session through the real RecorderCore,
// FileSink, FileSecurity, Compression and CryptoKit on the phone, in place of a measure mode. It
// writes only generated data, under `Library/Application Support/selftest/`, and deletes all of
// it afterwards; recovery sweeps leftovers at launch. With `keep` and the walk build's grant, the
// finished set moves into `recordings/` (`origin: synthetic`), where it can be exported
// (open question Q13). The report holds results, rates and names, never recorded data.

/// What the self-test found.
public struct SelfTestReport: Equatable, Sendable {
  public var passed = false
  /// The synthetic recording closed and its recording.json was written.
  public var recordingFinished = false
  /// frames.jsonl's protection class while it was written, and after the close.
  public var protectionWhileWriting: FileSecurityClass?
  public var protectionAfterClose: FileSecurityClass?
  /// The recordings root and the self-test's own are excluded from backup.
  public var excludedFromBackup = false
  /// Deflate.raw round-trips through Deflate.inflate.
  public var compressionMatches = false
  /// Sha256Stream gives the NIST digests, and the same digest in pieces as in one go.
  public var sha256Matches = false
  /// The synthetic recording's bytes over the time it took: encoding, writing and syncing.
  public var encodeMBps = 0.0
  public var deflateMBps = 0.0
  public var sha256MBps = 0.0
  /// The top-level names in Documents: `exports` or nothing.
  public var documentsNames: [String] = []
  /// The kept set's id (walk build, `keep`), else nil.
  public var keptID: UUID?

  public init() {}
}

public final class SelfTest {
  public let store: RecordingStore
  private let uptime: @Sendable () -> Double

  public init(
    store: RecordingStore,
    uptime: @escaping @Sendable () -> Double = { ProcessInfo.processInfo.systemUptime }
  ) {
    self.store = store
    self.uptime = uptime
  }

  /// Runs the self-test. `keep` keeps the set only with a device grant (the walk build); the
  /// development build has none, so its set is always deleted.
  public func run(
    keep: Bool, grant: RecordingGrant?, durationS: Double = 60, seed: UInt64? = nil
  ) -> SelfTestReport {
    var report = SelfTestReport()
    let security = store.security
    guard security.protectedDataAvailable else { return report }
    let root = store.paths.selfTestRoot
    try? deleteItem(root)
    defer { try? deleteItem(root) }

    let work = RecordingStore(
      paths: RecordingPaths(
        applicationSupport: root, documents: root.appendingPathComponent("documents")),
      security: security, ballastBytes: store.ballastBytes)
    let session = SyntheticSession(
      seed: seed ?? UInt64.random(in: 1...UInt64.max), durationS: max(20, durationS))
    let id = session.recordingID
    let frames = work.paths.file(.frames, of: id)
    let sink = FileSink(store: work)
    var startedAt = 0.0
    var elapsed = 0.0
    if (try? store.prepareRoots()) != nil {
      startedAt = uptime()
      SyntheticRecording.record(session, into: sink) { sink in
        if report.protectionWhileWriting == nil, sink.state == .open {
          report.protectionWhileWriting = security.protectionClass(frames)
        }
      }
      elapsed = uptime() - startedAt
    }
    report.recordingFinished = sink.state == .finished
    report.protectionAfterClose = security.protectionClass(frames)
    report.excludedFromBackup =
      security.isExcludedFromBackup(store.paths.recordingsRoot)
      && security.isExcludedFromBackup(work.paths.recordingsRoot)
    let written = Double(work.files(in: work.paths.recording(id)).reduce(0) { $0 + $1.size })
    report.encodeMBps = elapsed > 0 ? rounded(written / elapsed / 1e6) : 0
    measureCodecs(into: &report)
    report.documentsNames =
      ((try? FileManager.default.contentsOfDirectory(atPath: store.paths.documents.path)) ?? [])
      .filter { !$0.hasPrefix(".") }.sorted()

    if keep, report.recordingFinished, let grant, grant.origin == .device,
      !FileManager.default.fileExists(atPath: store.paths.recording(id).path)
    {
      let moved = (try? FileManager.default.moveItem(
        at: work.paths.recording(id), to: store.paths.recording(id))) != nil
      if moved { report.keptID = id }
    }
    report.passed =
      report.recordingFinished && report.protectionWhileWriting == .completeUnlessOpen
      && report.protectionAfterClose == .complete && report.excludedFromBackup
      && report.compressionMatches && report.sha256Matches
      && report.documentsNames.allSatisfy { $0 == "exports" }
    return report
  }

  /// Compression and SHA-256 checked against known answers and round trips, and timed.
  private func measureCodecs(into report: inout SelfTestReport) {
    var text = Data()
    var index = 0
    while text.count < 4 << 20 {
      text.append(
        Data(
          "{\"frame\":\(index),\"t\":\(Double(index) / 60),\"tracking\":\"normal\",\"gap\":0}\n"
            .utf8))
      index += 1
    }
    var start = uptime()
    let deflated = try? Deflate.raw(text)
    let deflateS = uptime() - start
    report.compressionMatches =
      deflated.flatMap { Deflate.inflate($0, limit: text.count) } == text
    report.deflateMBps = deflateS > 0 ? rounded(Double(text.count) / deflateS / 1e6) : 0

    let abc = Sha256Stream.hex(of: Data("abc".utf8))
    let empty = Sha256Stream.hex(of: Data())
    start = uptime()
    let whole = Sha256Stream.hex(of: text)
    let shaS = uptime() - start
    var pieces = Sha256Stream()
    var offset = 0
    while offset < text.count {
      let end = min(text.count, offset + 1_000_003)
      pieces.update(text.subdata(in: offset..<end))
      offset = end
    }
    report.sha256Matches =
      abc == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
      && empty == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      && pieces.hex() == whole
    report.sha256MBps = shaS > 0 ? rounded(Double(text.count) / shaS / 1e6) : 0
  }

  private func rounded(_ value: Double) -> Double {
    value.isFinite ? (value * 10).rounded() / 10 : 0
  }
}
#endif
