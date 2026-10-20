# 0007: Expo mapper app with one Swift capture module

Status: accepted · 2026-10-12 · amended 2026-10-15, 2026-10-17

## Decision

The mapper app (`apps/mapper`) is an Expo app in TypeScript: SDK 57 now, SDK 58 once it is stable, with the New Architecture, expo-dev-client and Expo Router. Everything that must be native lives in one local Expo module written in Swift, `apps/mapper/modules/capture-native`, built on the stable Expo Modules API. Expo Modules 2.0 is still in beta and is not used.

### The native boundary

Nothing that runs per frame crosses into JavaScript: no images, no depth, no mesh, no per-frame poses. JavaScript holds a session handle and receives status events at about 5 Hz, plus compact results: file paths, summary JSON, and floor triangles as a zero-copy `ArrayBuffer` wrapped as a `Float32Array` in JS.

| Swift owns | TypeScript owns |
| --- | --- |
| The ARSession (`sceneReconstruction = .meshWithClassification`, `frameSemantics = .smoothedSceneDepth`) and the RealityKit `ARView` view component. The session starts at `start`, never when the view mounts | All UI and navigation, and the anchor and tag flows |
| The candidate gate, in every capture: keyframes are chosen only from candidates, and `markAnchor` and `addTag` always force one ([0010](0010-capture-recording-and-replay.md)) | `manifest.json`, `anchors.json` and `tags.json`, typed from `packages/contracts` |
| Keyframe selection: copy the pixel buffer and release the `ARFrame` at once (held frames starve the camera's buffer pool); skip keyframes under backpressure | Drift calculation from the anchor transforms the module returns |
| One `writeBlurredJPEG` choke point for every keyframe and recorded candidate, which also records the blur boxes (`privacy/blur.jsonl`) and accepts only a `BlurredImage` | Floor-plan preview with `packages/floorplan` |
| 16-bit depth PNG, confidence PNG, binary PLY with per-face classification, pose and IMU writers, keyframe transforms re-read at session end (`refined_keyframes.jsonl`) | Coverage grid |
| Floor-triangle export | Draft store (expo-sqlite) |
| `packBundle` | Route tests against the draft |
| `blurPhoto(src, dst)` for photos taken outside a capture, such as status-evidence photos (anchor photos are keyframes); the unblurred source is deleted at once | Upload orchestration |
| `privacySelfTest()` | The map |
| The cover over the camera view before iOS takes its app-switcher snapshot ([0005](0005-privacy-by-design.md)) | The `CaptureNative` interface, with a fake that plays recorded boundary traces ([0010](0010-capture-recording-and-replay.md)) |
| Compiled into development and walk builds only, and run only in the walk build: the session recorder, which writes every recording file and packs exports ([0010](0010-capture-recording-and-replay.md)) | The boundary trace of what JavaScript received, handed to the module to write |

The floor-plan preview is TypeScript so it can be unit-tested on Windows against recorded bundles. `packages/floorplan` builds an occupancy grid of about 10 cm, applies a morphological close, traces it with marching squares, simplifies, and emits GeoJSON. Hermes has no WebAssembly, so it is pure JS. If the on-phone benchmark exceeds about 2 s, only the rasterise step moves into Swift, behind the same signature.

### Module API sketch

- `getCapabilities()`
- `<CaptureView>`, which renders the `CaptureSession` its `session` prop names. The session, not the view, emits the events: `status` at about 5 Hz (tracking among them), `warning`, `recording` and `stopped` (amended 2026-10-21 by [the lean recorder design](../reviews/2026-10-21-lean-recorder-design.md), D4 and D20)
- A `CaptureSession` shared object with `start`, `markAnchor`, `addTag`, `stop`, `floorTriangles`, `poseTrack` and `discard`. `floorTriangles` and `poseTrack` return compact results after the fact; they never stream per frame. In development and walk builds, `start({ record })` takes the recording profile (`off`, `lean`, `standard` or `dense`; the development build accepts only `off`), and `appendBoundary(lines)` takes the boundary trace from TypeScript.
- In development and walk builds: `listRecordings()`, `exportRecording(id)` (refused in the development build) and `deleteRecording(id)`
- `blurPhoto(src, dst)`
- `privacySelfTest()`
- `packBundle(dir, partBytes)`

How `markAnchor` registers anchors across sessions is chosen in the Phase 1 spike; see [0008](0008-anchors-and-georeferencing.md).

### Swift code rules

- Pure Swift goes in SwiftPM targets, tested with `swift test` on the macOS CI runner ([0010](0010-capture-recording-and-replay.md)): `CaptureCore` (events, the candidate gate, the selector, backpressure and the line writers; Foundation only, so it also builds with the Swift toolchain on Windows or WSL), `CaptureBlur` (the detectors, the blur, `BlurredImage` and `writeBlurredJPEG`) and `CaptureIO` (the depth PNG writer, mesh-history compression and the recorder's sink). None imports ARKit, UIKit or `simd`. Each target is its own Swift module in the app build too, so `internal` means the same on the phone as under `swift test`, and the module's podspec excludes `Package.swift` and `Tests/`.
- Vision blur tests run on the macOS CI runner with fixture images. The on-device `privacySelfTest()` is also required, because Vision on macOS can give different results from iOS.
- Log with `os.Logger` and a subsystem, never `print`, which does not reach the device log. Interpolated poses, fixes and times use `privacy: .private` ([0005](0005-privacy-by-design.md)).
- Keep third-party pods out of the module (CocoaPods trunk becomes read-only on 2026-12-02).
- Write the module scene-aware: no `keyWindow` or AppDelegate assumptions.
- The recorder's sources compile only under the `USG_RECORDER` compilation condition, which only the development and walk builds set.

### Screen detector

Apple Vision detects faces and people but has no screen detector. The module uses a permissively licensed Core ML model, chosen in the spike with a fixture benchmark. Candidates: Apple's MIT-licensed YOLOv3, RF-DETR N/S/M/L (Apache-2.0; its other sizes use a different licence), and D-FINE (Apache-2.0). Never Ultralytics YOLO, which is AGPL-3.0 including its weights. The chosen model and its licence are recorded in [0005](0005-privacy-by-design.md), which also holds the blur rules.

### Map

The map is maplibre-gl-js with terra-draw in an Expo DOM component (a WebView): the same renderer and style as the webapp, with polygon editing that works out of the box, and it can be developed in desktop Chrome. `@maplibre/maplibre-react-native` v11 is the fallback for read-only views; it has no polygon editing.

- The map is unmounted on the capture screen, because it competes with ARKit for GPU, memory and heat.
- Base tiles need a signal. Offline OneMap tiles need SLA's written permission ([0009](0009-hosting-and-budget.md)).

### Upload

1. Native `packBundle` packs the bundle directory as an uncompressed tar split into 16 MiB (16,777,216-byte) part files, then deletes the raw files so the bundle is not stored twice.
2. The API creates an S3 multipart upload and returns presigned part URLs.
3. While the app is in the foreground, JavaScript enqueues every part at once with expo-file-system's `File.createUploadTask` (a background session).
4. The server completes the upload using `ListParts`.

JavaScript cannot feed parts in a little at a time: it does not run while the app is suspended, and iOS rate-limits tasks started from the background. The JS task does not survive the app being killed, and there is no Wi-Fi-only flag. If uploads must be strictly Wi-Fi-only or survive termination, add a small native uploader with `allowsCellularAccess = false`. From Phase 2 the phone uploads over home Wi-Fi to the owner's PC on the LAN ([0009](0009-hosting-and-budget.md)).

### Getting data off the phone in Phase 1

There is no upload API before Phase 2, and the phone can't reach the PC on the LAN (the PC's Wi-Fi has the Public profile), so bundles and recordings reach the PC over USB ([0010](0010-capture-recording-and-replay.md)). `exportRecording` packs a session's replay set into parts in `Documents/exports/`, which `UIFileSharingEnabled` exposes in development and walk builds only. Only `exports/` lives under Documents in those builds: the draft store and any other app data go under `Library/Application Support`. `pnpm rec pull` copies the listed parts with pymobiledevice3's house_arrest `VendDocuments`, which works with development-signed and ad hoc builds, verifies every SHA-256, and removes them from the phone. The Apple Devices app on Windows is the manual fallback.

### Builds

| Build (EAS profile) | JavaScript | Used for |
| --- | --- | --- |
| `development` | Metro on Windows, through `pnpm dev:phone`'s tunnel (its development-build mode) | Native and UI work at a desk, with Fast Refresh. Its captures are desk checks: no GNSS, never exported or uploaded, deleted on the phone ([0010](0010-capture-recording-and-replay.md)) |
| `walk` | Embedded: the same capture module in release configuration, without the dev client, EAS internal distribution, never TestFlight or the App Store | Every capture in a venue: no Metro, no tunnel, no signal needed ([0010](0010-capture-recording-and-replay.md)) |

Both set `USG_RECORDER=1`, which compiles the recorder in and adds the Info.plist keys only these builds have (`UIFileSharingEnabled`, `NSMotionUsageDescription`) through a config plugin. Contributor builds (Phase 4) leave all of it out; a CI check inspects a build without the switch for recorder symbols and those keys, and that no build declares microphone use. A build without the switch deletes any recordings, world maps and exports it finds at launch, since installing it over a walk build keeps the app's data. `apps/mapper` keeps an allow-list of native dependencies, which refuses packages that write images, snapshot views or write to the Photos library ([0010](0010-capture-recording-and-replay.md)).

### Build, test and debug without a Mac

| Change | Loop |
| --- | --- |
| TypeScript | Dev client on the phone with Fast Refresh, Metro on Windows-native Node, through `pnpm dev:phone`'s tunnel. Desk testing only. Metro inside WSL needs mirrored networking or `--tunnel`. |
| Swift | A cloud build per change: `eas build --local` on a GitHub macOS runner (free for the public repo) by default for iterations, and EAS Build (Free plan to start; Starter only if the native loop becomes the bottleneck) for the spike's planned builds. Xcode Cloud is an option; its first workflow has to be created in Xcode, so it needs a rented-Mac day. |
| A venue walk | A walk build of the current code. A JavaScript change needs a new walk build. |
| CI gate | GitHub Actions macOS job: `expo prebuild`, an unsigned `xcodebuild build`, then `swift test` for the SwiftPM targets with fixture images, the negative compile test and the encoder check on the compiled objects (their symbols and Objective-C selectors). macOS runners are free for the public repo. |

Debugging native code without a Mac:

- An in-app log ring buffer and a debug screen showing tracking state, keyframe processing time, memory, thermal state, dropped frames and free disk, plus, while recording, MB/min per stream, dropped candidates and the degradation step.
- `pymobiledevice3` on Windows for the device syslog and `crash pull`.
- EAS Observe or Sentry for native crashes. Check that dSYM symbolication works. Whichever is chosen attaches no screenshots or view hierarchies and carries no poses, GNSS or recording values ([0005](0005-privacy-by-design.md)).

Distribution: through Phase 3 the owner is the only mapper, so development builds, walk builds (both internal distribution) and internal TestFlight are enough. Both builds need the phone's UDID registered with `eas device:create` and Developer Mode turned on. External TestFlight arrives with contributors in Phase 4 and needs Beta App Review of the first build.

Device and accounts:

- The capture device is an iPhone 17 Pro Max. Keep iOS current but avoid iOS 26.4–26.6.0, which had a reported LiDAR world-tracking drift regression. Every segment records `os_version` and `device_model`.
- The owner joins the Apple Developer Program (US$99/yr) now, before the spike's first build (amended 2026-10-17: every build needs it, and enrolment can take days). The free Expo account comes first (amended 2026-10-15): since 2026-09-03 Expo Go on iOS opens a project only when Expo CLI and Expo Go are signed in to the same account, and the mapper shell runs in Expo Go until the first development build.

### Escape hatch

If blind native debugging blocks progress, rent a cloud Mac for occasional Xcode, Simulator or Instruments days. A cloud Mac cannot practically debug the physical phone, because pairing needs USB. If blind native debugging costs more than about a day a week, reconsider a used Mac mini. Only the Swift module would need a Mac workflow; the TypeScript app stands either way.

### Phase 1 spike (1–2 weeks)

The spike passes when all of these hold (1, 2, 3, 5 and 6 amended 2026-10-17):

1. The native build-to-device loop time is measured: queue, build and reinstall.
2. ARKit + Vision + JPEG throughput holds the target candidate and keyframe rates over a sustained session of the planned length (at least 15 minutes, indoors and on a street leg), with record mode off, `lean` and `standard`, without dropped frames or thermal throttling. The time to `.fair` and `.serious`, blur time per candidate and MB/min per stream are recorded.
3. Memory use is measured going from capture to the draft map and back to capture, and its growth over a long session.
4. Floor-plan preview latency in Hermes is measured.
5. The on-device privacy self-test passes, including a failing detector; the snapshot iOS takes when the app is backgrounded mid-capture shows only the cover; and a screenshot taken mid-capture shows no camera content.
6. The anchor-registration approach works on a real door on the corridor.

The target keyframe rate is not fixed yet; the spike sets it, with the candidate rate, the default recording profile and the recording limits ([0010](0010-capture-recording-and-replay.md)).

## Why

- The owner develops on Windows with no Mac. In Expo, TypeScript changes reach the phone in seconds; only Swift changes need a cloud build.
- No maintained React Native library exposes ARKit LiDAR scene reconstruction together with depth and pose export, and only one ARSession can own the camera, so the capture code has to be written in Swift anyway. Keeping it to one module keeps the slow loop small: roughly 2.5–3.5k lines of Swift (most of the mapper's risk) against 6–9k lines of TypeScript.
- Keeping frames in Swift avoids moving images and depth across the bridge at frame rate, and gives unblurred pixels exactly one path to disk, through `writeBlurredJPEG`.
- The TypeScript side shares code with the webapp and the server: `packages/routing`, `packages/map-style`, `packages/floorplan` and `packages/contracts` ([0006](0006-typescript-backend.md)).
- A walk build with its JavaScript embedded keeps Metro and the tunnel out of every venue walk, and works without signal underground. A Documents export over USB is the one way off the phone that works with these builds on Windows without a LAN.

## Consequences

- The Swift module is the riskiest code and is written mostly blind. The spike exists to find out early whether that works.
- Every Swift change costs a cloud build: on EAS about 10–20 minutes plus queue time and a reinstall, and the Free plan allows 15 iOS builds a month at low priority, with peak queues over 90 minutes and one macOS build at a time (figures as of 2026-10-17). Native changes are batched, logic goes to TypeScript where it can, and iterations use `eas build --local` on a GitHub macOS runner.
- The recorder and mesh history add about 1–1.5k lines of Swift; in-app replay would add about 0.5k and is built only when it is needed ([0010](0010-capture-recording-and-replay.md)).
- A bundle format change follows a fixed order: `docs/capture-bundle.md` first, then `packages/contracts`, then the Swift module and the validator, and `schema_version` is bumped. A recording format change follows the same order from `docs/session-recording.md`, and bumps `recording_version`.
- Any change to the module's image code must keep the blur tests in CI passing, and adds a test where an image path changes ([0005](0005-privacy-by-design.md)).
- Platform dates to watch: an Xcode 27 / iOS 27 SDK upload requirement is expected around April 2027.
- `pymobiledevice3` is a Python tool. It runs only on the owner's PC as developer tooling and never in a system, so it counts as offline tooling under [0006](0006-typescript-backend.md). `pnpm rec pull` runs it pinned, with hashes, in an isolated venv.

## Alternatives considered

- **Pure Swift without a Mac.** Every UI change becomes a cloud build, and no code is shared with the webapp or the server.
- **Flutter + Codemagic.** Needs the same Swift module, shares no TypeScript, and has no official hot reload to an iPhone from Windows.
- **Unity AR Foundation.** Unity Personal excludes non-game apps, so it would need Unity Pro at US$210 a month, and there is no MapLibre.
- **ViroReact and other React Native AR libraries.** ViroReact is a rendering engine and records unblurred video. react-native-arkit has been unmaintained for years. Newer packages such as `expo-ar` and `munim-xr` are single-maintainer and cannot read raw frames. None can share the camera with custom capture code.
- **xtool** (builds iOS apps on Linux or Windows). Rejected over Xcode licence problems.
- **`@maplibre/maplibre-react-native` as the main map.** No polygon editing; kept for read-only views.
- **Venue walks on the development build.** One build fewer, but its JavaScript comes from Metro through the tunnel, where TLS ends at ngrok, and it needs a signal underground ([0010](0010-capture-recording-and-replay.md)).
