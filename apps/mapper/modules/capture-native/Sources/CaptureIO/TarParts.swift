import CaptureCore
import Foundation

// An export tar written straight into its 16 MiB parts, and read back from them, without a
// joined file ever existing (docs/session-recording.md, "Export and import"; design 9). The
// recorder's TarExporter writes a recording through it; `packBundle` will write bundles the same
// way, so it isn't gated by USG_RECORDER.

/// A part written: its name, length and SHA-256.
public struct WrittenPart: Equatable, Sendable {
  public let name: String
  public let bytes: Int64
  public let sha256: String
}

/// Why the parts couldn't be written or read. Carries no value from the files but a count.
public enum TarPartsError: Error, Equatable, Sendable {
  /// More bytes than the plan's tar, or fewer at the end.
  case lengthMismatch
  /// A part is missing, shorter than parts.json says, or a member isn't where its header says.
  case unreadable
  case memberNotFound
}

/// Writes a tar's bytes, in order, into the parts a PartPlan lays out: each part is created with
/// `protection`, full-synced and closed when it is complete, and hashed as it is written, as is
/// the whole tar.
public final class TarPartWriter {
  public let directory: URL
  public let plan: PartPlan
  public private(set) var written: Int64 = 0
  public private(set) var parts: [WrittenPart] = []

  private let protection: FileSecurityClass
  private let security: any FileSecurity
  private var current: DurableFile?
  private var currentWritten: Int64 = 0
  private var partHash = Sha256Stream()
  private var tarHash = Sha256Stream()

  public init(
    directory: URL, plan: PartPlan, protection: FileSecurityClass, security: any FileSecurity
  ) {
    self.directory = directory
    self.plan = plan
    self.protection = protection
    self.security = security
  }

  /// Appends `data` to the tar, starting new parts where the plan says.
  public func write(_ data: Data) throws {
    guard written + Int64(data.count) <= plan.tarBytes else { throw TarPartsError.lengthMismatch }
    var rest = data[...]
    while !rest.isEmpty {
      let index = parts.count
      let range = plan.parts[index]
      if current == nil {
        current = try DurableFile.create(
          directory.appendingPathComponent(range.name, isDirectory: false),
          mode: .appendWriteOnly, protection: protection, security: security)
        currentWritten = 0
        partHash = Sha256Stream()
      }
      let take = Int(min(Int64(rest.count), range.bytes - currentWritten))
      let slice = Data(rest.prefix(take))
      try current?.appendAll(slice)
      partHash.update(slice)
      tarHash.update(slice)
      currentWritten += Int64(take)
      written += Int64(take)
      rest = rest.dropFirst(take)
      if currentWritten == range.bytes { try closePart(range) }
    }
  }

  /// Every part written and closed: the parts and the whole tar's digest.
  public func finish() throws -> (parts: [WrittenPart], tarSha256: String) {
    guard written == plan.tarBytes, current == nil, parts.count == plan.parts.count else {
      throw TarPartsError.lengthMismatch
    }
    return (parts, tarHash.hex())
  }

  /// Closes an open part without finishing it: the export failed and its staging goes.
  public func abandon() {
    current?.close()
    current = nil
  }

  private func closePart(_ range: ExportPartRange) throws {
    guard let file = current else { return }
    try file.fullSync()
    file.close()
    current = nil
    parts.append(WrittenPart(name: range.name, bytes: range.bytes, sha256: partHash.hex()))
  }
}

/// Reads a tar from its parts on disk, in order, as one stream of bytes.
public struct PartsReader {
  public let directory: URL
  /// The parts' names and lengths, in order.
  public let parts: [(name: String, bytes: Int64)]

  public init(directory: URL, parts: [(name: String, bytes: Int64)]) {
    self.directory = directory
    self.parts = parts
  }

  public var tarBytes: Int64 { parts.reduce(0) { $0 + $1.bytes } }

  /// `count` bytes of the tar from `offset`, across parts as needed.
  public func read(offset: Int64, count: Int) throws -> Data {
    guard offset >= 0, count >= 0, offset + Int64(count) <= tarBytes else {
      throw TarPartsError.unreadable
    }
    var out = Data(capacity: count)
    var start: Int64 = 0
    for part in parts {
      let end = start + part.bytes
      let want = offset + Int64(out.count)
      if out.count == count { break }
      if want < end && want >= start {
        let take = Int(min(Int64(count - out.count), end - want))
        guard
          let handle = try? FileHandle(
            forReadingFrom: directory.appendingPathComponent(part.name, isDirectory: false))
        else { throw TarPartsError.unreadable }
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(want - start))
        let data = try handle.read(upToCount: take) ?? Data()
        guard data.count == take else { throw TarPartsError.unreadable }
        out.append(data)
      }
      start = end
    }
    guard out.count == count else { throw TarPartsError.unreadable }
    return out
  }

  /// A member's bytes, found by walking the headers, for small members (recording.json).
  public func member(named name: String, limit: Int = 16 << 20) throws -> Data {
    var offset: Int64 = 0
    let block = Int64(TarLayout.blockBytes)
    while offset + block <= tarBytes {
      let header = [UInt8](try read(offset: offset, count: TarLayout.blockBytes))
      if header.allSatisfy({ $0 == 0 }) { break }
      let nameBytes = header[0..<100].prefix { $0 != 0 }
      guard let size = Self.octal(header[124..<136]) else { throw TarPartsError.unreadable }
      if Array(nameBytes) == Array(name.utf8) {
        guard size <= Int64(limit) else { throw TarPartsError.unreadable }
        return try read(offset: offset + block, count: Int(size))
      }
      offset += block + size + Int64(TarLayout.paddingBytes(forSize: size))
    }
    throw TarPartsError.memberNotFound
  }

  /// A ustar number field: octal digits, then NUL or spaces.
  static func octal(_ field: ArraySlice<UInt8>) -> Int64? {
    var value: Int64 = 0
    var digits = 0
    for byte in field {
      if byte == 0 || byte == 0x20 { break }
      guard byte >= UInt8(ascii: "0") && byte <= UInt8(ascii: "7") else { return nil }
      value = value * 8 + Int64(byte - UInt8(ascii: "0"))
      digits += 1
    }
    return digits > 0 ? value : nil
  }
}
