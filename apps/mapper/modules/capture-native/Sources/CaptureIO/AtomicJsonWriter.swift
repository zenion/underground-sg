import Foundation

/// Replaces a small document (recording.json, parts.json) so that a crash or power loss at any
/// point leaves either the old version or the new one, never a mix (design 7.5, step 6): the new
/// bytes go to a temporary file in a staging directory, which is full-synced, renamed over the
/// target, and the target's directory fsynced.
///
/// The staging directory must be on the target's volume, so the rename is atomic; recovery at
/// launch deletes whatever a crash left in it.
///
/// Not gated by USG_RECORDER: bundles will write their manifests through it too.
public enum AtomicJsonWriter {
  /// The steps of a replace, where the tests inject a failure.
  enum Step: CaseIterable, Sendable {
    case create, write, sync, rename, syncDirectory
  }

  /// Writes `data` to `target`, which may not exist yet. The temporary file is created through
  /// `security` with `protection`, which the target then has.
  public static func replace(
    _ data: Data, at target: URL, staging: URL, protection: FileSecurityClass,
    security: any FileSecurity
  ) throws {
    try replace(
      data, at: target, staging: staging, protection: protection, security: security,
      fault: { _ in })
  }

  static func replace(
    _ data: Data, at target: URL, staging: URL, protection: FileSecurityClass,
    security: any FileSecurity, fault: (Step) throws -> Void
  ) throws {
    let temporary = staging.appendingPathComponent(
      "\(UUID().uuidString.lowercased()).tmp", isDirectory: false)
    do {
      try fault(.create)
      let file = try DurableFile.create(
        temporary, mode: .appendWriteOnly, protection: protection, security: security)
      defer { file.close() }
      try fault(.write)
      try file.appendAll(data)
      try fault(.sync)
      try file.fullSync()
    } catch {
      removeQuietly(temporary)
      throw error
    }
    do {
      try fault(.rename)
      _ = try withPath(temporary, .rename) { from in
        try withPath(target, .rename) { to in
          try retryingEINTR(.rename) { .of(Int(sysRename(from, to))) }
        }
      }
    } catch {
      removeQuietly(temporary)
      throw error
    }
    // The new version is in place; this makes the rename itself durable.
    try fault(.syncDirectory)
    try DurableFile.syncDirectory(target.deletingLastPathComponent())
  }

  private static func removeQuietly(_ url: URL) {
    _ = try? withPath(url, .remove) { path in sysUnlink(path) }
  }
}
