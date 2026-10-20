# capture-native

The mapper app's one native module ([ADR 0007](../../../../docs/decisions/0007-expo-mapper-app.md)): a local Expo module in Swift on the stable Expo Modules API. It runs only in development and walk builds; in Expo Go and on the web its exports are null.

## What it does so far

- `getCapabilities()`: ARKit's own checks (world tracking, LiDAR scene reconstruction with classification, scene depth, video formats), the hardware model and the iOS version.
- `<CaptureView>`: the camera with RealityKit's live mesh over it. The ARSession starts on `start()`, when the mapper taps Start, never when the view mounts, and stops on `stop()` or when the view leaves the window. `onStatus` at 5 Hz (tracking, world mapping, frame and candidate rates, mesh anchors, heat, whether the cover is on) and `onWarning` (screenshot, session failed, interruptions). Nothing per frame and no pose crosses into JavaScript.
- The privacy shield ([ADR 0010](../../../../docs/decisions/0010-capture-recording-and-replay.md#the-camera-view-ioss-snapshot-and-screenshots)): the camera sits inside a secure-entry text field's canvas, which iOS leaves out of screenshots and screen recordings; an opaque cover goes over it whenever the scene isn't foreground-active (so before iOS takes its app-switcher snapshot) and while the screen is recorded or mirrored; a screenshot taken during a capture raises a warning asking the owner to delete it. If this iOS has no secure canvas, `start()` refuses.
- Every frame goes through `CaptureCore`'s candidate gate, as in every capture. Nothing is written yet: no keyframes, no bundle, no recording.

Still to come, in the backlog's order: the rest of `CaptureCore` (selector, backpressure, line writers), the `CaptureSession` object with `discard`, the `lean` recorder behind `USG_RECORDER`, the walk build, then the blur.

## Layout

```
expo-module.config.json   two pods: ios/CaptureNative.podspec and CaptureCore.podspec
index.ts, src/types.ts    the TypeScript side: the module, the view and their types
ios/                      the Expo module (ARKit, RealityKit, UIKit): only the app build compiles it
Package.swift             SwiftPM, for `swift test`; the podspecs exclude it and Tests/
CaptureCore.podspec       CaptureCore as its own pod, so it is its own Swift module in the app too
Sources/CaptureCore/      Foundation only: WorldTransform, CandidateGate, RateMeter; the recorder's pure logic
                          (LineEncoder, RecorderWindow, GnssWindows, AnchorSampler, MeshHistorySchedule,
                          DegradationLadder, StageTimer, FrameGap); and generated/Contracts.swift
                          (written by `pnpm gen` from packages/contracts; do not edit)
Tests/CaptureCoreTests/   Swift Testing, and Golden/: one file per line type, byte-exact (UPDATE_GOLDENS=1 rewrites them)
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
- **The macOS CI job** (`iOS native (macOS)` in `.github/workflows/ci.yml`): `swift test`, the generated Swift types, the encoder check's self-test, `expo prebuild`, `pod install`, an unsigned Debug build of the whole app, then the encoder check on this module's compiled objects.
- **The encoder check** (`apps/mapper/scripts/encoder-check.mts`, rules in `encoder-check-lib.mts`, tested in `test/encoder-check.test.ts`) reads each object file's undefined symbols (raw and demangled) and its Objective-C selectors, and fails on image and video encoders, raw pixel access, view snapshots and Photos writes outside `encoder-allowlist.json`. Its self-test compiles each file in `ci/planted/` and expects the rule named on its first line.
- **The native-dependency allow-list** (`apps/mapper/native-dependencies.json`, `test/native-dependencies.test.ts`) asks Expo's autolinking what native code the app links and fails on anything unreviewed or refused.

## Checking it on the phone (development build)

Capture tab, **Camera check**: tap Start and walk around the room. Tracking should reach Normal, the frame rate about 60/s, candidates about 5/s while walking and none while standing still, and mesh anchors should grow. Then, for spike criterion 5 (part of it):

1. Take a screenshot while the camera runs. The warning appears; in Photos the camera area should be black. Delete the screenshot, then delete it again from Recently Deleted. Never share it.
2. Swipe up to the app switcher while the camera runs: the app's card should show "Camera hidden", not the camera.
3. Start a screen recording from Control Center: the cover should come on while recording.

These are desk checks: nothing is written, and the session stops when you leave the tab.
