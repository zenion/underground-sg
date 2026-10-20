# capture-native

The mapper app's one native module ([ADR 0007](../../../../docs/decisions/0007-expo-mapper-app.md)): a local Expo module in Swift on the stable Expo Modules API. It runs only in development and walk builds; in Expo Go and on the web its exports are null.

## What it does so far

- `getCapabilities()`: ARKit's own checks (world tracking, LiDAR scene reconstruction with classification, scene depth, video formats), the hardware model and the iOS version.
- `<CaptureView>`: the camera with RealityKit's live mesh over it. The ARSession starts on `start()`, when the mapper taps Start, never when the view mounts, and stops on `stop()` or when the view leaves the window. `onStatus` at 5 Hz (tracking, world mapping, frame and candidate rates, mesh anchors, heat, whether the cover is on) and `onWarning` (screenshot, session failed, interruptions). Nothing per frame and no pose crosses into JavaScript.
- The privacy shield ([ADR 0010](../../../../docs/decisions/0010-capture-recording-and-replay.md#the-camera-view-ioss-snapshot-and-screenshots)): the camera sits inside a secure-entry text field's canvas, which iOS leaves out of screenshots and screen recordings; an opaque cover goes over it whenever the scene isn't foreground-active (so before iOS takes its app-switcher snapshot) and while the screen is recorded or mirrored; a screenshot taken during a capture raises a warning asking the owner to delete it. If this iOS has no secure canvas, `start()` refuses.
- Every frame goes through `CaptureCore`'s candidate gate, as in every capture. Nothing is written yet: no keyframes, no bundle, no recording.
- The recorder's I/O exists in `CaptureIO` but nothing in the app calls it yet (the native glue, design PR5, will): `FileSink` applies `RecorderCore`'s commands to files, `RecoveryRunner` finishes or removes what a crash left at launch, `TarExporter` writes an export's parts, and `SelfTest` runs a synthetic session through all of it. `capture-synth` runs the same code on the PC and in CI.

`src/types.ts` also types what the native glue will add (the lean recorder design, 3.3): the `CaptureSession` shared object with its events and the recorder's functions, all optional in `CaptureNativeModule` until they exist. The app reaches them only through `src/capture/native.ts`, which traces their results and wraps every pose and session time ([apps/mapper/README.md](../../README.md#the-capture-port-and-the-walk-flow)).

Still to come, in the backlog's order: the rest of `CaptureCore` (selector, backpressure, line writers), the `CaptureSession` object with `discard`, the `lean` recorder behind `USG_RECORDER`, the walk build, then the blur.

## Layout

```
expo-module.config.json   three pods: ios/CaptureNative.podspec, CaptureCore.podspec and CaptureIO.podspec
index.ts, src/types.ts    the TypeScript side: the module, the view and their types
ios/                      the Expo module (ARKit, RealityKit, UIKit): only the app build compiles it
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
- **The recorder switch.** The recorder's code is compiled only under the `USG_RECORDER` condition (ADR 0010). `Package.swift` defines it by default, so `swift test` covers the recorder; with `USG_NO_RECORDER=1` (`docker run -e USG_NO_RECORDER=1 ...`) it builds and tests without it, as a contributor build will, which CI's Linux job checks with `swift build`. What is gated: `RecorderWindow`, `MeshHistorySchedule`, `DegradationLadder` and everything in `Recording/` except `JsonText`, `MeshBlockLayout`, `MeshFingerprint`, `TarLayout` and `PartPlan`, which bundles will use too; in CaptureIO, everything but DurableFile, Sha256Stream, Deflate, AtomicJsonWriter, FileSecurity and TarParts. `capture-synth` built without it only says so and exits with 2. The pods don't define it yet: the config plugin that sets it for the development and walk builds comes later, so the app build compiles CaptureCore without the recorder until then.
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
- **The macOS CI job** (`iOS native (macOS)` in `.github/workflows/ci.yml`): `swift test`, `capture-synth` (plain, interrupted and with two parts) checked by `validate-recording` as directories and as parts, the generated Swift types, the encoder check's self-test, `expo prebuild`, `pod install`, an unsigned Debug build of the whole app, then the encoder check on this module's compiled objects.
- **The encoder check** (`apps/mapper/scripts/encoder-check.mts`, rules in `encoder-check-lib.mts`, tested in `test/encoder-check.test.ts`) reads each object file's undefined symbols (raw and demangled) and its Objective-C selectors, and fails on image and video encoders, raw pixel access, view snapshots and Photos writes outside `encoder-allowlist.json`. Its self-test compiles each file in `ci/planted/` and expects the rule named on its first line.
- **The native-dependency allow-list** (`apps/mapper/native-dependencies.json`, `test/native-dependencies.test.ts`) asks Expo's autolinking what native code the app links and fails on anything unreviewed or refused.

## Checking it on the phone (development build)

Capture tab, **Camera check**: tap Start and walk around the room. Tracking should reach Normal, the frame rate about 60/s, candidates about 5/s while walking and none while standing still, and mesh anchors should grow. Then, for spike criterion 5 (part of it):

1. Take a screenshot while the camera runs. The warning appears; in Photos the camera area should be black. Delete the screenshot, then delete it again from Recently Deleted. Never share it.
2. Swipe up to the app switcher while the camera runs: the app's card should show "Camera hidden", not the camera.
3. Start a screen recording from Control Center: the cover should come on while recording.

These are desk checks: nothing is written, and the session stops when you leave the tab.
