# capture-native

The mapper app's one native module ([ADR 0007](../../../../docs/decisions/0007-expo-mapper-app.md)): a local Expo module in Swift on the stable Expo Modules API. It runs only in development and walk builds; in Expo Go and on the web its exports are null.

## What it does so far

The module's surface follows [the lean recorder design](../../../../docs/reviews/2026-10-21-lean-recorder-design.md), 3.3; `src/types.ts` types it, and the app reaches it only through `src/capture/native.ts`, which traces the session's results and events and wraps every pose and session time ([apps/mapper/README.md](../../README.md#the-capture-port-and-the-walk-flow)).

- `getCapabilities()`: ARKit's own checks (world tracking, LiDAR scene reconstruction with classification, scene depth, video formats), the hardware model, the iOS version, and the recorder: whether it is compiled in, whether `start({ record: "lean" })` would be granted now and if not why (`RecordPermission`'s refusal), and the build profile from Info.plist. `getLogTail()`: the last 200 value-free codes the module logged (`LogRing`).
- `CaptureSession`, a shared object (design D4 and D20): JavaScript makes one and hands it to a `<CaptureView>` through its `session` prop. The session attaches to that view's ARView and runs the ARView's own ARSession with this module's delegate on its own serial queue (`usg.capture`), from `start`, when the mapper taps Start, never when the view mounts, to `stop`, `discard`, a change of the prop, or the view leaving its window. `markAnchor` and `addTag` resolve on the next frame (a mark refuses without normal tracking or without a floor under the screen's centre). Its events go out through `emit(event:payload:)`: `status` at 5 Hz (tracking, world mapping, frame and candidate rates and counts, mesh anchors, heat, whether the cover is on, the recorder's state, and every fifth one the debug figures), `warning` (screenshot, session failed, interruptions), `recording` and `stopped`. Nothing per frame crosses into JavaScript. `start({ record: "lean", venues })` asks `RecordPermission`: a development build always refuses (`ERR_RECORD_REFUSED` with the refusal's name), and the walk build records the session (below).
- The recorder in the app (`ios/Recorder/`, design PR5): `RecorderHost` owns `RecorderCore` on the capture queue and its `FileSink` on the I/O queue. Each ARFrame becomes a `FrameSample` inside the delegate callback (`ARKitAdapter`), and the anchors and mesh geometry `RecorderCore` asks for are read then too (`MeshCopier` copies vertices, faces and classes out of the Metal buffers before the callback returns). Marks, tags and `stop` are handled on the next frame: the first start mark opens the recording, an end mark with End the session here closes it a margin later and stops the session, and `stop` cuts it back (or keeps nothing without an end anchor). `MotionSource` pairs the accelerometer and gyro at 100 Hz, runs device motion in the reference frame of open question Q3 and the barometer, and hands batches of 10 to the capture queue; `LocationSource` (only with a grant, so never in the development build) feeds GNSS fixes with `t` from the fix's age (D15). Commands go to the I/O queue every 100 ms, the sink flushes every second and checkpoints every 5 s; when the window closes the finalize waits for Core Motion's queue to hand over what it holds (`RecorderCore.lateSamples`). Telemetry once a second runs the degradation ladder; thermal, memory, interruption, relocalization, screenshot and screen-capture events go to `events.jsonl`; a background close runs inside a background task. The mesh history's packing and DEFLATE run inside `FileSink` on the I/O queue, so there is no separate mesh queue.
- `<CaptureView>` renders and attaches: the camera with RealityKit's live mesh over it, inside the privacy shield, and a native REC badge driven from the session's recorder state.
- The privacy shield ([ADR 0010](../../../../docs/decisions/0010-capture-recording-and-replay.md#the-camera-view-ioss-snapshot-and-screenshots)): the camera sits inside a secure-entry text field's canvas, which iOS leaves out of screenshots and screen recordings; an opaque cover goes over it whenever the scene isn't foreground-active (so before iOS takes its app-switcher snapshot) and while the screen is recorded or mirrored; a screenshot taken during a capture raises a warning asking the owner to delete it. If this iOS has no secure canvas, `start` refuses (`ERR_NO_VIEW`).
- Every frame goes through `CaptureCore`'s candidate gate, as in every capture. With `record: off` nothing is written: no keyframes, no bundle, no recording.
- The recorder's plumbing (`ios/Recorder/RecorderPlumbing.swift`): the shared `RecordingStore` with the phone's `FileSecurity` (`DarwinFileSecurity`: Data Protection classes from a file's first byte, backup exclusion, and `isProtectedDataAvailable` followed on the main queue), recovery at launch once protected data is available, and `listRecordings`, `exportRecording` (progress through the module's `exportProgress` event, with the idle timer off and in a background task), `deleteRecording`, `recoveryStatus`, `recorderSelfTest` and `requestRecorderPermissions`, one at a time on the store queue. Every build has these functions: without the recorder they reject with `ERR_RECORDER_NOT_COMPILED`; the development build lists, deletes, recovers and self-tests, and only the walk build exports, keeps a self-test set or asks for location and motion (design 11). `DeviceProbe` reads heat, memory footprint, CPU, free space and Low Power Mode for the recorder's telemetry. `LogGuard` replaces React Native's log function in the walk build, from launch, so JavaScript's messages never reach the device log.
- The recorder's I/O in `CaptureIO`: `FileSink` applies `RecorderCore`'s commands to files, `RecoveryRunner` finishes or removes what a crash left at launch, `TarExporter` writes an export's parts, and `SelfTest` runs a synthetic session through all of it. `capture-synth` runs the same code on the PC and in CI.

Still to come, in the backlog's order: the device checks of the glue (B2, W1), the rest of `CaptureCore` (selector, backpressure), then the blur.

## Layout

```
expo-module.config.json   three pods: ios/CaptureNative.podspec, CaptureCore.podspec and CaptureIO.podspec
usg-recorder.rb           every podspec requires it: the USG_RECORDER condition from Podfile.properties.json, -O,
                          whole-module compilation
index.ts, src/types.ts    the TypeScript side: the module, the view and their types
ios/                      the Expo module (ARKit, RealityKit, UIKit): only the app build compiles it. The
                          bindings (CaptureNativeModule), CaptureSession and its ARSession delegate,
                          CaptureView, PrivacyShield, Capabilities, BuildFacts (what Info.plist and the
                          runtime say about the build), Queues, Log and LogRing
  Recorder/               each file whole under USG_RECORDER: RecorderHost (a session's recording),
                          ARKitAdapter and MeshCopier (ARKit's reads), MotionSource, LocationSource,
                          RecorderPlumbing, DarwinFileSecurity, DeviceProbe, LogGuard
Package.swift             SwiftPM, for `swift test`; the podspecs exclude it and Tests/
CaptureCore.podspec       CaptureCore as its own pod, so it is its own Swift module in the app too
Sources/CaptureCore/      Foundation only: WorldTransform, CandidateGate, RateMeter; the recorder's pure logic
                          (LineEncoder, RecorderWindow, GnssWindows, AnchorSampler, MeshHistorySchedule,
                          DegradationLadder, StageTimer, FrameGap); Recording/: the recorder's building
                          blocks (SessionClock, the samples, RecordingEvent, ConfigCode, SessionCall,
                          JsonText, BoundaryLineCheck, PendingLine, ImuPairer, AltitudeRebaser,
                          PreOpenBuffer, Facing, MeshBlockLayout, MeshFingerprint, MeshLedger) and the
                          recorder itself (RecorderCore and its SinkCommands, MeshJobRunner,
                          RecordingDocuments, Journal, RecoveryScan, RecoveryPlan, TarLayout, PartPlan,
                          RecordPermission with RecordingGrant, MemorySink, SyntheticSession); and
                          generated/Contracts.swift (written by `pnpm gen` from packages/contracts;
                          do not edit)
CaptureIO.podspec         CaptureIO as its own pod (depends on CaptureCore; Compression and CryptoKit)
Sources/CaptureIO/        Foundation and POSIX (Darwin or Glibc): DurableFile (append-only files, pread,
                          fsync and F_FULLFSYNC, truncate, the ballast's preallocation), Sha256Stream
                          (CryptoKit), Deflate (raw and inflate, Compression), AtomicJsonWriter, the
                          FileSecurity protocol (its Darwin implementation goes in ios/), TarParts (a
                          tar written straight into its parts, and read back); and the recorder's I/O:
                          RecordingPaths, JsonlFileWriter and MeshHistoryWriter (the watermark, the
                          incremental SHA-256, the cut checkpoints), RecordingStore (roots, list,
                          delete, free space, ballast, busy flags), FileSink (RecorderCore's commands
                          applied to files, design 7.5's finalize), RecoveryRunner (recovery at
                          launch), TarExporter (the export, which takes a RecordingGrant), SelfTest
                          and SyntheticRecording. Also the pure-Swift fallbacks Sha256Fallback and
                          StoredDeflate, compiled only without CryptoKit and Compression or under
                          Package.swift's USG_IO_FALLBACKS, never on iOS
Sources/capture-synth/    an executable for the PC and CI, never in a pod: a SyntheticSession recorded
                          by the real code into --out, exported with --export, recovered after a
                          simulated crash with --interrupt
Tests/CaptureCoreTests/   Swift Testing, and Golden/: one file per line type, byte-exact (UPDATE_GOLDENS=1 rewrites them);
                          Support/: the scripted-session harness, and SHA-256 and stored DEFLATE for MemorySink
Tests/CaptureCorePublicSurfaceTests/, Tests/PublicSurfaceProbe/
                          CaptureCore without @testable: the tests stop compiling if a member that must
                          stay internal (RecorderCore's grant) becomes public
Tests/CaptureIOTests/     Swift Testing on temporary directories; Support/: a recording FileSecurity fake,
                          a small inflate (stored, fixed and dynamic Huffman) for the round trips, and the
                          store fixture and scripted-session drivers for the sink, recovery and export
encoder-allowlist.json    the encoder check's allowed places (empty until the blur lands)
ci/planted/               planted encoder calls for the encoder check's self-test; in no pod
```

Rules ([ADR 0007](../../../../docs/decisions/0007-expo-mapper-app.md#swift-code-rules)): pure Swift goes in SwiftPM targets that import neither ARKit, UIKit nor `simd`; no third-party pods; scene-aware code (no `keyWindow` or app delegate); `os.Logger` (`captureLog`), never `print`, with nothing pose-bearing in a message.

## Testing

- **`swift test`** runs the SwiftPM targets. Without a Mac, run it in the official Swift container (Docker Desktop on Windows):

  ```bash
  docker run --rm -v "$(pwd -W):/src:ro" -w /src swift:6.3.3-noble swift test --scratch-path /tmp/build
  ```

  from this directory in Git Bash (`MSYS_NO_PATHCONV=1` in front if the path gets mangled). CI runs the same on Linux, and on the macOS runner.
- **The recorder switch.** The recorder's code is compiled only under the `USG_RECORDER` condition (ADR 0010). `Package.swift` defines it by default, so `swift test` covers the recorder; with `USG_NO_RECORDER=1` (`docker run -e USG_NO_RECORDER=1 ...`) it builds and tests without it, as a contributor build will, which CI's Linux job checks with `swift build`. What is gated: `RecorderWindow`, `MeshHistorySchedule`, `DegradationLadder` and everything in `Recording/` except `JsonText`, `MeshBlockLayout`, `MeshFingerprint`, `TarLayout` and `PartPlan`, which bundles will use too; in CaptureIO, everything but DurableFile, Sha256Stream, Deflate, AtomicJsonWriter, FileSecurity and TarParts. `capture-synth` built without it only says so and exits with 2. In the app, the config plugin (`apps/mapper/plugins/with-usg-recorder.ts`) writes `"usg.recorder": "true"` into `ios/Podfile.properties.json` for the development and walk builds (`USG_RECORDER=1` in their `eas.json` profiles), and `usg-recorder.rb` turns it into `SWIFT_ACTIVE_COMPILATION_CONDITIONS` for every pod of the module, so they all compile the recorder or none does. It also gives every pod `-O` and whole-module compilation in every configuration, so the development build's timings mean something. A new pod requires it the same way (`require_relative`, then `s.pod_target_xcconfig = usg_xcconfig`); `apps/mapper/test/podspecs.test.ts` checks every pod `expo-module.config.json` lists.
- **The fallbacks.** On Linux CaptureIO compiles its own SHA-256 and stored-block DEFLATE, since CryptoKit and Compression are absent, and `fsync` stands in for `F_FULLFSYNC`. `Package.swift` also defines `USG_IO_FALLBACKS`, so on macOS `swift test` checks the fallbacks against CryptoKit and Compression (design D17); the pods never define it.
- **What the recorder's I/O tests cover** (design 14): FileSink's files equal MemorySink's byte for byte for the same SyntheticSession, whatever the watermark's cadence, for End the session here and for a stop cut back on disk; the incremental digests equal the files' own and a cut checkpoint's the truncated file's; an injected ENOSPC leaves no partial line and closes as `disk`; recovery on damaged copies (a torn line, a NUL tail, a missing newline, an index past history.bin's end), a recording the recorder closed, the journal-less rules of D3 and the leftovers; the export's parts and refusals (too large, no room, a corrupt or resized source, open, busy) and a crash between the rename and the delete; the self-test, the store's list, delete, free space and ballast.
- **`capture-synth`** writes a synthetic recording with the real code, so `validate-recording` can check what FileSink, TarExporter and RecoveryRunner write. From this directory:

  ```bash
  docker run --rm -v "$(pwd -W):/src:ro" -v "$(cygpath -w "$TEMP"):/out" -w /src swift:6.3.3-noble \
    swift run --scratch-path /tmp/build capture-synth --out /out/synth --export
  node ../../../../packages/contracts/src/recording-validator/cli.ts "$TEMP"/synth/rec-*
  node ../../../../packages/contracts/src/recording-validator/cli.ts --parts "$TEMP"/synth/replay-*
  ```

  CI runs it on the macOS runner and validates the output there; the Linux job runs it too, but its Swift container has no Node, so there only capture-synth's own checks apply. `--interrupt 55` stops writing at 55 s as a crash would and lets RecoveryRunner cut the recording back (`interrupted`); `--duration 400` makes an export of two parts. Write it outside the repository: nothing generated by it is committed (design D13). It exports through `TarExporter.exportSynthetic`, which only Package.swift's `USG_SYNTHETIC_EXPORT` compiles and which refuses anything but `origin: synthetic`; the pods never define it, so on the phone only a `RecordingGrant` exports, and capture-synth never makes up `BuildFacts` to get one.
- **The macOS CI job** (`iOS native (macOS)` in `.github/workflows/ci.yml`): `swift test`; `capture-synth` (plain, interrupted and with two parts) checked by `validate-recording` as directories and as parts; the encoder check's self-test; then the app built as the walk build is: `expo prebuild` with `USG_RECORDER=1 USG_BUILD_PROFILE=walk`, `pod install` (and a check that every pod got the switch), an unsigned Release device build with the JavaScript bundled and embedded, a check of the app (`main.jsbundle`, `USGBuildProfile`, no `LSSupportsOpeningDocumentsInPlace`), the encoder check on this module's compiled objects, and an `nm` check that CaptureCore's objects define `RecorderCore`, CaptureIO's `FileSink`, CaptureNative's `RecorderHost`, and CaptureNative's reference `RCTSetLogFunction` (LogGuard), so a silent compile-out of the recorder fails the job.
- **The encoder check** (`apps/mapper/scripts/encoder-check.mts`, rules in `encoder-check-lib.mts`, tested in `test/encoder-check.test.ts`) reads each object file's undefined symbols (raw and demangled) and its Objective-C selectors, and fails on image and video encoders, raw pixel access, view snapshots and Photos writes outside `encoder-allowlist.json`. Its self-test compiles each file in `ci/planted/` and expects the rule named on its first line.
- **The native-dependency allow-list** (`apps/mapper/native-dependencies.json`, `test/native-dependencies.test.ts`) asks Expo's autolinking what native code the app links and fails on anything unreviewed or refused.

## Checking it on the phone (development build)

Capture tab, **Camera check**: tap Start and walk around the room. Tracking should reach Normal, the frame rate about 60/s, candidates about 5/s while walking and none while standing still, and mesh anchors should grow. Then, for spike criterion 5 (part of it):

1. Take a screenshot while the camera runs. The warning appears; in Photos the camera area should be black. Delete the screenshot, then delete it again from Recently Deleted. Never share it.
2. Swipe up to the app switcher while the camera runs: the app's card should show "Camera hidden", not the camera.
3. Start a screen recording from Control Center: the cover should come on while recording.

These are desk checks: nothing is written, and the session stops when you leave the tab.
