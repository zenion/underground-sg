#if USG_RECORDER
import Foundation

// Recovery's reading of what a cut-off recording left on disk (design 3.1 and 7.7): how much of
// each file is whole, ordered lines, and where to cut it back. Recovery only ever removes lines
// (design 12), so the result is always a length to truncate to.

/// How far a JSONL file is good.
public struct JsonlScan: Equatable, Sendable {
  /// Why the scan stopped.
  public enum Stop: Equatable, Sendable {
    /// Every line is whole and kept.
    case end
    /// A torn, garbled or out-of-order line; it and everything after it go.
    case damaged
    /// A line past the cut time; it and everything after it go.
    case cut
    /// A line of a final sample, which a cut-back recording doesn't have (design 12).
    case finalLine
    /// The `recording_closed` event, which a cut-back recording doesn't have: its detail would
    /// say the recorder closed it, while recording.json says `interrupted`.
    case closedEvent
  }

  /// The bytes to keep: the whole lines before the stop.
  public var keepBytes: Int
  /// The lines kept.
  public var lines: Int
  /// The `t` of the last line kept, or nil for none.
  public var lastT: Double?
  public var stop: Stop
}

/// Streams a JSONL file in chunks of any size and finds the last valid line. A line is valid
/// when it ends with a newline, holds no NUL, is a JSON object with a finite, non-negative
/// numeric `t`, and its `t` doesn't decrease. With `cutT`, a line with `t` past it stops the
/// scan; with `dropFinal`, so does a line with `"final": true`; with `dropClosedEvent` (for
/// events.jsonl), so does the `recording_closed` event. The recorder writes that event last, so
/// nothing after it is lost.
public struct JsonlScanner: Sendable {
  public let cutT: Double?
  public let dropFinal: Bool
  public let dropClosedEvent: Bool
  private var result = JsonlScan(keepBytes: 0, lines: 0, lastT: nil, stop: .end)
  private var stopped = false
  /// The start of a line whose newline hasn't come yet.
  private var carry: [UInt8] = []

  public init(cutT: Double? = nil, dropFinal: Bool = false, dropClosedEvent: Bool = false) {
    self.cutT = cutT
    self.dropFinal = dropFinal
    self.dropClosedEvent = dropClosedEvent
  }

  public mutating func feed(_ chunk: Data) {
    guard !stopped else { return }
    var lineStart = chunk.startIndex
    for index in chunk.indices where chunk[index] == 0x0A {
      carry.append(contentsOf: chunk[lineStart..<index])
      check(carry)
      carry = []
      lineStart = chunk.index(after: index)
      if stopped { return }
    }
    carry.append(contentsOf: chunk[lineStart...])
    // A line can't be longer than the format allows; more without a newline is garbage.
    if carry.count > LineEncoder.maxLineBytes { stop(.damaged) }
  }

  /// The result. A last line without its newline is torn.
  public func finish() -> JsonlScan {
    var final = result
    if !stopped && !carry.isEmpty { final.stop = .damaged }
    return final
  }

  private mutating func check(_ line: [UInt8]) {
    guard !line.contains(0),
      let fields = try? JSONDecoder().decode(ScanFields.self, from: Data(line)),
      fields.t.isFinite, fields.t >= 0, fields.t >= (result.lastT ?? 0)
    else { return stop(.damaged) }
    if let cutT, fields.t > cutT { return stop(.cut) }
    if dropFinal && fields.isFinal == true { return stop(.finalLine) }
    if dropClosedEvent && fields.kind == RecordingEventKind.recordingClosed.rawValue {
      return stop(.closedEvent)
    }
    result.keepBytes += line.count + 1
    result.lines += 1
    result.lastT = fields.t
  }

  private mutating func stop(_ reason: JsonlScan.Stop) {
    stopped = true
    result.stop = reason
  }
}

/// How far a mesh history (history.jsonl and history.bin) is good.
public struct MeshHistoryScan: Equatable, Sendable {
  public var indexKeepBytes: Int
  /// history.bin's length up to the end of the last kept line's block.
  public var binKeepBytes: Int64
  public var lines: Int
  public var lastT: Double?
  public var stop: JsonlScan.Stop
}

public enum RecoveryScan {
  /// Scans a whole JSONL file held in memory.
  public static func jsonl(
    _ data: Data, cutT: Double? = nil, dropFinal: Bool = false, dropClosedEvent: Bool = false
  ) -> JsonlScan {
    var scanner = JsonlScanner(cutT: cutT, dropFinal: dropFinal, dropClosedEvent: dropClosedEvent)
    scanner.feed(data)
    return scanner.finish()
  }

  /// Scans history.jsonl against history.bin. Besides the JSONL rules, each add or update line's
  /// block must start where the last one ended (blocks are appended in order, each before its
  /// line) and end within history.bin's `binBytes`. Blocks that end past the last checkpoint's
  /// `checkpointBinBytes` weren't synced when the journal last said so, so they are read with
  /// `readBlock(offset, bytes)` and inflated with `inflatedLength`, which must give 12v + 13f.
  public static func meshHistory(
    index: Data, binBytes: Int64, checkpointBinBytes: Int64, cutT: Double? = nil,
    dropFinal: Bool = false, readBlock: (Int64, Int) -> Data?, inflatedLength: (Data) -> Int?
  ) -> MeshHistoryScan {
    var scan = MeshHistoryScan(
      indexKeepBytes: 0, binKeepBytes: 0, lines: 0, lastT: nil, stop: .end)
    var start = index.startIndex
    let decoder = JSONDecoder()
    while start < index.endIndex {
      guard let newline = index[start...].firstIndex(of: 0x0A) else {
        scan.stop = .damaged
        break
      }
      let line = index[start..<newline]
      guard !line.contains(0),
        let fields = try? decoder.decode(MeshScanFields.self, from: Data(line)),
        fields.t.isFinite, fields.t >= 0, fields.t >= (scan.lastT ?? 0)
      else {
        scan.stop = .damaged
        break
      }
      if let cutT, fields.t > cutT {
        scan.stop = .cut
        break
      }
      if dropFinal && fields.isFinal == true {
        scan.stop = .finalLine
        break
      }
      switch fields.op {
      case "remove":
        guard fields.offset == nil, fields.bytes == nil else {
          scan.stop = .damaged
          break
        }
      case "add", "update":
        guard let offset = fields.offset, let bytes = fields.bytes,
          let vertices = fields.vertices, let faces = fields.faces,
          offset == scan.binKeepBytes, bytes > 0, vertices >= 0, faces >= 0,
          offset + Int64(bytes) <= binBytes
        else {
          scan.stop = .damaged
          break
        }
        if offset + Int64(bytes) > checkpointBinBytes {
          let inflated = 12 * vertices + 13 * faces
          guard inflated <= MeshBlockLayout.maxBlockBytes,
            let block = readBlock(offset, bytes), block.count == bytes,
            inflatedLength(block) == inflated
          else {
            scan.stop = .damaged
            break
          }
        }
        scan.binKeepBytes = offset + Int64(bytes)
      default:
        scan.stop = .damaged
      }
      if scan.stop != .end { break }
      scan.indexKeepBytes += line.count + 1
      scan.lines += 1
      scan.lastT = fields.t
      start = index.index(after: newline)
    }
    return scan
  }
}

/// The fields a scan needs from any line. `kind` is read only when it is a string, so a file
/// whose lines have no such `kind` scans as before.
private struct ScanFields: Decodable {
  let t: Double
  let isFinal: Bool?
  let kind: String?

  enum CodingKeys: String, CodingKey {
    case t, kind
    case isFinal = "final"
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    t = try container.decode(Double.self, forKey: .t)
    isFinal = try container.decodeIfPresent(Bool.self, forKey: .isFinal)
    kind = try? container.decodeIfPresent(String.self, forKey: .kind)
  }
}

/// The fields a scan needs from a mesh-history line.
private struct MeshScanFields: Decodable {
  let t: Double
  let op: String
  let offset: Int64?
  let bytes: Int?
  let vertices: Int?
  let faces: Int?
  let isFinal: Bool?

  enum CodingKeys: String, CodingKey {
    case t, op, offset, bytes, vertices, faces
    case isFinal = "final"
  }
}
#endif
