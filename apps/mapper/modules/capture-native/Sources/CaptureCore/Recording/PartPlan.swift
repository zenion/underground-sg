/// Why an export can't be split. Carries only a count.
public enum PartPlanError: Error, Equatable, Sendable {
  /// More parts than `maxExportParts`: `exportRecording` refuses with `ERR_EXPORT_TOO_LARGE`
  /// and keeps the raw files.
  case tooManyParts(Int)
}

/// One part of the export: a slice of the tar.
public struct ExportPartRange: Equatable, Sendable {
  /// `0000.part`, `0001.part` and so on.
  public let name: String
  /// Where the slice starts in the tar.
  public let offset: Int64
  public let bytes: Int64
}

/// How an export tar is split into parts (docs/session-recording.md, "Export and import"):
/// `UPLOAD_PART_BYTES` (16 MiB) each, the last one shorter, at most `maxExportParts` (4,096).
///
/// Not gated by USG_RECORDER, like TarLayout.
public struct PartPlan: Equatable, Sendable {
  /// UPLOAD_PART_BYTES in packages/contracts.
  public static let partBytes: Int64 = 16 * 1024 * 1024
  /// DEFAULT_RECORDING_LIMITS.maxExportParts.
  public static let maxParts = 4096

  public let tarBytes: Int64
  public let parts: [ExportPartRange]

  /// The parts of a tar of `tarBytes` bytes (at least the 1,024 of an empty tar). Refuses before
  /// listing them when there would be too many.
  public init(tarBytes: Int64) throws {
    precondition(tarBytes > 0, "a tar has at least its end blocks")
    let count = Self.partCount(tarBytes: tarBytes)
    guard count <= Self.maxParts else { throw PartPlanError.tooManyParts(count) }
    self.tarBytes = tarBytes
    parts = (0..<count).map { index in
      let offset = Int64(index) * Self.partBytes
      return ExportPartRange(
        name: Self.name(index), offset: offset, bytes: min(Self.partBytes, tarBytes - offset))
    }
  }

  /// ceil(tarBytes / 16 MiB).
  public static func partCount(tarBytes: Int64) -> Int {
    Int((tarBytes + partBytes - 1) / partBytes)
  }

  /// Four digits, then `.part`.
  static func name(_ index: Int) -> String {
    let digits = String(index)
    return String(repeating: "0", count: max(0, 4 - digits.count)) + digits + ".part"
  }
}
