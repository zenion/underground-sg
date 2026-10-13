# 0007: Expo mapper app with one Swift capture module

Status: accepted · 2026-10-12

## Decision

The mapper app (`apps/mapper`) is an Expo app in TypeScript: SDK 57 now, SDK 58 once it is stable, with the New Architecture, expo-dev-client and Expo Router. Everything that must be native lives in one local Expo module written in Swift, `apps/mapper/modules/capture-native`, built on the stable Expo Modules API. Expo Modules 2.0 is still in beta and is not used.

### The native boundary

Nothing that runs per frame crosses into JavaScript: no images, no depth, no mesh, no per-frame poses. JavaScript holds a session handle and receives status events at about 5 Hz, plus compact results: file paths, summary JSON, and floor triangles as a zero-copy `ArrayBuffer` wrapped as a `Float32Array` in JS.

| Swift owns | TypeScript owns |
| --- | --- |
| The ARSession (`sceneReconstruction = .meshWithClassification`, `frameSemantics = .smoothedSceneDepth`) and the RealityKit `ARView` view component | All UI and navigation, and the anchor and tag flows |
| Keyframe selection: copy the pixel buffer and release the `ARFrame` at once (held frames starve the camera's buffer pool); skip keyframes under backpressure | `manifest.json`, `anchors.json` and `tags.json`, typed from `packages/contracts` |
| One `writeBlurredJPEG` choke point for every keyframe, which also records the blur boxes (`privacy/blur.jsonl`) | Drift calculation from the anchor transforms the module returns |
| 16-bit depth PNG, confidence PNG, binary PLY with per-face classification, pose and IMU writers, keyframe transforms re-read at session end (`refined_keyframes.jsonl`) | Floor-plan preview with `packages/floorplan` |
| Floor-triangle export | Coverage grid |
| `packBundle` | Draft store (expo-sqlite) |
| `blurPhoto(src, dst)` for photos taken outside a capture, such as status-evidence photos (anchor photos are keyframes); the unblurred source is deleted at once | Route tests against the draft |
| `privacySelfTest()` | Upload orchestration |
| | The map |

The floor-plan preview is TypeScript so it can be unit-tested on Windows against recorded bundles. `packages/floorplan` builds an occupancy grid of about 10 cm, applies a morphological close, traces it with marching squares, simplifies, and emits GeoJSON. Hermes has no WebAssembly, so it is pure JS. If the on-phone benchmark exceeds about 2 s, only the rasterise step moves into Swift, behind the same signature.

### Module API sketch

- `getCapabilities()`
- `<CaptureView>`, with `onStatus`, `onTrackingChange` and `onWarning` events
- A `CaptureSession` shared object with `start`, `markAnchor`, `addTag`, `stop`, `floorTriangles`, `poseTrack` and `discard`. `floorTriangles` and `poseTrack` return compact results after the fact; they never stream per frame.
- `blurPhoto(src, dst)`
- `privacySelfTest()`
- `packBundle(dir, partBytes)`

How `markAnchor` registers anchors across sessions is chosen in the Phase 1 spike; see [0008](0008-anchors-and-georeferencing.md).

### Swift code rules

- Pure-maths Swift goes in SwiftPM targets with no ARKit, UIKit or `import simd`, so it can be tested with `swift test` on the macOS CI runner and with the Swift toolchain on Windows or WSL.
- Vision blur tests run on the macOS CI runner with fixture images. The on-device `privacySelfTest()` is also required, because Vision on macOS can give different results from iOS.
- Log with `os.Logger` and a subsystem, never `print`, which does not reach the device log.
- Keep third-party pods out of the module (CocoaPods trunk becomes read-only on 2026-12-02).
- Write the module scene-aware: no `keyWindow` or AppDelegate assumptions.

### Screen detector

Apple Vision detects faces and people but has no screen detector. The module uses a permissively licensed Core ML model, chosen in the spike with a fixture benchmark. Candidates: Apple's MIT-licensed YOLOv3, RF-DETR N/S/M/L (Apache-2.0; its other sizes use a different licence), and D-FINE (Apache-2.0). Never Ultralytics YOLO, which is AGPL-3.0 including its weights. The chosen model and its licence are recorded in [0005](0005-privacy-by-design.md), which also holds the blur rules.

### Map

The map is maplibre-gl-js with terra-draw in an Expo DOM component (a WebView): the same renderer and style as the webapp, with polygon editing that works out of the box, and it can be developed in desktop Chrome. `@maplibre/maplibre-react-native` v11 is the fallback for read-only views; it has no polygon editing.

- The map is unmounted on the capture screen, because it competes with ARKit for GPU, memory and heat.
- Base tiles need a signal. Offline OneMap tiles need SLA's written permission ([0009](0009-hosting-and-budget.md)).

### Upload

1. Native `packBundle` packs the bundle directory as an uncompressed tar split into 16 MB part files, then deletes the raw files so the bundle is not stored twice.
2. The API creates an S3 multipart upload and returns presigned part URLs.
3. While the app is in the foreground, JavaScript enqueues every part at once with expo-file-system's `File.createUploadTask` (a background session).
4. The server completes the upload using `ListParts`.

JavaScript cannot feed parts in a little at a time: it does not run while the app is suspended, and iOS rate-limits tasks started from the background. The JS task does not survive the app being killed, and there is no Wi-Fi-only flag. If uploads must be strictly Wi-Fi-only or survive termination, add a small native uploader with `allowsCellularAccess = false`. Through Phase 3 the phone uploads over home Wi-Fi to the owner's PC on the LAN ([0009](0009-hosting-and-budget.md)).

### Build, test and debug without a Mac

| Change | Loop |
| --- | --- |
| TypeScript | Dev client on the phone with Fast Refresh, Metro on Windows-native Node. Metro inside WSL needs mirrored networking or `--tunnel`. |
| Swift | A cloud build per change: EAS Build (Free plan to start; Starter only if the native loop becomes the bottleneck) and/or `eas build --local` on a GitHub macOS runner. Xcode Cloud is an option; its first workflow has to be created in Xcode, so it needs a rented-Mac day. |
| CI gate | GitHub Actions macOS job: `expo prebuild`, an unsigned `xcodebuild build`, then `swift test` for the SwiftPM targets with fixture images. macOS runners are free for the public repo. |

Debugging native code without a Mac:

- An in-app log ring buffer and a debug screen showing tracking state, keyframe processing time, memory, thermal state, dropped frames and free disk.
- `pymobiledevice3` on Windows for the device syslog and `crash pull`.
- EAS Observe or Sentry for native crashes. Check that dSYM symbolication works.

Distribution: through Phase 3 the owner is the only mapper, so development builds and internal TestFlight are enough. Development builds need the phone's UDID registered with `eas device:create` and Developer Mode turned on. External TestFlight arrives with contributors in Phase 4 and needs Beta App Review of the first build.

Device and accounts:

- The capture device is an iPhone 17 Pro Max. Keep iOS current but avoid iOS 26.4–26.6.0, which had a reported LiDAR world-tracking drift regression. Every segment records `os_version` and `device_model`.
- The owner creates the Apple Developer Program membership (US$99/yr) and an Expo account when the Swift spike starts.

### Escape hatch

If blind native debugging blocks progress, rent a cloud Mac for occasional Xcode, Simulator or Instruments days. A cloud Mac cannot practically debug the physical phone, because pairing needs USB. If blind native debugging costs more than about a day a week, reconsider a used Mac mini. Only the Swift module would need a Mac workflow; the TypeScript app stands either way.

### Phase 1 spike (1–2 weeks)

The spike passes when all of these hold:

1. The native build-to-device loop time is measured.
2. ARKit + Vision + JPEG throughput holds the target keyframe rate over a 3-minute walk without dropped frames or thermal throttling.
3. Memory use is measured going from capture to the draft map and back to capture.
4. Floor-plan preview latency in Hermes is measured.
5. The on-device privacy self-test passes.
6. The anchor-registration approach works on a real door.

The target keyframe rate is not fixed yet; the spike sets it.

## Why

- The owner develops on Windows with no Mac. In Expo, TypeScript changes reach the phone in seconds; only Swift changes need a cloud build.
- No maintained React Native library exposes ARKit LiDAR scene reconstruction together with depth and pose export, and only one ARSession can own the camera, so the capture code has to be written in Swift anyway. Keeping it to one module keeps the slow loop small: roughly 2.5–3.5k lines of Swift (most of the mapper's risk) against 6–9k lines of TypeScript.
- Keeping frames in Swift avoids moving images and depth across the bridge at frame rate, and gives unblurred pixels exactly one path to disk, through `writeBlurredJPEG`.
- The TypeScript side shares code with the webapp and the server: `packages/routing`, `packages/map-style`, `packages/floorplan` and `packages/contracts` ([0006](0006-typescript-backend.md)).

## Consequences

- The Swift module is the riskiest code and is written mostly blind. The spike exists to find out early whether that works.
- Every Swift change costs a cloud build: on EAS about 10–20 minutes plus queue time and a reinstall, and the Free plan allows 15 iOS builds a month (figures as of 2026-10-12). Native changes are batched, and logic goes to TypeScript where it can.
- A bundle format change follows a fixed order: `docs/capture-bundle.md` first, then `packages/contracts`, then the Swift module and the validator, and `schema_version` is bumped.
- Any change to the module's image code must keep the blur tests in CI passing, and adds a test where an image path changes ([0005](0005-privacy-by-design.md)).
- Platform dates to watch: an Xcode 27 / iOS 27 SDK upload requirement is expected around April 2027.
- `pymobiledevice3` is a Python tool. It runs only on the owner's PC as developer tooling and never in a system, so it counts as offline tooling under [0006](0006-typescript-backend.md).

## Alternatives considered

- **Pure Swift without a Mac.** Every UI change becomes a cloud build, and no code is shared with the webapp or the server.
- **Flutter + Codemagic.** Needs the same Swift module, shares no TypeScript, and has no official hot reload to an iPhone from Windows.
- **Unity AR Foundation.** Unity Personal excludes non-game apps, so it would need Unity Pro at US$210 a month, and there is no MapLibre.
- **ViroReact and other React Native AR libraries.** ViroReact is a rendering engine and records unblurred video. react-native-arkit has been unmaintained for years. Newer packages such as `expo-ar` and `munim-xr` are single-maintainer and cannot read raw frames. None can share the camera with custom capture code.
- **xtool** (builds iOS apps on Linux or Windows). Rejected over Xcode licence problems.
- **`@maplibre/maplibre-react-native` as the main map.** No polygon editing; kept for read-only views.
