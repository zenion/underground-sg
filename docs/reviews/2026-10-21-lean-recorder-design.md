# Lean recorder design: to the first corridor walk

Date: 2026-10-21. Status: the plan the Swift spike follows from here to the first corridor walk ([backlog](../backlog.md#mapper-app-appsmapper), tasks 1 to 4, and "Session recordings", "Before the recorder lands"). It works within [ADR 0007](../decisions/0007-expo-mapper-app.md), [ADR 0010](../decisions/0010-capture-recording-and-replay.md) and [session-recording.md](../session-recording.md); where it and they disagree, they win and this file is corrected.

How it was made: three independent designs, each from a different priority (crash safety first, sustained performance and heat first, fewest native builds first), scored by two judges against the docs and the code, then merged into one from the design both judges chose (crash safety), with the others' best ideas grafted in and every flaw the judges found fixed. Section 0 records the decisions that settled their disagreements.

Two notes since it was written:
- PR0 is done in the change that adds this file: `pnpm gen` writes `Contracts.swift` into `CaptureCore`, `packages/contracts/generated/` is gone, and `swift test` compiles the generated types, so CI needs no separate typecheck step (D22).
- B1, the development build that checks the camera shield, was built on 2026-10-20 from main after the module skeleton (D23).

## Defaults taken for the open questions

The owner can override any of these; until then the work follows them.

| Question | Default |
| --- | --- |
| Q1 `closed` for a live cut-back | As designed: a stop cut back by the live recorder is `closed: true, ended: stop, trimmed: true`; `closed: false` only for recordings recovery cut back (`interrupted`) |
| Q2 Window settings | 5 s margin, **300 s idle** within 0.5 m (a wait at a gate shouldn't close a leg), 30 min at most |
| Q3 Device-motion frame | `xMagneticNorthZVertical` when available, else `xArbitraryCorrectedZVertical`, else `xArbitraryZVertical`, recorded in `motion.reference_frame` |
| Q4 Location usage key | Only in the walk build; task 8's checks list it |
| Q5 Measure mode | No: the on-device synthetic self-test only |
| Q6 Rehearsal recording | **The owner's call**, at W1 |
| Q7 Tags in the first walk build | Yes, a minimal node tag row |
| Q8 `candidates_dropped` in lean | Counts only drops a profile didn't intend (not `dropped:profile`) |
| Q9 Log guard | From launch in the walk build |
| Q10 Free space to start | 16 GiB (2 × `maxRecordingBytes`, as ADR 0010 says) |
| Q11 `markAnchor` without normal tracking | Refuses (`ERR_TRACKING`), so the owner marks again |
| Q12 Venue ids in the app | Yes: the seed's ids are fixed for good, with a test that they match |
| Q13 The self-test's set | May be exported as `origin: synthetic` (it holds no sensor data); session-recording.md gets the sentence with that PR |
| Q14 iOS 26.4 to 26.6.0 | Warn on the walk screen, don't refuse |
| Q15 Live-mesh overlay | A toggle, default on; it changes no ARKit configuration |

The final design starts from "robust", which both judges chose. It brings the owner to the first lean corridor walk (P1, the Exit F link, and P2, the Exit G passage) with four PRs of Swift, two of TypeScript and a PR0 that reconciles the contracts. It takes 3 planned EAS builds plus 1 spare: a development build now, a development build after the native glue, and the first walk build. The recorder's logic is pure Swift in CaptureCore, tested with swift test on Linux and macOS: the RecorderCore state machine issues typed sink commands, plus encoders, the pre-open buffer, the mesh ledger, the journal, the recovery plan, the tar plan and a RecordingGrant that only the permission decision can create. A CaptureIO pod does durable I/O and builds on Linux through test fallbacks. It writes append-only files with a 0.5 s watermark, keeps an incremental SHA-256 with a cut checkpoint (so a stop cut-back is an ftruncate and never a reread), adds an F_FULLFSYNC journal checkpoint every 5 s and a 64 MiB disk ballast, and exports through a staging folder that re-hashes every file before the raw files are deleted. From the judges it takes: no Events() inside Class; the Contracts.swift path reconciled in PR0; a development build now to check the secure-canvas shield; an on-device synthetic self-test; a capture-synth executable instead of a committed golden; boundary seq numbered from 0 when the window opens; GNSS t from the fix's age; reuse of compressed blocks in the final mesh; raycasts on the next frame; producer batching at 10 Hz; pods built with -O; the recorder defined by default in Package.swift; and a planned bootstrap for walk-build credentials. It fixes the flaws all three designs shared. A final sample is taken only for end_anchor and idle closes. A recording that recovery cut back keeps closed:false, ended:interrupted and is never deleted at a later launch. And End the session here always takes its final sample from a real frame at end_t.

## The design

Base: design "robust" (both judges chose it). Grafts from "perf" and "minimal" are marked [perf] or [minimal]. Fixes for the judges' findings are marked [fix]. Where the designs disagreed, section 0 says which way this design goes and why.

Facts checked in the worktrees (read only; `.data/` was never read):
- **The final sample.** `session-recording.md` says the final sample is taken **only** for `end_anchor` and `idle`. It is not taken for `background`, `heat`, `disk`, `limit` or a cut-back.
- **`closed`.** It is `true` once the recorder closed cleanly. A recording left `false` was cut off.
- **`boundary.jsonl` seq** is "from 0".
- **Expo events.** In expo-modules-core 57.0.20, `EventsDefinition` is a plain `AnyDefinition`, not a `ClassDefinitionElement`. `SharedObject` conforms to `EventEmitter`, whose `emit(event:payload:)` takes an `AnyArgument` (`Dictionary` conforms) and schedules on the runtime, so it is safe from any queue.
- **`RecorderWindow`** (feat/capture-core):
  - `stop(at:)` on a closing window → `closed(endT: t, .endAnchor)`;
  - `stop(at:)` on an open window → `closed(min(t, lastEnd+margin), .stop, trimmed)`, or `.discarded` without an end anchor;
  - `close(at:reason:)` ignores endAnchor, stop and idle;
  - `expire` closes at the deadline with `endT = deadline`;
  - `recover(...)` → `.interrupted`, `trimmed: true`.
- **`MeshHistorySchedule`** has `take(at:)` and `takeFinal(at:all:)`.
- **Contracts.swift path.** `codegen.ts` writes it to `apps/mapper/modules/capture-native/Sources/CaptureCore/generated/Contracts.swift` on feat/capture-core, but to `packages/contracts/generated/swift/Contracts.swift` on feat/recording-schemas, and that branch's CI typechecks the latter.
- **`app.config.ts`** has no NSLocation key today.
- **`eas.json`** has only `development` (no env).
- **`CaptureView`** today owns the ARView, sets `session.delegate = self` with a nil `delegateQueue` (main), and runs a main-thread `Timer`.
- **React headers.** `ExpoModulesCore.podspec` depends on `React-Core`, so React's headers are reachable from the CaptureNative pod (still to be proven by a CI compile probe).

---

## 0. Decisions that settle the disagreements

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Final sample on which closes | **Only `end_anchor` (deadline, or stop while closing) and `idle`.** None for `background`, `heat`, `disk`, `limit`, `stop` (cut-back) or `interrupted`. After `no_mesh_history` the final sample has no mesh part [fix: all three] | `session-recording.md` "The final sample". It also keeps the background-task close short |
| D2 | `closed` flag | `true` for every close the recorder finalised in process (`end_anchor`, `idle`, `stop` cut-back, `background`, `heat`, `disk`, `limit`), including recovery that finds a journaled `closed{}` record. `false` only for `interrupted` (recovery cut it back) | The doc: true "once the recorder closed cleanly", false "was cut off". A stop cut-back is done by a live recorder. Open question Q1 confirms |
| D3 | Recovered recordings at later launches | [fix] Never deleted. The no-journal rule keys on `recording.json` `window.ended`: non-null → finished (protection sweep only); null or unreadable → delete. The journal's `open` record is full-synced **before** `rec-<id>/` is created | Robust and perf both deleted unexported recovered recordings at the next launch |
| D4 | Who owns the ARSession | `CaptureSession` (SharedObject) **attaches to the ARView's own session** when the view receives the `session` prop. It sets `delegate` and `delegateQueue` before `run` [perf/minimal]. It does not inject a session into ARView | Avoids relying on `ARView.session` being settable. `start` refuses with `ERR_NO_VIEW` without an attached view that has a secure canvas |
| D5 | Mesh buffer reads | Copy the changed anchors' geometry **inside the delegate callback** on captureQueue (robust), never reading `MTLBuffer`s after the callback returns | ARKit doesn't document that the buffers stay unchanged. The copy is about 1–5 MB, about 1–3 ms once every 5 s |
| D6 | Final mesh cost | [perf] Anchors with no `didUpdate` since their last written block reuse that block: `pread` from `history.bin` (opened `O_RDWR`) and append it as a new block, one block per line as the format says. Updated anchors are copied and fingerprinted, then reused if their fingerprint is unchanged, else deflated | End the session here stays under about 1 s. The final sample happens only in the foreground (D1), so the class-B read is safe |
| D7 | Durability | Robust: 0.5 s watermark buffers; fsync of dirty files plus a journal checkpoint with `F_FULLFSYNC` every 5 s, at open, at each end mark, at closing and at finalize; 64 MiB ballast. The cadence is a `RecorderIOConfig` value, tuned from the walk's fsync p95 | Loss bounds: about 1.5 s on a crash, about 6.5 s on power loss. Perf had no periodic sync, minimal one every 10 s |
| D8 | Hashing | Incremental SHA-256 per file, with cut checkpoints (robust). Export re-hashes every file against `recording.json` before deleting the raw files. Recovery re-hashes in full (it runs at launch, in the foreground) | Finalize never reads a class-B file, so a locked close completes |
| D9 | Where lines are encoded | RecorderCore (captureQueue) emits typed `PendingLine` values [minimal], batched to ioQueue every 100 ms [perf]. ioQueue encodes with `LineEncoder` | Keeps the delegate path short (target p95 under 0.3 ms) and gives about 25 wakeups a second instead of about 260 |
| D10 | First walk build | **W1 on EAS cloud** [minimal; judge 2]. The owner starts it interactively from the PC (`eas build -p ios --profile walk`), which creates the EAS-managed ad hoc credentials with the registered iPhone. `walk-build.yml` (`eas build --local` on a manually started macOS runner) ships in PR6 for **later** walk builds, in a protected environment with the owner as required reviewer, `eas upload` output discarded and a YAML test against `upload-artifact` [perf] | Private logs for the first build. The runner path needs those credentials to exist first, and the backlog's default holds for later iterations |
| D11 | CI configuration | The macOS job builds **Release with walk settings** (robust), with the encoder check over all three pods. Debug-only problems are caught by the development builds the owner installs anyway | Release-only problems (BuildFacts, log guard, `-O`) are caught before a walk build is spent |
| D12 | Package.swift switch | Recorder defined **by default**. `USG_NO_RECORDER=1 swift build` on Linux proves the gated split [perf, judge 2] | A plain `swift test` covers the recorder |
| D13 | Synthetic recording | The `capture-synth` executable writes to `$RUNNER_TEMP`, and `validate-recording` checks it [minimal]. Nothing is committed under `Tests/…/Golden/recording-lean`, so the git check needs no new exception. Per-line goldens stay as now | Judge 1 |
| D14 | Location usage key | `NSLocationWhenInUseUsageDescription` only in the **walk** build (robust) | Without the key the development build can't be authorised for Core Location, whatever its code does |
| D15 | GNSS `t` | [perf] `t = (ProcessInfo.systemUptime − t0) − Date().timeIntervalSince(fix.timestamp)`, computed on receipt. Only the fix's age uses the wall clock | Robust to NTP steps |
| D16 | End the session here timing | [minimal, fixed] While closing, at the first frame with `t + 1.5/fps ≥ deadline`, call `window.stop(at: t)` → `closed(t, end_anchor)`, take the final sample from that frame, then emit `stopSession`. If a frame gap jumps past the deadline, `expire` closes at the deadline and the final sample is **still** taken, from the first frame after it, stamped `t = end_t` [fix: minimal dropped it] | The format requires a final sample for end_anchor. The session stops at that same frame, so the session-end reads coincide |
| D17 | Linux coverage of the I/O | [minimal] CaptureIO builds on Linux with fallbacks compiled only where Apple frameworks are absent (`#if !canImport(CryptoKit)` / `!canImport(Compression)`): a pure-Swift SHA-256 and stored-block DEFLATE (BTYPE 00, valid RFC 1951). On Linux, `fsync` stands in for `F_FULLFSYNC`. On macOS, the tests cross-check the fallbacks against CryptoKit and Compression. iOS never compiles the fallbacks | Most of the I/O path is tested on Linux |
| D18 | Development-build measure mode | **Not built.** Instead [minimal] `recorderSelfTest`: the synthetic session through the real RecorderCore, CaptureIO, protection classes, backup exclusion, Compression and CryptoKit, plus timings. In the development build it writes to `Library/Application Support/selftest/` and deletes it. In the walk build it can keep the set and export it (origin `synthetic`) | Keeps "refuses any profile but off" literal. Open question Q5 asks whether to add measure mode |
| D19 | Log guard | Three layers: `RCTSetLogFunction` filtering `RCTLogSourceJavaScript` (native; compile probe in PR3); JS `globalThis.nativeLoggingHook` and `console.*` replaced; `ErrorUtils` handler sanitising messages. Active in the walk build **from launch** (stricter than "while a capture runs"; Q9) | The backlog wants React Native's log function replaced. The `pymobiledevice3 syslog` fake-pose check is the proof |
| D20 | Shared-object events | No `Events(...)` inside `Class(CaptureSession.self)` [fix]. Events go out through `emit(event:payload:)` with `[String: Any]` payloads. Module-level `Events("exportProgress")` is allowed | Doesn't compile otherwise |
| D21 | Boundary `seq` | [minimal Q, resolved] TypeScript numbers `seq` from 0 **at window open**. Before it learns the open, BoundaryTrace holds lines in a bounded buffer (2 s or 256 lines). Native emits `recording {state:'open', startT}` (`startT` as a redacted SessionTime). TypeScript drops buffered lines with `t < startT` and numbers the rest from 0. Native checks that `seq` strictly increases and `t` is inside the window | Matches "from 0" with no doc change |
| D22 | Contracts.swift path | [minimal] PR0 keeps the module path as `GENERATED_SWIFT_FILE`, deletes `packages/contracts/generated/swift/`, and points both CI `swiftc -typecheck` steps at the module copy | Otherwise CaptureCore compiles stale types |
| D23 | When the first device build happens | [minimal] **Build B1 (development) now**, from main after PR0 | Checks the secure-canvas shield (which blocks every walk) and criterion 1 first |
| D24 | `LSSupportsOpeningDocumentsInPlace` | Never set; a Vitest test asserts it is absent | Absent means false; task 8 refuses the key in builds without the switch |
| D25 | Optimisation | [perf] `SWIFT_OPTIMIZATION_LEVEL = -O` and `SWIFT_COMPILATION_MODE = wholemodule` for the three pods in every configuration | The development build's timings mean something |
| D26 | Session `t0` | `t0 = ProcessInfo.systemUptime`, read just before `session.run`, together with `CACurrentMediaTime()` and `Date()` (`clocks`). ARFrame and CMLogItem timestamps are on that clock | Answers minimal's t0 question. The spike measures the offset |

---

## 1. Components and files

```
apps/mapper/
  app.config.ts                    plugins: ["expo-router", "./plugins/with-usg-recorder.ts"]
  plugins/with-usg-recorder.ts     recorderSettings(env) (pure) + plugin (withInfoPlist, withPodfileProperties)
  eas.json                         development (+env), walk (new)
  src/capture/native.ts            CaptureNative port + moduleCaptureNative() adapter (environment-neutral)
  src/capture/redacted.ts          Redacted<T>, SessionTime = Redacted<number>
  src/capture/boundary-trace.ts    BoundaryTrace (D21), JSON-text bounding, batching, final flush
  src/capture/log-guard.ts         console + nativeLoggingHook + ErrorUtils guard (walk build)
  src/capture/figures.ts           debug figures formatting (pure)
  src/walk/flow.ts                 walk state machine (pure reducer)
  src/walk/venues.ts               corridor venues {id, name}; test: equal to db/seed
  src/walk/tags.ts                 minimal tag row (Q7)
  src/app/_layout.tsx              installLogGuard() at the root
  src/app/walk.tsx                 walk screen: camera, REC badge, venue chips, Start, Mark start or end,
                                   End the session here, tags, Stop, debug card
  src/app/recordings.tsx           list, Export, Delete, Apple Devices runbook, self-test
  src/app/capture.tsx              camera check moved onto CaptureSession
  test/  with-usg-recorder, eas-profiles, walk-build-yaml, boundary-trace, redacted, no-pose-logging,
         log-guard, walk-flow, figures, venues, native-dependencies (unchanged list)
  modules/capture-native/
    expo-module.config.json        podspecPath: [ios/CaptureNative.podspec, CaptureCore.podspec, CaptureIO.podspec]
    usg-recorder.rb                reads <installation_root>/Podfile.properties.json "usg.recorder"
    CaptureCore.podspec, CaptureIO.podspec, ios/CaptureNative.podspec   require usg-recorder.rb; -O; condition
    Package.swift                  targets CaptureCore, CaptureIO (dep CaptureCore), executable capture-synth,
                                   tests CaptureCoreTests, CaptureIOTests; USG_RECORDER unless USG_NO_RECORDER
    index.ts, src/types.ts         CaptureSession class types, module functions, view prop `session`
    Sources/CaptureCore/           existing + Recording/: Samples, RecordingEvent, ConfigCode, JsonText,
                                   PendingLine, RecordingDocuments, RecorderCore, PreOpenBuffer, ImuPairer,
                                   AltitudeRebaser, MeshLedger, MeshFingerprint, MeshBlockLayout, Journal,
                                   RecoveryScan, RecoveryPlan, TarLayout, PartPlan, RecordPermission,
                                   BoundaryLineCheck, SessionClock, Facing, SyntheticSession
                                   (+ AnchorSampler.sampleFinal)
    Sources/CaptureIO/             DurableFile, Sha256Stream (+Sha256Fallback), Deflate (+StoredDeflate),
                                   JsonlFileWriter, MeshHistoryWriter, AtomicJsonWriter, FileSecurity,
                                   RecordingPaths, RecordingStore, FileSink, RecoveryRunner, TarExporter, SelfTest
    Sources/capture-synth/main.swift   SyntheticSession → RecorderCore → FileSink → --out; --export
    ios/  CaptureNativeModule, CaptureSession, CaptureView (render + attach), PrivacyShield (+callbacks),
          Capabilities, Log (+LogRing), Queues, BuildFacts,
          Recorder/ (each file whole under #if USG_RECORDER): ARKitAdapter, MeshCopier, MotionSource,
          LocationSource, DeviceProbe, DarwinFileSecurity, RecorderHost, RecorderPlumbing, LogGuard
    Tests/CaptureCoreTests/, Tests/CaptureIOTests/
.github/workflows/ci.yml           macOS: swift test, capture-synth → validate-recording (dir and --parts),
                                   prebuild walk-like, Release build, encoder check (3 pods), React import probe;
                                   Linux: swift test, USG_NO_RECORDER=1 swift build
.github/workflows/walk-build.yml   workflow_dispatch, environment "walk" (required reviewer), eas build --local
```

**Gated under `#if USG_RECORDER`:**
- CaptureCore: RecorderWindow, MeshHistorySchedule, DegradationLadder, and everything in `Recording/` except MeshBlockLayout, MeshFingerprint, TarLayout, PartPlan and JsonText. GnssWindows and AnchorSampler stay ungated: bundles use them later.
- CaptureIO: everything except DurableFile, Sha256Stream, Deflate, AtomicJsonWriter, FileSecurity and the tar writer, which `packBundle` reuses.
- ios/Recorder/.

Generated `Contracts.swift` stays ungated: its types are internal and dead-stripped, and task 8 checks that.

---

## 2. Build switch

**`plugins/with-usg-recorder.ts`.** It exports `recorderSettings(env): RecorderSettings | null` (pure) and the plugin.

- Without `USG_RECORDER=1`, it returns null. The plugin then also **removes** `usg.recorder` from the Podfile properties, so a stale `ios/` can't keep it.
- With `USG_RECORDER=1`, it requires `USG_BUILD_PROFILE` ∈ {`development`, `walk`} and throws otherwise.
- Info.plist:
  - `UIFileSharingEnabled: true`;
  - `NSMotionUsageDescription`;
  - `USGBuildProfile`;
  - `USGGitCommit`: `EAS_BUILD_GIT_COMMIT_HASH ?? GITHUB_SHA`, only if it is 40 lowercase hex characters;
  - `USGEasBuildId`: `EAS_BUILD_ID`, only if it is a UUID;
  - only for `walk`, `NSLocationWhenInUseUsageDescription` (D14);
  - never `LSSupportsOpeningDocumentsInPlace` (D24).
- Podfile properties: `"usg.recorder": "true"`.

**Podspecs.** `usg-recorder.rb`:

```ruby
def usg_recorder?
  props = File.join(Pod::Config.instance.installation_root.to_s, 'Podfile.properties.json')
  File.exist?(props) && JSON.parse(File.read(props))['usg.recorder'] == 'true'
end
def usg_xcconfig
  { 'DEFINES_MODULE'=>'YES', 'SWIFT_OPTIMIZATION_LEVEL'=>'-O', 'SWIFT_COMPILATION_MODE'=>'wholemodule',
    'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => usg_recorder? ? '$(inherited) USG_RECORDER' : '$(inherited)' }
end
```

Each podspec sets `require_relative` and `s.pod_target_xcconfig = usg_xcconfig`.
- `CaptureIO.podspec`: `swift_version 6.0`, `dependency 'CaptureCore'`, `frameworks 'Compression', 'CryptoKit'`, excludes `Package.swift`, `Tests/` and `Sources/capture-synth`.
- `CaptureNative.podspec` adds `dependency 'CaptureIO'` and the frameworks `CoreMotion`, `CoreLocation` and `Metal`.

A CI assertion catches a silent compile-out: after the Release build with the switch, `nm` over the CaptureIO objects must find `RecorderHost` and `FileSink` symbols.

**`eas.json`**

```json
"development": { "developmentClient": true, "distribution": "internal",
  "env": { "USG_RECORDER": "1", "USG_BUILD_PROFILE": "development" } },
"walk": { "developmentClient": false, "distribution": "internal",
  "ios": { "buildConfiguration": "Release", "simulator": false },
  "env": { "USG_RECORDER": "1", "USG_BUILD_PROFILE": "walk" } }
```

- There is no submit profile, no channel and no expo-updates, so the walk build's JS is always the embedded `main.jsbundle`.
- Both profiles use the same bundle identifier, so installing one replaces the other and keeps the data.

**`BuildFacts` (ios/).** `RecordPermission.decide(request, facts, venues, freeDiskBytes, limits) -> .off | .granted(RecordingGrant) | .refused(RecordRefusal)`, where `RecordingGrant` has an internal init and only `decide` can make one [minimal]. A grant needs all of these:
- `recorderCompiled` (`#if USG_RECORDER`);
- `!DEBUG`;
- Info.plist `USGBuildProfile == "walk"`;
- `Bundle.main.url(forResource:"main", withExtension:"jsbundle") != nil`;
- `NSClassFromString("EXDevLauncherController") == nil` [perf; expo-dev-launcher is debugOnly].

Refusals: `notCompiled`, `notWalkBuild`, `debugBuild`, `notEmbedded`, `devClient`, `profileUnavailable` (standard and dense before the blur), `invalidVenues` (1–50 lowercase UUIDs), `lowDisk` (< 2 × 8 GiB). `LocationSource.init(grant:)`, `RecorderHost.init(grant:)` and `TarExporter.export(id:, grant:)` all require a grant, so the development build's refusals hold at compile time.

---

## 3. Public APIs

### 3.1 CaptureCore (Foundation only)

```swift
public struct SessionClock { init(uptime: Double, media: Double, wall: Date)
  func t(uptime: Double) -> Double?          // rounded to 1 µs; nil if < 0
  func t(fixAgeS: Double, nowUptime: Double) -> Double?   // D15
  var clocks: ClocksValue; var sessionStartedAt: String }  // +08:00
public struct FrameSample: Sendable { frame: Int; t: Double; camera: WorldTransform; intrinsics: SIMD4<Float>
  tracking: TrackingCode; mapping: MappingCode; exposureDurationS: Double; exposureOffsetEV: Float
  light: SIMD2<Float>?; fps: Int; candidate: CandidateMark?; gateMs: Double }
public struct ImuSample, MotionSample, AltitudeSample, TelemetrySample   // as robust; g converted in encoders
public enum CandidateMark { case keyframe, kept, dropped(DropReason) }      // lean: .dropped(.profile)
public enum RecordingEvent { recordingOpened, recordingClosed(WindowEndReason), configuration(ConfigCode),
  sessionFailed(code: Int), interruptionBegan/Ended, relocalizationBegan/Ended, imageAnchorDetected(UUID),
  thermal(DeviceThermal), memoryWarning, background, foreground, screenshot, screenCaptureBegan/Ended,
  altimeterUnavailable, altimeterDenied, motionUnavailable, degradation(DegradationStep)
  var kind: String; var detail: String? }      // table-tested against RECORDING_EVENT_DETAILS
public struct ConfigCode { init?(_ s: String) } // ^[a-z][a-z0-9_]{0,63}$
public enum SessionCall: String { case start, markAnchor, addTag, stop, discard }  // plumbing unrepresentable
public enum JsonText { static func bounded(_ json: String) -> String }  // ≤16,384 code points, else marker
public enum BoundaryLineCheck { static func check(_ line: String, window: RecorderWindow, lastSeq: Int?)
  -> Result<(t: Double, seq: Int, bytes: Data), BoundaryRefusal> }  // exactly t,seq,kind,value,binary; binary null;
                                                                   // ≤64 KiB; t accepted; seq increasing
public struct PendingLine: Sendable { let file: RecordingFilePath; let t: Double
  func encode(_ e: LineEncoder) throws -> Data }       // wraps the internal generated Codable value
// RecordingFilePath, not RecordingFile: the generated type of a recording.json files entry has that name
public enum RecordingFilePath: String, CaseIterable { frames="frames.jsonl", imu, motion, altitude, anchors, events,
  actions, telemetry, location, boundary, meshIndex="mesh/history.jsonl", meshBin="mesh/history.bin" }
```

- **`ImuPairer`** pairs each accelerometer sample with the nearest gyro sample within 5 ms and emits on the accelerometer sample. Non-increasing `t` is dropped and counted.
- **`AltitudeRebaser`** gives `relative_m` from the first **written** (in-window) sample.
- **`PreOpenBuffer`** holds the last 2 s of IMU, motion and altitude samples, and releases those with `t ≥ start_t` at open.
- **`Facing.horizontal(camera:) -> SIMD3<Double>?`** projects the camera's −z onto y = 0 and normalises it. It is nil when the horizontal part is below 0.2.
- **`MeshBlockLayout.pack(vertices:faces:classes:) -> Data`** writes float32 xyz, then uint32 indices, then uint8 classes, all little-endian. Inflated size is 12v + 13f. It checks every index < v, widens 16-bit indices, and writes 0 for a missing classification.
- **`MeshFingerprint.of(_ data: Data) -> UInt64`** is FNV-1a 64 over the packed bytes, plus the counts.
- **`MeshLedger`** (mesh queue) has `decide(anchor:fingerprint:final:) -> .writeNew | .reuse(offset, bytes, vertices, faces) | .skipUnchanged`. It remembers the last written block of each anchor; the first write is `add`, later ones `update`. `removeLine` returns nil for an anchor never written.
- **`AnchorSampler.sampleFinal(t:anchors:) -> [AnchorChange]`** writes removes first (keyframe, image and marked kinds removed since the last sample), then every keyframe, image and marked anchor that exists (`add` or `update`), with no threshold. Lines carry `final: true` and `capture_id: null`.
- **`RecordingDocuments`** has `opening(...)`, `closed(opening:window:rates:files:closed:)` and `exportParts(...)`. Every null is written explicitly; `files` is sorted by path, with `recording.json` excluded.
- **`Journal`** is a JSONL codec for the records:
  - `open{id, startT, profile, margin, idle, maxS}`;
  - `end{t}`;
  - `closing{deadline}`;
  - `checkpoint{seq, sizes{file: bytes}, binBytes}`;
  - `closed{endT, reason, trimmed, finalSample}`;
  - `manifest{}`;
  - `protectionPending{}`;
  - `discard{}`.
- **`RecoveryScan`** streams a JSONL file and returns the byte offset of the last valid line and the last `t`. A line is valid if it ends with `\n`, has no NUL, is a JSON object with a finite numeric `t`, and its `t` doesn't decrease. It also checks history.jsonl blocks against the history.bin size and against checkpoint `binBytes` (inflating and checking the length of blocks past the last checkpoint).
- **`RecoveryPlan.make(journal:, recordingJson:, lastWrittenT:, config:) -> .finishClean(window) | .cut(window, closed:false) | .discard | .sweepOnly`**:
  - a journaled `closed{}` → `finishClean` (D2);
  - otherwise → `RecorderWindow.recover`, which gives `.cut` with `interrupted` and `trimmed: true`, or `.discard`;
  - a cut removes every `final: true` line (a cut-back has no final sample) and any `boundary/<seq>.f32` whose line was cut.
- **`TarLayout` and `PartPlan`**:
  - ustar: files only, sorted bytewise, name ≤ 100 bytes, mode 0644, uid/gid 0, mtime 0, empty uname and gname, typeflag `0`, magic `ustar\0` + `00`;
  - `tarBytes = Σ(512 + roundUp512(size)) + 1024`, `parts = ceil(tarBytes / 16 MiB)`;
  - refuse when parts > 4,096.
- **`SyntheticSession(seed:durationS:)`** is deterministic: an Exit F → B1 junction → Exit G polyline in session metres; 60 Hz frames with a limited-tracking stretch and a gap; 100 Hz IMU and motion; altitude; growing box mesh anchors with geometry; a start mark at 2 s; a street-facing GNSS window (synthetic fixes at public corridor coordinates); an end mark with End the session here; actions; boundary lines.

**`RecorderCore`** (a final class, confined to captureQueue):

```swift
public final class RecorderCore {
  init(grant: RecordingGrant, id: UUID, config: RecorderConfig, manifestBase: ManifestBase)
  var phase: RecorderPhase   // armed | open | closing(deadline) | finalizing(CloseOrder) | closed | discarded
  func frame(_ s: FrameSample, position: SIMD3<Double>, readAnchors: () -> AnchorReading) -> [SinkCommand]
  func meshUpdated(_ id: UUID); func meshRemoved(_ id: UUID)
  func imu(_ b: [ImuSample]) / motion(_ b: [MotionSample]) / altitude(_ s: AltitudeSample) -> [SinkCommand]
  func gnss(_ f: GnssFix) -> [SinkCommand]
  func mark(_ m: MarkInput) -> [SinkCommand]            // t = the frame's t (handled on that frame)
  func action(_ a: ActionInput) -> [SinkCommand]
  func boundary(_ lines: [String], final: Bool) -> [SinkCommand]
  func event(_ e: RecordingEvent, t: Double) -> [SinkCommand]   // t clamped to be non-decreasing
  func telemetry(_ s: TelemetrySample) -> [SinkCommand]          // runs DegradationLadder
  func close(at t: Double, reason: WindowEndReason) -> [SinkCommand]   // background|heat|disk|limit
  func stopRequested(frameT: Double, readAnchors: () -> AnchorReading) -> [SinkCommand]
  func discard() -> [SinkCommand]
  func sinkLimitReached(); var meshSnapshotDue: MeshSnapshotPlan? { get }
}
public enum SinkCommand {
  case createRecording(id: UUID, journalOpen: JournalRecord, manifest: Data)
  case lines([PendingLine])
  case mesh(MeshJob)            // copied geometry + plan; mesh queue → io
  case journal(JournalRecord)   // full-synced
  case registerCut(cutT: Double)
  case finalize(CloseOrder)     // endT, reason, trimmed, finalSample?, rates inputs
  case stopSession              // glue pauses the ARSession on main
  case deleteRecording(id: UUID)
}
```

### 3.2 CaptureIO

```swift
final class DurableFile { init(path:, mode: .appendWriteOnly | .appendReadWrite, protection: FileSecurityClass)
  func appendAll(_ d: Data) throws   // loops on EINTR and short writes
  func pread(offset: Int64, count: Int, into: inout [UInt8]) throws
  func fsync() throws; func fullSync() throws /* F_FULLFSYNC; fsync on Linux */; func truncate(to: Int64) throws; func close() }
struct Sha256Stream { mutating func update(_:); func snapshot() -> Sha256Stream; func hex() -> String }  // CryptoKit | fallback
enum Deflate { static func raw(_ src: Data) throws -> Data }   // compression_stream COMPRESSION_ZLIB | stored blocks
final class JsonlFileWriter { enqueue(_ line: Data, t: Double); flush(watermark: Double) throws
  registerCut(_ cutT: Double); finish(endT: Double, useCut: Bool) throws -> FileDigest
  var committedBytes: Int64; var backlogBytes: Int }
final class MeshHistoryWriter { enqueue(t:, block: MeshBlockSource /* .bytes(Data) | .reuse(offset,bytes) */, line: PendingLine)
  same flush/registerCut/finish; bin opened appendReadWrite; block bytes always before its index line }
struct AtomicJsonWriter { static func replace(_ d: Data, at: URL, staging: URL, security: FileSecurity) throws }
protocol FileSecurity { func create(_ url: URL, _ cls: FileSecurityClass) throws; func upgrade(_ url: URL) throws
  func excludeFromBackup(_ url: URL) throws; var protectedDataAvailable: Bool { get } }   // Darwin impl in ios/
final class RecordingStore { root, exportsRoot, stagingRoot; list() -> [RecordingSummary]; delete(id:) throws
  freeBytes() -> Int64 (volumeAvailableCapacityForImportantUsage, cached 1 s); reserveBallast(id:) / releaseBallast(id:)
  busy(id:) -> Bool (lock) }
final class FileSink { apply(_ cmds: [SinkCommand]); tick() /* 1 s: watermark flush */; checkpoint() /* 5 s */
  var figures: SinkFigures }
final class RecoveryRunner { run() -> RecoveryReport /* counts: recovered, finished, discarded, swept */ }
final class TarExporter { plan(id:) throws -> PartPlan; export(id:, grant:, progress:) throws -> ExportResult }
final class SelfTest { run(keep: Bool, grant: RecordingGrant?) -> SelfTestReport }
```

### 3.3 Expo module (`CaptureNativeModule.swift`)

```swift
Name("CaptureNative")
Function("getCapabilities") { Capabilities.current() }   // + recorder {compiled, canRecord, refusal, buildProfile}
Function("getLogTail") { LogRing.shared.lines() }         // ≤200 value-free codes
Class(CaptureSession.self) {                             // no Events() here (D20)
  Constructor { CaptureSession() }
  AsyncFunction("start") { (s: CaptureSession, o: StartOptions) throws -> [String: Any] in try s.start(o) }.runOnQueue(.main)
  AsyncFunction("markAnchor") { (s: CaptureSession, o: MarkAnchorOptions, p: Promise) in s.markAnchor(o, p) }  // resolved on the next frame
  AsyncFunction("addTag")     { (s: CaptureSession, o: AddTagOptions, p: Promise) in s.addTag(o, p) }
  AsyncFunction("stop")       { (s: CaptureSession, p: Promise) in s.stop(p) }
  AsyncFunction("discard")    { (s: CaptureSession, p: Promise) in s.discard(p) }
  AsyncFunction("appendBoundary") { (s: CaptureSession, lines: [String], final: Bool) in s.appendBoundary(lines, final) }
}
View(CaptureView.self) { Prop("session") { (v: CaptureView, s: CaptureSession?) in v.attach(s) } }
Events("exportProgress")
AsyncFunction("listRecordings"); AsyncFunction("exportRecording") { (id: String, p: Promise) }
AsyncFunction("deleteRecording") { (id: String) }; AsyncFunction("recoveryStatus")
AsyncFunction("recorderSelfTest") { (keep: Bool) }; AsyncFunction("requestRecorderPermissions")  // walk only
OnCreate { RecorderPlumbing.shared.scheduleRecovery() }  // ioQueue, once protected data is available
```

- Without `USG_RECORDER`, the recorder functions exist and reject with `ERR_RECORDER_NOT_COMPILED`.
- **Session events** go out through `emit(event:payload:)`:
  - `status`, at 5 Hz, carrying `t`, tracking, mapping, fps, candidates/s, mesh anchors, thermal, the cover, and `recorder` (state, degradation, `closingInS`); every fifth one also carries `debug`;
  - `warning`;
  - `recording`, on state changes: `armed`, `open` (with `startT`), `closing`, `finalizing`, `closed` (with `ended`, `trimmed` and `closed`), `discarded` and `failed` (with `code`);
  - `stopped`.
- **Errors** are `Exception`s whose code and reason are constant strings:
  - `ERR_RECORDER_NOT_COMPILED`, `ERR_RECORD_REFUSED` (reason = the refusal code), `ERR_PROFILE_UNAVAILABLE`, `ERR_INVALID_VENUES`, `ERR_NO_SPACE`, `ERR_RECOVERY_PENDING`;
  - `ERR_NO_VIEW`, `ERR_NOT_RUNNING`, `ERR_TRACKING`, `ERR_NO_FLOOR_HIT`;
  - `ERR_EXPORT_REFUSED`, `ERR_EXPORT_TOO_LARGE`, `ERR_RECORDING_CORRUPT`, `ERR_RECORDING_BUSY`;
  - `ERR_IO` (an errno class only).

### 3.4 TypeScript `CaptureNative`

```ts
export type RecordProfile = "off" | "lean" | "standard" | "dense";
export interface StartOptions { record: RecordProfile; venues: readonly string[] }
export interface MarkAnchorOptions { role: "start" | "end"; kind: "floor_point"; streetFacing: boolean;
  endSessionHere: boolean; name: string | null }
export interface MarkAnchorResult { t: SessionTime; frame: number; anchorId: string;
  hit: Redacted<{ point: Vec3; normal: Vec3; transform: Mat4 }>; facing: Redacted<Vec3> | null;
  camera: Redacted<Mat4>; window: "opened" | "open" | "closing" | "not_open" }
export interface AddTagOptions { type: "node" | "poi"; kind: string; name: string | null }
export interface AddTagResult { t: SessionTime; frame: number; position: Redacted<Vec3>; camera: Redacted<Mat4> }
export interface StopResult { t: SessionTime; recording: { id: string; ended: RecordingEnded; trimmed: boolean; closed: boolean } | null }
export interface CaptureNative {
  capabilities(): Capabilities; openSession(): CaptureSessionPort; listRecordings(): Promise<RecordingSummary[]>;
  exportRecording(id: string): Promise<{ parts: number; tarBytes: number }>; deleteRecording(id: string): Promise<void>;
  recoveryStatus(): Promise<RecoveryReport>; selfTest(keep: boolean): Promise<SelfTestReport>;
  requestPermissions(): Promise<{ location: string; motion: string }>; logTail(): string[] }
export interface CaptureSessionPort { readonly native: CaptureSession; start(o: StartOptions): Promise<{ recordingId: string | null }>;
  markAnchor(o): Promise<MarkAnchorResult>; addTag(o): Promise<AddTagResult>; stop(): Promise<StopResult>;
  discard(): Promise<void>; on(e: "status" | "warning" | "recording" | "stopped", cb): () => void; release(): void }
export interface RecordingSummary { id: string; origin: "device" | "synthetic"; profile: RecordProfile;
  state: "open" | "needs_recovery" | "closed" | "recovered" | "exported"; ended: RecordingEnded | null;
  trimmed: boolean; durationS: number | null; bytes: number; files: number; ageDays: number; venues: string[];
  exportParts: number | null }
```

- The adapter feeds every event and result to `BoundaryTrace.record(kind, t, raw)` **before** it wraps pose-bearing fields and `t` in `Redacted`. Nothing else unwraps a `Redacted` except the code that uses the value.
- BoundaryTrace (D21):
  - each line is `{t, seq, kind, value: JsonText-bounded JSON.stringify(raw), binary: null}`, serialised with sorted keys;
  - it flushes every 1 s (piggybacking on status), at 64 lines, on AppState change, and with `final: true` on `recording: finalizing` and before `stop` or `discard`;
  - plumbing calls are never traced.
- The screen keeps the session object in a ref for the whole capture, so a collected JS object can't drop its events.

---

## 4. Threads and queues

| Queue | QoS | Work | Budget |
|---|---|---|---|
| main | — | UI, ARView, PrivacyShield, scene notifications, `session.run` and `pause`, `CLLocationManager` (created only with a grant; its delegate forwards `GnssFix` values), `beginBackgroundTask`, `isIdleTimerDisabled` | nothing per frame |
| `usg.capture` (serial) | userInitiated | `ARSession.delegateQueue` (D4); FrameSample build; CandidateGate; RecorderCore; RecorderWindow; MeshHistorySchedule from didAdd, didUpdate and didRemove; marks, tags and stop handled **on the next delegate frame** [perf] (`frame.raycastQuery(from: CGPoint(0.5,0.5), allowing: .estimatedPlane, alignment: .horizontal)`, then `session.raycast`; a hit adds `ARAnchor(name: "usg.marked.<role>")` and forces the gate); copying changed mesh geometry on snapshot frames (D5); status 5 Hz and telemetry 1 Hz `DispatchSourceTimer`s; 100 ms command batches to ioQueue | p95 < 0.3 ms per frame; < 4 ms on a snapshot frame |
| `usg.capture.motion` (an OperationQueue, max 1, over a serial queue) | userInitiated | accelerometer and gyro (0.01 s) → ImuPairer; device motion (0.01 s); altimeter; 10-sample batches → `capture.async` [perf] | < 50 µs per sample |
| `usg.mesh` (serial) | utility | pack, fingerprint, MeshLedger, `Deflate.raw`, then `io.async` with the block and line. A snapshot is taken only when this queue is idle (an atomic flag); otherwise the pending set waits | 20–120 ms per 5 s |
| `usg.recorder.io` (serial) | utility | encoding, watermark buffers, write(2), fsync and journal checkpoints, `recording.json`, finalize, recovery | < 2 % of a core |
| `usg.recordings.store` (serial) | utility | list, export, delete, self-test; per-recording busy flags under a lock in RecordingStore | I/O speed |
| JS | — | events (5 Hz), trace flush (1 Hz) | — |

**Rules.**
- No queue blocks on another; `.sync` appears only in tests.
- ARFrame and ARMeshAnchor references never outlive the delegate callback.
- Finalize is chained: `motionQueue.addBarrierBlock { capture.async { mesh.async { io.async { finalize } } } }`, so every sample ≤ `end_t` that was already delivered lands first.
- `dispatchPrecondition` checks run in debug and test paths only.

---

## 5. Data flow per stream (lean)

| File | Source → line | Rate |
|---|---|---|
| frames.jsonl | Delegate frame:<br>- `camera.transform` (16 floats, `Double(shortest:)`);<br>- intrinsics ([0][0], [1][1], [2][0], [2][1]);<br>- tracking `normal` / `limited:<reason>` / `notAvailable`;<br>- `worldMappingStatus`;<br>- exposure;<br>- light (or null);<br>- `gap = framesSkipped(previousT:t:fps)` (0 on the first written line);<br>- `candidate`: null or `dropped:profile` (forced ones included);<br>- `sharpness`: null;<br>- `ms {gate}`.<br>Frame ≥ 1,000,000 → close `limit` | 60 Hz, about 1.5 MB/min |
| imu.jsonl | ImuPairer; accel × 9.80665 | 100 Hz |
| motion.jsonl | `startDeviceMotionUpdates(using:)`. Reference frame: `xMagneticNorthZVertical` if available, else `xArbitraryCorrectedZVertical`, else `xArbitraryZVertical`; written to `motion.reference_frame` (Q3). `heading` is null in arbitrary frames or when negative. Without device motion: a `motion_unavailable` event, `motion: null`, and an empty file | 100 Hz |
| altitude.jsonl | Created on its first line. `isRelativeAltitudeAvailable` and `authorizationStatus`; unavailable or denied → an event. AltitudeRebaser | ~1 Hz |
| anchors.jsonl | Baseline at open (every anchor `add`, on the opening frame), then each mesh-snapshot `t` (threshold 1 mm or 0.05°), and the final sample (D1). Kinds: `mesh`, `marked` | bursts / 5 s |
| mesh/history.* | Section 8 | 5 s |
| events.jsonl | Delegate failures and interruptions; relocalization transitions; thermal notification; memory warning; scene background and foreground; shield screenshot and capture-state callbacks; sensor availability; degradation. At open, `configuration` codes: `lean`, `mesh_with_classification`, `smoothed_scene_depth`, `gravity`, `video_<w>x<h>_<fps>`, `motion_<frame>`, `gnss_t_fix_age`, `margin_<s>s`, `idle_<s>s` | on change |
| actions.jsonl | `SessionCall` only. `args` is the Record's `toDictionary` through JSONSerialization `.sortedKeys`, as JsonText; `result` is what was resolved; `error` is the code. Kept only if `accepts(t)` | per call |
| telemetry.jsonl | DeviceProbe: `thermalState`, `phys_footprint`, Σ `thread_info` CPU, free disk (cached), `queue 0`, counts (Q8), `stage_ms {gate}` | 1 Hz |
| location.jsonl | Walk only, with a grant, started at `start` (best accuracy, no filter, no auto-pause), t per D15 → GnssWindows (`add`, `markStreetAnchor`, `recordingOpened`) → `accepts`. Stopped at close, and the ring is dropped | 1 Hz, in windows |
| boundary.jsonl | `appendBoundary` → BoundaryLineCheck → line | ~5 Hz in 1 s batches |
| recording.json | Written at open: `closed: false`, `files: []`, `segments: []`, `rates`/`end_t`/`ended` null, `detector_versions: null`, `origin: device`, `build.profile: walk`. Rewritten at finalize | — |

Lean is about 4–6 MB/min plus the mesh history.

---

## 6. Recorder state machine

| From | Event | To and actions |
|---|---|---|
| off | `start(lean)` with a grant, recovery done, free ≥ 16 GiB | **armed**: sensors and location on; PreOpenBuffer; GNSS ring in memory; **nothing on disk** |
| off | `start(record ≠ off)` without a grant | reject `ERR_RECORD_REFUSED` (refusal code) |
| armed | stop, discard, failure, background, view gone | off; nothing written |
| armed | first start mark at frame t | **open**:<br>1. journal `open` (full sync);<br>2. mkdir `rec-<id>/` (completeUnlessOpen, excluded from backup);<br>3. `recording.json`;<br>4. 64 MiB ballast;<br>5. events `recording_opened` and configuration;<br>6. PreOpenBuffer released (≥ t);<br>7. the mark's frame line;<br>8. baseline anchors;<br>9. `MeshHistorySchedule.take` with every current mesh anchor marked updated (baseline mesh);<br>10. `GnssWindows.recordingOpened`, plus `markStreetAnchor` if street-facing;<br>11. emit `recording {open, startT}` |
| open | end mark at te | journal `end{te}` (full sync); `registerCut(te + margin)` |
| open | end mark + endSessionHere | **closing**: journal `closing{deadline}` |
| closing | frame with `t + 1.5/fps ≥ deadline` (or the expiry fallback, D16) | **finalizing** (`end_anchor`, final sample from this frame) → `stopSession` |
| closing | stop | handled on the next frame: `window.stop(at: t)` → `end_anchor` at t, **with** a final sample from that frame. If no frame comes within 0.5 s, `session.currentFrame` is read once on captureQueue |
| open | idle (`observe`) | finalizing (`idle`, final sample from that frame) |
| open or closing | `background` (scene didEnterBackground → `capture.async`), `heat` or `disk` (ladder `no_recording`), `limit` (limit `t`, a size limit, frame ≥ 1e6), ENOSPC or EIO | finalizing (that reason, `endT` = last frame `t` or the limit `t`, **no final sample**) |
| open | stop with an end anchor | finalizing (`stop`, `endT = min(t, lastEnd + margin)`, `trimmed`, no final sample, cut checkpoint) |
| open | stop without an end anchor, or discard | **discarding**: journal `discard` → delete the directory and journal |
| finalizing | Section 7.5 | **closed**; emit `recording {closed, ended, trimmed, closed}`. For `end_anchor` the session is already stopping (`stopped`) |

**Degradation**, on the thermal notification and each telemetry tick:
- `serious` or free < 2 GiB → `no_mesh_history`: the schedule is ignored and the final sample has no mesh part.
- `critical` or free < 1 GiB → `no_recording`: close with `heat` or `disk`.

Each step is written as a `degradation` event before it is applied.

---

## 7. File I/O

**7.1 Layout and protection.**
- `Library/Application Support/recordings/` is excluded from backup (set again at every launch). It holds:
  - `rec-<id>/`: the directory and its files are created `.completeUnlessOpen`, then opened `O_WRONLY|O_APPEND|O_CLOEXEC`; `history.bin` is opened `O_RDWR|O_APPEND`;
  - `.journal-<id>.jsonl` (class B);
  - `.staging/`;
  - `.ballast-<id>` (`F_PREALLOCATE` + `ftruncate`, 64 MiB).
- Exports are staged in `Library/Application Support/exports-staging/`, then renamed into `Documents/exports/replay-<id>/`. Both are excluded from backup, class A.
- Only `exports/` is ever created under Documents.

**7.2 Buffering.**
- Each writer holds its lines until `t ≤ watermark = latestFrameT − 0.5 s`.
- An ioQueue tick every 1 s writes whole lines with one write(2) per file. It then updates `committedBytes`, then the hash, only after a fully successful write.
- At about 70 KB/s that is about 12 writes a second.
- A clean close never truncates the disk: lines past `endT` are still in memory and are dropped.
- A backlog over 64 MiB (I/O stalled) closes with `disk`.

**7.3 Sync cadence (D7).** Every 5 s, and at open, at each end mark, at closing and at finalize:
1. fsync each dirty file;
2. journal `checkpoint{seq, sizes, binBytes}`;
3. `F_FULLFSYNC` on the journal.

Expected about 12 fsyncs plus 1 full sync per 5 s. The debug figures give p95, and the cadence can be changed in config.

**7.4 Cut checkpoint.**
- `registerCut(cutT)` arms each writer. When a flush is about to write that file's first line with `t > cutT`, the writer snapshots `(committedBytes, Sha256Stream copy)`. MeshHistoryWriter snapshots the bin and index pair together.
- A stop cut-back is then: `ftruncate`, restore the hash, fsync. Nothing is reread.
- If the watermark hasn't reached `cutT`, the writer just drops buffered lines with `t > cutT`.

**7.5 Finalize** (one ioQueue job, in a background task when it was triggered by background):
1. The window is closed on captureQueue, so no more lines are accepted. For end_anchor and idle, the final-sample lines (`t = end_t`) and the final mesh job are enqueued.
2. The chained barrier (section 4) ensures every queued line and block has arrived.
3. Each writer runs `finish(endT, useCut)`, then flush and fsync. Journal `closed{endT, reason, trimmed, finalSample}` and full sync.
4. Foreground closes only: wait up to 1 s for `appendBoundary(final: true)` with lines `t ≤ endT`. Background closes skip this.
5. Close the file descriptors. `files` comes from the incremental hashes. Rates:
   - `frames_hz`, `candidates_hz` (non-null candidate), `imu_hz`, `motion_hz` = lines ÷ (end − start);
   - `mesh_interval_s` = mean gap between distinct snapshot `t`, or null.
6. `AtomicJsonWriter`: `.staging/<id>.json` → `F_FULLFSYNC` → `rename` → fsync the directory. Then journal `manifest{}`.
7. If protected data is available: upgrade every file and the directory to `.complete`. Otherwise journal `protectionPending` and finish on `protectedDataDidBecomeAvailable` or at the next launch.
8. Release the ballast, delete the journal, end the background task.

A lean background close is expected to take under 1 s: no final sample, about 1.5 s of buffered lines. On expiry, recovery finishes from the journal.

**7.6 Locked phone.**
- Open class-B file descriptors stay writable.
- Staging files are created while locked.
- Finalize reads nothing.
- The protection upgrade, recovery, export, list and self-test wait for `isProtectedDataAvailable`.
- `start` refuses until recovery is done (`ERR_RECOVERY_PENDING`).

**7.7 Full disk and limits.**
- `start` refuses below 16 GiB free (the ADR's 2 × `maxRecordingBytes`; Q10).
- On ENOSPC or EIO: truncate the file to `committedBytes`, release the ballast, close with `disk`.
- Size limits close with `limit`: directory 8 GiB, each JSONL 256 MiB, history.bin 2 GiB, 60,000 entries.
- A mesh block over 64 MiB inflated, or a line over 64 KiB, is skipped and counted.

**Recovery at launch** (`RecoveryRunner`, idempotent; reports counts only):
1. Delete `.staging/*`, `exports-staging/*` and the `.ballast-*` files.
2. For each journal:
   - `discard` → delete the directory and journal;
   - `manifest` → protection, then delete the journal;
   - otherwise scan and plan (3.1): `finishClean` gives `closed: true`; `cut` gives `closed: false` with `interrupted` and `trimmed`, final lines removed. Then rehash, rates, atomic `recording.json`, protection, delete the journal.
3. For each `rec-*` without a journal: `recording.json` `window.ended` non-null → protection sweep (D3); null or unreadable → delete.
4. For `exports/replay-<id>/parts.json` next to a surviving `rec-<id>/`: re-verify the parts' SHA-256, then delete the raw directory.

---

## 8. Mesh-history extraction

- **Snapshot frame** (captureQueue, every 5 s, only while open, mesh queue idle and `keepsMeshHistory`):
  1. `plan = schedule.take(at: t)`.
  2. Build a dictionary of `frame.anchors` by id (about 1–2 ms for about 2k anchors, measured as `snapshotCollectMs`).
  3. `AnchorSampler.sample(t, all)` gives the anchors.jsonl lines.
  4. For each id in `plan.updated`, copy:
     - `geometry.vertices` (honouring `offset`, `stride` and `format == .float3`);
     - `geometry.faces` (`bytesPerIndex` 4, or 2 widened; `indexCountPerPrimitive == 3`);
     - `geometry.classification` (`.uchar`, or zeros);
     - `anchor.transform`.

     These are memcpys from `MTLBuffer.contents()` inside the callback: about 30–80 anchors, 1–5 MB, 1–3 ms.
  5. Dispatch `MeshJob {t, final: false, copies, removed}` to the mesh queue.
- **Mesh queue:**
  1. Pack, fingerprint, `ledger.decide`:
     - `skipUnchanged`: a transform-only change, already covered by anchors.jsonl;
     - `writeNew`: `Deflate.raw` (≈ 30–60 ms for 10–30 changed anchors).
  2. Removals: index lines only, and only for anchors that were written.
  3. Send `(block, line)` pairs to ioQueue; the line is encoded once the block's offset is known.
- **Final snapshot (D6):**
  - Use `takeFinal(at: endT, all: meshIDs)`.
  - Anchors in the pending-updated set are copied and decided as above.
  - Every other anchor is `.reuse(offset, bytes)` from the ledger: `pread` from history.bin and append, with no copy and no recompression.
  - All lines carry `final: true` and `capture_id: null`.
  - Expected about 0.1–0.5 s for about 2k anchors; at worst (everything changed) 1.5–3 s after `session.pause()`, behind "Saving…".
- **Size:** expected 10–50 MB/min (a debug figure). `didUpdate` firing for transform-only changes inflates only the copies, not the blocks.

---

## 9. Export, list, delete and self-test (store queue)

**`exportRecording(id)`:**
1. Preconditions: a grant, recording closed or recovered, not busy, protected data available.
2. `PartPlan`: refuse with `ERR_EXPORT_TOO_LARGE` over 4,096 parts, or `ERR_NO_SPACE` if free < tarBytes + 64 MiB (the raw files are kept either way).
3. Stream into `exports-staging/replay-<id>/NNNN.part` in 1 MiB reads, re-hashing each source file and comparing it with `recording.json` `files` (a mismatch gives `ERR_RECORDING_CORRUPT`; staging is deleted, the raw files kept). Compute the per-part and whole-tar SHA-256 in the same pass. `F_FULLFSYNC` each part.
4. Write `parts.json` (`RecordingDocuments.exportParts`, the generated `ExportParts`) and full sync.
5. Rename into `Documents/exports/replay-<id>/` and fsync `exports/`.
6. Delete `rec-<id>/`.

Progress goes out through `exportProgress` at ≤ 5 Hz, with the idle timer off and inside a background task.

**`listRecordings`** reads `recording.json`, the journals and `exports/`. It returns counts, sizes, the duration and `ageDays` only — no dates or times.

**`deleteRecording(id)`** removes the raw directory, the replay folder and the journal. It refuses a live recording.

**`recorderSelfTest(keep)`** (D18) runs `SyntheticSession(durationS: 60)` through RecorderCore and FileSink with the real FileSecurity. It reports:
- the protection class read back while writing and after closing;
- whether the backup flag is set;
- Compression and CryptoKit results against the fallbacks;
- MB/s for encode, deflate and SHA-256;
- the Documents top-level names.

In the development build it runs under `Library/Application Support/selftest/` and deletes everything afterwards; leftovers are swept at launch. In the walk build, `keep: true` leaves the set as `rec-<id>` (`origin: synthetic`, `build.profile: synthetic`) for export.

---

## 10. Walk build profile and workflow

- **W1 (EAS cloud).** The owner runs `pnpm --filter @usg/mapper exec eas build -p ios --profile walk` interactively from the PC. This creates the ad hoc provisioning profile with the registered iPhone and team in EAS-managed credentials. The install link from expo.dev stays private to the account.
- **`walk-build.yml`** (later walk builds):
  - Trigger and environment: `workflow_dispatch`, `macos-26`, environment `walk` (required reviewer: the owner), secret `EXPO_TOKEN`, `permissions: contents: read`, checkout with `persist-credentials: false`.
  - Steps:
    1. pnpm install.
    2. `eas build --local --profile walk --platform ios --non-interactive --output "$RUNNER_TEMP/walk.ipa" > "$RUNNER_TEMP/build.log" 2>&1`.
    3. On failure, print only `error:` lines, with UUIDs, 40-hex strings and URLs masked by sed.
    4. `eas upload --platform ios --build-path "$RUNNER_TEMP/walk.ipa" --non-interactive > /dev/null 2>&1`, keeping only the exit status. Confirm the command exists in the pinned eas-cli (`catalog:`); otherwise use EAS cloud.
  - No `actions/upload-artifact`; a Vitest test over the YAML enforces it. The owner reviews the first run's log.
- **Walk build behaviour:**
  - Release, so no dev menu and no dev launcher.
  - `LogGuard` (D19) is installed at launch when `USGBuildProfile == walk`: `RCTSetLogFunction` with a block that drops `RCTLogSourceJavaScript` and forwards native messages. JS `installLogGuard()` replaces `nativeLoggingHook` and `console.*` with no-ops and wraps the `ErrorUtils` handler to replace the message with "[redacted capture error]". `__DEV__` is false, so LogBox is off.
  - A native red REC badge in CaptureView, driven on main from the recorder state, mirrors the JS badge.
- **Walk flow** (the `flow.ts` reducer):
  1. venues;
  2. record Off or Lean (Lean is enabled only when `canRecord`);
  3. permissions;
  4. Start;
  5. Mark start (street-facing toggle);
  6. tags;
  7. Mark end, or "Mark end and end the session here", with a 5 s hold-still countdown;
  8. Saving…;
  9. a summary (counts and durations).

  The map is unmounted. The Recordings screen has Export (with progress), Delete, the Apple Devices runbook (save straight into `.data/holding/<id>/`, never Downloads, Documents, Desktop or a OneDrive folder) and the self-test.

## 11. Development-build desk-check rules

- There is no grant, so:
  - `start` with any record other than `off` → `ERR_RECORD_REFUSED` (`debugBuild`, `notWalkBuild`, `devClient`, `notEmbedded`);
  - `exportRecording` and `requestRecorderPermissions` → refused;
  - `LocationSource`, `RecorderHost` and `TarExporter.export` can't be constructed or called.
- There is no NSLocation key, so Location Services never lists the app.
- A desk check (`record: off`) writes no file. Desk-check file deletion lands with the first file such a capture writes (bundles).
- The self-test writes only synthetic data and deletes it.
- `listRecordings`, `deleteRecording` and recovery work, so the development build can tidy up but never export. That stranding is a known risk.

## 12. Privacy invariants under failure

- **Nothing before the window:**
  - the journal and directory are created at the first start mark;
  - PreOpenBuffer and the GNSS ring live only in memory;
  - `accepts(t)` gates every line;
  - `GnssWindows` never returns a fix from before `recordingOpened`;
  - recovery only removes lines.
- **Nothing past the last end anchor + margin after a crash:**
  - recovery cuts using only journaled `end{}` records, each full-synced before anything later counts;
  - without an end anchor the recording is discarded;
  - a recording cut back by recovery has no final lines.
- **Logs and errors:**
  - `os.Logger` category `recorder` logs codes, counts, file names and frame numbers, with `.public` only on codes;
  - exceptions carry constant reasons;
  - a system error contributes only its code, never `\(error)`;
  - recovery, export and self-test reports are counts;
  - LogRing holds codes.
- **Documents** holds only `exports/`. The debug screen lists the top-level names.
- **Backups:** the roots are excluded, and the owner has iCloud Backup off.

## 13. Debug figures (status `debug` at 1 Hz, debug card)

- **Delegate:** µs p50 and p95, snapshot-frame ms, gaps (total and largest), fps, delivery lag (systemUptime − frame.timestamp).
- **Motion:** samples per second, lag.
- **Recorder:**
  - state, degradation, window length in s (a duration);
  - per stream: bytes, MB/min, lines/s, drops (outside window, non-increasing, too long, backpressure);
  - backlog KiB, checkpoint age, fsync and full-sync p95, encode µs p95.
- **Mesh:** snapshots taken and skipped (busy), anchors, copy, collect and deflate p50/p95, blocks written, reused and skipped, raw and compressed MB, final snapshot ms, finalize ms.
- **GNSS:** state (off, buffering, window), fixes buffered and written (counts), authorisation (precise or reduced).
- **Device:** thermal, s to fair and serious, memory (current and peak), CPU, free disk, Low Power Mode, protection class of frames.jsonl, Documents names.
- **Reports:** recovery report, self-test report, `getLogTail()`.

## 14. What is tested where

- **Linux `swift test`** (container) runs CaptureCore and CaptureIO with fallbacks, plus `USG_NO_RECORDER=1 swift build`. It covers:
  - every encoder against the goldens (heading null in arbitrary frames, attitude not renormalised, g → m/s², explicit nulls, `final` and `capture_id`);
  - event details against a table copied from `RECORDING_EVENT_DETAILS`; ConfigCode; JsonText; BoundaryLineCheck;
  - RecorderCore scripted sessions:
    - open at the mark, with PreOpenBuffer release, baseline anchors and mesh;
    - End the session here early-close, and the expiry fallback **with** a final sample;
    - stop while closing (final), and stop while open, with and without an end anchor (no final, cut);
    - idle (final);
    - background, heat, disk and limit (no final sample, D1);
    - discard; degradation order; GNSS before open never written; boundary `seq` and window checks; actions without plumbing;
  - ImuPairer, AltitudeRebaser, Facing, MeshBlockLayout bytes, fingerprint, MeshLedger (add, update, skip, reuse, remove of a never-written anchor), sampleFinal;
  - Journal codec; RecoveryScan on synthetic damage (torn line, NUL tail, missing newline, garbage, out-of-order `t`, index past the bin end, a bad block past the checkpoint); RecoveryPlan for every journal shape, including D3's no-journal rules and the removal of final lines;
  - TarLayout headers and checksums against vectors; PartPlan (16 MiB boundaries, 4,097 refused); RecordPermission truth table;
  - FileSink on temp directories:
    - the bytes equal MemorySink's for the same SyntheticSession;
    - the incremental hash equals the full hash;
    - the cut-checkpoint hash equals the hash of the truncated file;
    - AtomicJsonWriter leaves old or new on an injected failure;
    - ENOSPC (injected) leaves no partial line;
    - recovery on damaged copies;
  - TarExporter: too large, corrupt source, crash between rename and delete.
- **macOS `swift test`:** the above, plus CryptoKit vs the fallback SHA-256 (NIST vectors), and Compression ↔ `compression_decode_buffer` round trips and Compression vs stored blocks. FileSecurity is a recording fake.
- **macOS CI job:**
  - `swift run capture-synth --out $RUNNER_TEMP/synth --export`, then `validate-recording` on `rec-<id>/` and on `--parts` (inflating every block and checking 12v + 13f);
  - `USG_RECORDER=1 USG_BUILD_PROFILE=walk expo prebuild`, `pod install`, an unsigned **Release** build;
  - the encoder check over the CaptureNative, CaptureCore and CaptureIO objects with an empty allow-list;
  - `nm` asserts that recorder symbols exist;
  - the React import probe for LogGuard.
- **Vitest** (Windows and Ubuntu):
  - `recorderSettings`: off gives nothing and removes the property; the location key only in walk; `LSSupportsOpeningDocumentsInPlace` absent; a bad profile throws; git and EAS ids validated;
  - eas.json: only development and walk set the switch; walk is Release, internal, not a dev client, with no submit;
  - the walk-build YAML: no `upload-artifact`, output redirected;
  - BoundaryTrace on a synthetic session: lines validate against `boundary-line.schema.json`, `seq` from 0 at open, too-large marker, final flush;
  - Redacted through `String`, `JSON.stringify` and `util.inspect`;
  - no-pose-logging source scan, including planted `console.log(pose)` and ``new Error(`${pose}`)`` cases;
  - the log guard drops output and sanitises errors;
  - `flow.ts`, `figures.ts`; venues equal to the seed; native-dependencies unchanged;
  - `swift-goldens.test.ts` re-validates the regenerated goldens.
- **Device only (owner)** — per PR, section 15.

## 15. PRs in order

**Recording-track prerequisites** (TypeScript, in parallel):
- **P-A** `validate-recording` basic, plus a `--parts` input (verifies `parts.json` hashes and streams the reassembled tar without writing a joined file), plus the mesh-block inflate check. Needed by PR2's CI step and by the PC after W1.
- **P-B** one synthetic set with the git checks and the pre-push hook.
- **P-C** value-free venue tests.
- **Owner:** Claude Code deny rules for `.data/` in `.claude/settings.json`, before any recording reaches the PC.

| PR | Ships | Tested | Build and owner checks |
|---|---|---|---|
| PR0 | Merge feat/recording-schemas and feat/capture-core. `GENERATED_SWIFT_FILE` = the module path (D22); delete `generated/swift/`; both CI typecheck steps point at the module copy. `pnpm gen` (adds `motion`, nullable segment `end_t`/`manifest_sha256`, `final`/`capture_id` on anchor lines, `capture_id` on mesh lines). Regenerate the goldens and LineEncoderTests | Linux and macOS swift test, swift-goldens Vitest, gen diff check | **B1: development build on EAS cloud now.** Owner checks: `getCapabilities` reports LiDAR; the capture runs; the app-switcher snapshot shows the cover; a screenshot is black; a screen recording shows the cover; build-to-device loop time (criterion 1). If the secure canvas fails, stop: the walk is blocked (the ADR's risk) |
| PR1 | CaptureCore recorder logic (3.1), RecordPermission and RecordingGrant, SyntheticSession, MemorySink, the gating, Package.swift default define | Linux and macOS swift test; `USG_NO_RECORDER=1 swift build` | none |
| PR2 | CaptureIO target and pod (in `expo-module.config.json`), fallbacks, FileSink, RecoveryRunner, TarExporter, SelfTest, `capture-synth`, the CI step synth → validate-recording (needs P-A) | Linux and macOS swift test; macOS CI validate on the directory and `--parts`; encoder check over 3 pods | none |
| PR3 | Config plugin, `usg-recorder.rb`, `-O`, eas.json development env and walk profile, CI walk-like prebuild with a Release build, `nm` recorder assertion, React import probe | Vitest plugin and profiles; macOS CI | none |
| PR4 | TypeScript: CaptureNative port and adapter, Redacted, BoundaryTrace, log guard, lint scan, flow reducer, venues, tags (parallel to PR1–3) | Vitest | none |
| PR5 | Native glue (it compiles the CaptureSession class and needs its typings):<br>- CaptureSession SharedObject attached to the ARView's session with `delegateQueue` (D4), CaptureView reduced to render and attach;<br>- shield callbacks; ARKitAdapter, MeshCopier, MotionSource, LocationSource, DeviceProbe, DarwinFileSecurity;<br>- RecorderHost (queues, batching, timers), RecorderPlumbing, recovery at launch;<br>- BuildFacts, LogGuard, LogRing, the REC badge | macOS CI compile, encoder check, `nm` | none |
| PR6 | TypeScript screens: walk, recordings and the debug card; the Capture tab on the session API; `walk-build.yml`; the `docs/phone-testing.md` walk checklist; README runbook for export, Apple Devices and syslog | Vitest; YAML test | **B2: development build on EAS cloud.** Owner checks:<br>- refusals of `lean` and export (with the refusal code);<br>- never a location prompt, and the app not listed under Location Services;<br>- status at 5 Hz with the delegate off main (delegate figures), ARView still rendering;<br>- marks and tags resolve at a desk (redacted);<br>- the self-test passes (protection classes, backup flag, Compression and CryptoKit, timings, Documents holds only `exports` or nothing);<br>- 15 min `record: off` heat and frame-gap baseline.<br>JS fixes after B2 reach the phone through Metro only if the backlog's `pnpm dev:phone` dev-client mode exists; otherwise they ride W1 |
| PR7 | Fixes from B2 | as touched | **W1: walk build, EAS cloud, interactive** (credentials bootstrap). Owner checks (Done-when):<br>- installs over the development build; airplane mode; no dev menu or Metro;<br>- `start({record:'lean'})` works;<br>- Documents holds only `exports/` (USB listing);<br>- `pymobiledevice3 syslog` shows neither JS messages nor a fake-pose error thrown during a test capture;<br>- the self-test with `keep`, exported, copied with Apple Devices into `.data/holding/<id>/`, and `validate-recording --parts` (aggregate output, which Claude may run);<br>- a short **rehearsal lean recording at a public place** (Q6): start mark, end mark, End the session here, then the background-close and stop-cut-back variants, and a force-quit mid-recording (recovered as `interrupted` at relaunch); validated on the PC, then deleted on the phone and in holding;<br>- lock mid-recording: closes as `background`, the protection class reads `complete` after unlock;<br>- a 15 min `lean` heat comparison with B2's `off` baseline |
| PR8 (if needed) | Fixes from W1 | as touched | **W2: walk build** through `walk-build.yml` on the runner (exercises the workflow; first log reviewed by the owner), or on EAS. Then the **first corridor walk**: P1 and P2, one session per leg, cooling between legs, ending each leg with End the session here at a door; export; copy to `.data/holding/<id>/`; validate. Tick mapper tasks 1–4 and the recorder tasks with the measured figures |

EAS credits: B1, B2 and W1 (3 of 15), plus W2 if it goes to the cloud.

## 16. Right after the first walk

- `pnpm rec pull | import | ls | review | delete`; the reader and `meshAt(t)`; replaying the walk on the PC (the Phase 1 gate); the trace-playing fake.
- Harden `validate-recording` (fuzz tests, real sizes).
- Set the margin, idle timeout, ladder floors, fsync cadence and free-space floor from the figures.
- The blur and screen detector, keyframes, segments and bundles, `standard`.
- Task 8 switch checks (which also list `NSLocationWhenInUseUsageDescription`); crash reporting.

## Risks

- The secure-text-field canvas that keeps the camera out of screenshots is undocumented. If it fails on the iOS in use, start() refuses and no walk can happen. B1 checks it first, before the recorder work.
- D4 assumes RealityKit's ARView keeps rendering when its own session's delegate and delegateQueue are set to a background serial queue. If B2 shows otherwise, fall back to the delegate on main: value copies only, then a hop to captureQueue. That costs a development build.
- Only the walk build records, so the real recorder (sensors, file protection, background close, recovery) is first exercised in W1. Mitigations: the FileSink is checked byte for byte against MemorySink on Linux and macOS, capture-synth's export is validated in CI, the device self-test runs in B2, the Release walk-like CI build catches release-only problems, there is a rehearsal recording, and W2 is reserved.
- iOS behaviours that only the device confirms: class-B files can be created and open file descriptors written while locked; setting .complete is deferred while locked; F_FULLFSYNC costs little at a 5 s cadence (it may need tuning); volumeAvailableCapacityForImportantUsage is fast enough at 1 Hz (it is cached); frame.raycastQuery and session.raycast work on the delegate queue.
- Incremental hashing and the cut checkpoints are intricate. A bug gives wrong `files` hashes. Export re-hashes every file and refuses rather than deleting the raw files, but a walk recording would then need a manual fix, and recovery re-hashing can repair only interrupted ones.
- Mesh history cost and size are unmeasured. If many anchors changed in the last 5 s, the final snapshot can take seconds after session.pause(). A busy mesh queue spaces snapshots further apart (shown by mesh_interval_s). Copying geometry on the capture queue (D5) adds 1–4 ms on snapshot frames.
- Whether RCTSetLogFunction catches bridgeless JavaScript console output in RN 0.86, and whether React's headers import from the CaptureNative pod, are unproven. The JS layers (nativeLoggingHook, console, ErrorUtils) and the syslog fake-pose check in W1 cover it.
- Public Actions logs of later runner walk builds could expose UDIDs, the team id or an install link. Output is redirected and masked, `eas upload` output is discarded, the job runs in a protected environment, and the owner reviews the first log. `eas upload` must be confirmed to exist in the pinned eas-cli.
- D16's early close ends the recording up to 1.5 frames before the margin deadline. A frame gap at the deadline makes the final sample come from the first frame after end_t, stamped at end_t.
- Background closes keep data up to the close moment, not cut back to an end anchor, as RecorderWindow and the doc specify. A lock mid-leg therefore keeps a tail that doesn't end at a public anchor.
- Installing a development build over a walk build strands unexported recordings until a walk build is reinstalled, because the development build refuses export. A build without the recorder would delete them at launch.
- GNSS t from the fix's age assumes CLLocation.timestamp and the uptime clock agree over a few seconds. Core Location running all session long costs power for few fixes underground.
- The 16 GiB free-space floor at start (twice the 8 GiB limit) may refuse a lean walk on a fuller phone.
- The PC prerequisites (validate-recording --parts, the synthetic set with the git checks, value-free venue tests) and the .data deny rules must land before W1's export reaches the PC; PR2's CI step depends on validate-recording.

## Open questions for the owner

See "Defaults taken for the open questions" above.
