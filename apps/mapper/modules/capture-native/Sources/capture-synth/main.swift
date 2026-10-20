// capture-synth: a synthetic lean recording written by the recorder's real code on the PC or a CI
// runner (design D13 and 14): SyntheticSession through RecorderCore into FileSink, so CI can
// check the files with validate-recording, and with --export the parts with --parts. Nothing it
// writes came from a sensor (`origin: synthetic`), and nothing of it is committed: it writes
// into --out, which CI puts under $RUNNER_TEMP.
//
//   capture-synth --out <dir> [--export] [--interrupt <s>] [--seed <n>] [--duration <s>]
//
// <dir> gets rec-<id>/ and, with --export, replay-<id>/ (the parts and parts.json). With
// --interrupt the app "dies" at that session time and RecoveryRunner finishes the recording as
// the next launch would, so the recovered recording can be checked too.
//
// The export goes through TarExporter.exportSynthetic, which exists only where Package.swift
// defines USG_SYNTHETIC_EXPORT and refuses anything but a synthetic recording; the app's pods
// never define it, so on the phone only a RecordingGrant exports. No BuildFacts are made up
// here, so no grant is.
//
// Exit codes: 0 written, 1 the recording or the export failed, 2 bad usage.

#if USG_RECORDER
  import CaptureCore
  import CaptureIO
  import Foundation

  #if canImport(Darwin)
    import Darwin
  #elseif canImport(Glibc)
    import Glibc
  #elseif canImport(Musl)
    import Musl
  #endif

  let usage = """
    Usage: capture-synth --out <dir> [--export] [--interrupt <s>] [--seed <n>] [--duration <s>]

      --out <dir>        A new or empty directory: gets rec-<id>/ and, with --export, replay-<id>/
      --export           Also export the recording as parts, as the phone does
      --interrupt <s>    Stop writing at this session time, as a crash would, then recover
      --seed <n>         The session's seed (default 1)
      --duration <s>     The session's length in seconds, 20 to 1800 (default 60)

    """

  func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data("capture-synth: \(message)\n".utf8))
    if code == 2 { FileHandle.standardError.write(Data(usage.utf8)) }
    exit(code)
  }

  /// Files and directories as the PC has them: no protection classes and no backups. Created
  /// exclusively, as on the phone.
  struct PlainFileSecurity: FileSecurity {
    func createFile(_ url: URL, _ cls: FileSecurityClass) throws {
      let fd = url.withUnsafeFileSystemRepresentation { path -> Int32 in
        guard let path else { return -1 }
        return open(path, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0o644)
      }
      guard fd >= 0 else { throw IOFailure.system(.create, errno: errno) }
      close(fd)
    }

    func createDirectory(_ url: URL, _ cls: FileSecurityClass) throws {
      let result = url.withUnsafeFileSystemRepresentation { path -> Int32 in
        guard let path else { return -1 }
        return mkdir(path, 0o755)
      }
      guard result == 0 else { throw IOFailure.system(.create, errno: errno) }
    }

    func upgrade(_ url: URL) throws {
      guard FileManager.default.fileExists(atPath: url.path) else {
        throw IOFailure.system(.open, errno: ENOENT)
      }
    }

    func excludeFromBackup(_ url: URL) throws {}
    func protectionClass(_ url: URL) -> FileSecurityClass? { nil }
    func isExcludedFromBackup(_ url: URL) -> Bool { false }
    var protectedDataAvailable: Bool { true }
  }

  var outPath: String?
  var export = false
  var interruptAtT: Double?
  var seed: UInt64 = 1
  var duration = 60.0
  var arguments = CommandLine.arguments.dropFirst()
  while let argument = arguments.popFirst() {
    switch argument {
    case "--out":
      guard let value = arguments.popFirst() else { fail("--out needs a directory", code: 2) }
      outPath = value
    case "--export":
      export = true
    case "--interrupt":
      guard let value = arguments.popFirst().flatMap({ Double($0) }), value > 0 else {
        fail("--interrupt needs a time in seconds", code: 2)
      }
      interruptAtT = value
    case "--seed":
      guard let value = arguments.popFirst().flatMap({ UInt64($0) }) else {
        fail("--seed needs a whole number", code: 2)
      }
      seed = value
    case "--duration":
      guard let value = arguments.popFirst().flatMap({ Double($0) }), value >= 20, value <= 1800
      else { fail("--duration needs 20 to 1800 seconds", code: 2) }
      duration = value
    case "-h", "--help":
      print(usage, terminator: "")
      exit(0)
    default:
      fail("unknown argument \(argument)", code: 2)
    }
  }
  guard let outPath else { fail("--out is required", code: 2) }

  let fm = FileManager.default
  let out = URL(fileURLWithPath: outPath, isDirectory: true)
  if fm.fileExists(atPath: out.path) {
    guard ((try? fm.contentsOfDirectory(atPath: out.path)) ?? ["?"]).isEmpty else {
      fail("--out must be a new or empty directory", code: 2)
    }
  } else {
    do {
      try fm.createDirectory(at: out, withIntermediateDirectories: true)
    } catch {
      fail("can't create --out", code: 2)
    }
  }

  // The phone's layout under a work directory, removed at the end.
  let work = out.appendingPathComponent(".work", isDirectory: true)
  let paths = RecordingPaths(
    applicationSupport: work.appendingPathComponent("support", isDirectory: true),
    documents: work.appendingPathComponent("documents", isDirectory: true))
  let store = RecordingStore(paths: paths, security: PlainFileSecurity(), ballastBytes: 1 << 20)

  /// Removes the work directory, then fails.
  func finish(_ message: String, code: Int32) -> Never {
    try? FileManager.default.removeItem(at: work)
    fail(message, code: code)
  }

  let session = SyntheticSession(seed: seed, durationS: duration)
  let id = session.recordingID
  let name = RecordingPaths.recordingName(id)
  let sink = FileSink(store: store)
  let core = SyntheticRecording.record(session, into: sink, interruptAtT: interruptAtT)
  if interruptAtT != nil {
    // The next launch: a new store over the same files, as the app would make.
    let report = RecoveryRunner(
      store: RecordingStore(paths: paths, security: PlainFileSecurity(), ballastBytes: 1 << 20)
    ).run()
    guard report.done, report.recovered + report.finished == 1 else {
      finish("recovery kept nothing (interrupted before an end anchor?)", code: 1)
    }
  } else {
    guard sink.state == .finished, case .closed = core.phase else {
      finish("the recording didn't finish", code: 1)
    }
  }
  guard let facts = store.manifestFacts(id), let ended = facts.ended else {
    finish("the recording has no final recording.json", code: 1)
  }
  do {
    try fm.copyItem(at: paths.recording(id), to: out.appendingPathComponent(name))
  } catch {
    finish("can't copy \(name) into --out", code: 1)
  }
  let bytes = facts.files.reduce(0) { $0 + $1.bytes }
  print(
    "capture-synth: \(name) ended \(ended.rawValue), closed \(facts.closed), "
      + "\(facts.files.count + 1) files, \(bytes) bytes besides recording.json")

  if export {
    let replay = RecordingPaths.replayName(id)
    do {
      let result = try TarExporter(store: store).exportSynthetic(id: id)
      try fm.moveItem(at: paths.export(id), to: out.appendingPathComponent(replay))
      print(
        "capture-synth: \(replay) exported, \(result.parts) parts, \(result.tarBytes) tar bytes")
    } catch let error as ExportError {
      finish("the export failed (\(error.code))", code: 1)
    } catch {
      finish("can't move \(replay) into --out", code: 1)
    }
  }
  try? fm.removeItem(at: work)
#else
  import Foundation

  FileHandle.standardError.write(
    Data("capture-synth: built without the recorder (USG_NO_RECORDER)\n".utf8))
  exit(2)
#endif
