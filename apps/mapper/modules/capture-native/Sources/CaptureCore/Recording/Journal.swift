#if USG_RECORDER
import Foundation

// The recording's journal (design 3.1, 7.3 and 7.5): `.journal-<id>.jsonl` beside `rec-<id>/`,
// one record a line, each full-synced before anything later counts. Recovery at the next launch
// reads it to learn where the window started, which end anchors were marked and how far the
// recording got. It holds times, so like the recording it is private and never logged.

/// `open`: written and full-synced before `rec-<id>/` is created (design D3).
public struct JournalOpen: Equatable, Sendable {
  public var id: UUID
  public var startT: Double
  public var profile: RecordProfile
  /// The window's settings, so recovery cuts back with the margin the session used.
  public var marginS: Double
  public var idleS: Double
  public var maxS: Double

  public init(
    id: UUID, startT: Double, profile: RecordProfile, marginS: Double, idleS: Double,
    maxS: Double
  ) {
    self.id = id
    self.startT = startT
    self.profile = profile
    self.marginS = marginS
    self.idleS = idleS
    self.maxS = maxS
  }
}

/// `checkpoint`: every file's committed size after an fsync, and history.bin's.
public struct JournalCheckpoint: Equatable, Sendable {
  public var seq: Int
  /// Bytes by path in `rec-<id>/`.
  public var sizes: [String: Int64]
  public var binBytes: Int64

  public init(seq: Int, sizes: [String: Int64], binBytes: Int64) {
    self.seq = seq
    self.sizes = sizes
    self.binBytes = binBytes
  }
}

/// `closed`: the writers finished at `endT`. A journal with this record is finished cleanly at
/// recovery (design D2).
public struct JournalClosed: Equatable, Sendable {
  public var endT: Double
  public var reason: WindowEndReason
  public var trimmed: Bool
  public var finalSample: Bool

  public init(endT: Double, reason: WindowEndReason, trimmed: Bool, finalSample: Bool) {
    self.endT = endT
    self.reason = reason
    self.trimmed = trimmed
    self.finalSample = finalSample
  }
}

/// One journal record.
public enum JournalRecord: Equatable, Sendable {
  case open(JournalOpen)
  /// An end anchor marked at `t`.
  case end(t: Double)
  /// End the session here: the window closes at `deadline`.
  case closing(deadline: Double)
  case checkpoint(JournalCheckpoint)
  case closed(JournalClosed)
  /// recording.json was written at close.
  case manifest
  /// The files wait for the protection upgrade until the phone is unlocked.
  case protectionPending
  /// The recording is being deleted.
  case discard
}

/// The journal read back: the records up to the first damaged line, and how many bytes they
/// take. A crash can leave the last line torn; nothing after a damaged line counts.
public struct JournalReading: Equatable, Sendable {
  public let records: [JournalRecord]
  public let validBytes: Int
  /// A damaged or torn line was found and everything from it on ignored.
  public let damaged: Bool

  public var summary: JournalSummary { JournalSummary(records) }
}

/// What the records say, folded: what recovery plans from.
public struct JournalSummary: Equatable, Sendable {
  public var open: JournalOpen?
  /// The last end anchor at or after the start: the latest `end` record.
  public var lastEndT: Double?
  public var closingDeadline: Double?
  public var lastCheckpoint: JournalCheckpoint?
  public var closed: JournalClosed?
  public var manifestWritten = false
  public var protectionPending = false
  public var discarded = false

  /// Records before the `open` don't count: nothing is written before it.
  public init(_ records: [JournalRecord]) {
    for record in records {
      if case .open(let open) = record {
        if self.open == nil { self.open = open }
        continue
      }
      guard let open else { continue }
      switch record {
      case .open: break
      case .end(let t):
        if t >= open.startT, lastEndT.map({ t > $0 }) ?? true { lastEndT = t }
      case .closing(let deadline): closingDeadline = deadline
      case .checkpoint(let checkpoint): lastCheckpoint = checkpoint
      case .closed(let closed): self.closed = closed
      case .manifest: manifestWritten = true
      case .protectionPending: protectionPending = true
      case .discard: discarded = true
      }
    }
  }
}

/// The journal's line codec.
public enum Journal {
  /// One record as a JSON line, keys sorted, ending in a newline.
  public static func encode(_ record: JournalRecord) throws -> Data {
    try LineEncoder().line(Wire(record))
  }

  /// The records of a whole journal file. Reading stops at the first line that is torn (no
  /// newline), holds a NUL or isn't a known record.
  public static func decode(_ data: Data) -> JournalReading {
    var records: [JournalRecord] = []
    var validBytes = 0
    var damaged = false
    var start = data.startIndex
    let decoder = JSONDecoder()
    while start < data.endIndex {
      guard let newline = data[start...].firstIndex(of: 0x0A) else {
        damaged = true
        break
      }
      let line = data[start..<newline]
      guard !line.contains(0), let wire = try? decoder.decode(Wire.self, from: Data(line)),
        let record = wire.record
      else {
        damaged = true
        break
      }
      records.append(record)
      validBytes += line.count + 1
      start = data.index(after: newline)
    }
    return JournalReading(records: records, validBytes: validBytes, damaged: damaged)
  }
}

/// A record on disk: `r` names it, and only its own fields are present.
private struct Wire: Codable {
  var r: String
  var id: String?
  var startT: Double?
  var profile: String?
  var margin: Double?
  var idle: Double?
  var maxS: Double?
  var t: Double?
  var deadline: Double?
  var seq: Int?
  var sizes: [String: Int64]?
  var binBytes: Int64?
  var endT: Double?
  var reason: String?
  var trimmed: Bool?
  var finalSample: Bool?

  enum CodingKeys: String, CodingKey {
    case r, id, profile, margin, idle, t, deadline, seq, sizes, reason, trimmed
    case startT = "start_t"
    case maxS = "max_s"
    case binBytes = "bin_bytes"
    case endT = "end_t"
    case finalSample = "final_sample"
  }

  init(_ record: JournalRecord) {
    switch record {
    case .open(let open):
      r = "open"
      id = open.id.uuidString.lowercased()
      startT = open.startT
      profile = open.profile.rawValue
      margin = open.marginS
      idle = open.idleS
      maxS = open.maxS
    case .end(let t):
      r = "end"
      self.t = t
    case .closing(let deadline):
      r = "closing"
      self.deadline = deadline
    case .checkpoint(let checkpoint):
      r = "checkpoint"
      seq = checkpoint.seq
      sizes = checkpoint.sizes
      binBytes = checkpoint.binBytes
    case .closed(let closed):
      r = "closed"
      endT = closed.endT
      reason = closed.reason.rawValue
      trimmed = closed.trimmed
      finalSample = closed.finalSample
    case .manifest: r = "manifest"
    case .protectionPending: r = "protection_pending"
    case .discard: r = "discard"
    }
  }

  /// The record, or nil when a field it needs is missing or not finite.
  var record: JournalRecord? {
    func finite(_ value: Double?) -> Double? { value.flatMap { $0.isFinite ? $0 : nil } }
    switch r {
    case "open":
      guard let id = id.flatMap(UUID.init(uuidString:)), let startT = finite(startT),
        let profile = profile.flatMap(RecordProfile.init(rawValue:)), let margin = finite(margin),
        let idle = finite(idle), let maxS = finite(maxS)
      else { return nil }
      return .open(
        JournalOpen(
          id: id, startT: startT, profile: profile, marginS: margin, idleS: idle, maxS: maxS))
    case "end":
      return finite(t).map { .end(t: $0) }
    case "closing":
      return finite(deadline).map { .closing(deadline: $0) }
    case "checkpoint":
      guard let seq, let sizes, let binBytes else { return nil }
      return .checkpoint(JournalCheckpoint(seq: seq, sizes: sizes, binBytes: binBytes))
    case "closed":
      guard let endT = finite(endT), let reason = reason.flatMap(WindowEndReason.init(rawValue:)),
        let trimmed, let finalSample
      else { return nil }
      return .closed(
        JournalClosed(endT: endT, reason: reason, trimmed: trimmed, finalSample: finalSample))
    case "manifest": return .manifest
    case "protection_pending": return .protectionPending
    case "discard": return .discard
    default: return nil
    }
  }
}
#endif
