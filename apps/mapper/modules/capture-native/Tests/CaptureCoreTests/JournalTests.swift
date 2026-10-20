#if USG_RECORDER
import Foundation
import Testing

@testable import CaptureCore

private let open = JournalOpen(
  id: recordingUUID, startT: 3.2, profile: .lean, marginS: 5, idleS: 300, maxS: 1800)

private let every: [JournalRecord] = [
  .open(open),
  .checkpoint(
    JournalCheckpoint(seq: 0, sizes: ["frames.jsonl": 1024, "imu.jsonl": 0], binBytes: 0)),
  .end(t: 120.5),
  .closing(deadline: 125.5),
  .checkpoint(
    JournalCheckpoint(
      seq: 1, sizes: ["frames.jsonl": 2_000_000, "mesh/history.jsonl": 812], binBytes: 4096)),
  .closed(JournalClosed(endT: 125.483333, reason: .endAnchor, trimmed: false, finalSample: true)),
  .manifest,
  .protectionPending,
  .discard,
]

private func journal(_ records: [JournalRecord]) throws -> Data {
  try records.reduce(into: Data()) { $0.append(try Journal.encode($1)) }
}

@Suite struct JournalTests {
  @Test func everyRecordRoundTrips() throws {
    let data = try journal(every)
    let reading = Journal.decode(data)
    #expect(reading.records == every)
    #expect(reading.validBytes == data.count)
    #expect(!reading.damaged)
  }

  @Test func aRecordIsOneLineWithItsOwnFieldsOnly() throws {
    let line = String(decoding: try Journal.encode(.open(open)), as: UTF8.self)
    #expect(
      line
        == #"{"id":"5d0c6f1e-3b7a-4f7e-9c51-2a8e4b6d1f03","idle":300,"margin":5,"max_s":1800,"profile":"lean","r":"open","start_t":3.2}"#
        + "\n")
    #expect(
      String(decoding: try Journal.encode(.end(t: 9.5)), as: UTF8.self) == #"{"r":"end","t":9.5}"#
        + "\n")
    #expect(
      String(decoding: try Journal.encode(.discard), as: UTF8.self) == #"{"r":"discard"}"# + "\n")
  }

  @Test func aTornLastLineIsDropped() throws {
    let whole = try journal(Array(every.prefix(3)))
    let torn = whole + Data(#"{"r":"closing","dead"#.utf8)
    let reading = Journal.decode(torn)
    #expect(reading.records == Array(every.prefix(3)))
    #expect(reading.validBytes == whole.count)
    #expect(reading.damaged)
  }

  @Test(arguments: [
    #"{"r":"closing"}"#, #"{"r":"what"}"#, "garbage", #"{"r":"end","t":"9"}"#,
    "{\"r\":\"end\",\u{0}\"t\":1}",
  ])
  func readingStopsAtADamagedLine(_ bad: String) throws {
    let head = try journal([.open(open), .end(t: 10)])
    let data = head + Data((bad + "\n").utf8) + (try Journal.encode(.end(t: 20)))
    let reading = Journal.decode(data)
    #expect(reading.records == [.open(open), .end(t: 10)])
    #expect(reading.validBytes == head.count)
    #expect(reading.damaged)
  }

  @Test func theSummaryFoldsTheRecords() throws {
    let summary = Journal.decode(try journal(every)).summary
    #expect(summary.open == open)
    #expect(summary.lastEndT == 120.5)
    #expect(summary.closingDeadline == 125.5)
    #expect(summary.lastCheckpoint?.seq == 1)
    #expect(summary.lastCheckpoint?.binBytes == 4096)
    #expect(summary.closed?.reason == .endAnchor)
    #expect(summary.manifestWritten && summary.protectionPending && summary.discarded)
  }

  @Test func recordsBeforeTheOpenAndEndsBeforeTheStartDontCount() {
    let summary = JournalSummary([
      .end(t: 1), .discard, .open(open), .end(t: 2), .end(t: 50), .end(t: 40),
    ])
    #expect(summary.lastEndT == 50)
    #expect(!summary.discarded)
    #expect(JournalSummary([.end(t: 5)]).open == nil)
  }
}
#endif
