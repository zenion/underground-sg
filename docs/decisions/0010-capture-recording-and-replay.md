# 0010: Capture recording and replay

Status: accepted · 2026-10-17

## Decision

Walk a route once, then replay it as often as the software changes. The mapper app's walk build, which only the owner uses, can record a capture session: the session writes its capture bundles as usual, plus a private **session recording** of what the bundles leave out. Everything downstream of ARKit can then be re-run from the recording without walking, and most of it without the phone or a cloud build. The format is recording v1: [session-recording.md](../session-recording.md). The corridor these walks cover is the MVP's scope ([0011](0011-mvp-scope-esplanade-corridor.md)).

### Scope and defaults

- The capture bundle doesn't change. The phone writes it exactly as [capture-bundle.md](../capture-bundle.md) says (`schema_version` 1), with or without a recording. Ingest and processing only ever see bundles: a recording is never uploaded to ingest, and nothing on a publish path depends on one.
- The recorder is compiled only into the `development` and `walk` builds (below). It is a build-time switch, not a runtime option alone, so it is absent from the binary of every other build, contributor builds included. Contributors (Phase 4) never get it without a new decision and their consent.
- Only the walk build records. There the recorder is off by default and chosen per session, `CaptureSession.start({ record: 'off' | 'lean' | 'standard' | 'dense' })`, with a recording indicator on screen while it runs. The development build compiles the same recorder but refuses any profile other than `off`.
- Recording, like any capture, needs no venue permission (owner decision, 2026-10-17; [spec](../spec.md#privacy-and-legal)). The privacy rules below, [0005](0005-privacy-by-design.md) and the public-walkways-only rule apply in full.

### Builds

| Build (EAS profile) | JavaScript | Recorder | Used for |
| --- | --- | --- | --- |
| `development` | From Metro, through `pnpm dev:phone`'s tunnel ([0009](0009-hosting-and-budget.md#remote-access-during-phases-13)) | Compiled in, but refuses any profile other than `off`: its JavaScript comes from a dev server | Native and UI work at a desk, and desk checks of capture (below) |
| `walk` | Embedded: release configuration, EAS internal distribution, never TestFlight or the App Store | Compiled in, and records | Every capture in a venue, recorded or not |
| Contributor builds (Phase 4) | Embedded | Not compiled | Contributors |

- The `development` and `walk` profiles set `USG_RECORDER=1` in `eas.json`. A config plugin turns it into the Swift compilation condition `USG_RECORDER` and into the Info.plist keys only these builds have (`UIFileSharingEnabled` for the export, `NSMotionUsageDescription` for the altimeter). Without it, the recorder's sources aren't compiled. Both profiles compile it, so the walk build runs the same capture module as the development build, in release configuration and without the dev client.
- `CaptureSession.start` refuses a profile other than `off` unless the JavaScript bundle is embedded in the app.
- A walk needs no Metro, no tunnel and no signal underground. Nothing connects to a dev server, so no console output, LogBox error or trace leaves the phone that way. A JavaScript change reaches the walk build only with a new build.
- Recordings and anything pose-bearing (poses, transforms, floor triangles, GNSS fixes, boundary traces) never pass through Metro or any TLS-terminating tunnel. In the development build, JavaScript never logs or throws such values (the logging rules below), so none reach Metro.
- **Desk checks.** The development build is used wherever the owner sits, often at home, so its captures count as home data. It never starts Core Location (gated like `record`), so it writes no GNSS. It refuses `exportRecording` and never uploads, and the module deletes a desk check's files when the capture screen closes, or at the next launch for one cut off. Desk checks are not walks: they are never imported or kept as fixtures, and the rule for AI agents (below) covers them like venue data.
- **Getting the walk build onto the phone.** It is built with `eas build --local` on a GitHub macOS runner, or on EAS. Signing is EAS-managed through an `EXPO_TOKEN` repository secret, never committed. Its ad hoc profile lists the iPhone's UDID and the developer team, so the .ipa never becomes an Actions artifact of the public repo ([0009](0009-hosting-and-budget.md#builds-and-accounts)).
- **Builds without the recorder.** These builds share one bundle identifier, so installing one over another keeps the app's data. Before a build without the recorder (internal TestFlight, or a Phase 4 build) goes onto the phone, the owner exports and pulls, or deletes, every recording. As a backstop, a build without the switch deletes `Library/Application Support/recordings/`, `Library/Application Support/worldmaps/` and `Documents/exports/` at launch, with a test.

### Keyframes are a subset of candidates, in every capture

The module's candidate gate runs in every capture, with record mode on or off:

- A frame becomes a candidate when the phone has moved about 0.15 m or turned about 5° since the last candidate, up to the candidate rate (about 5 Hz).
- `markAnchor` and `addTag` always force a candidate, which becomes a keyframe, so every anchor photo and tag frame has an image.
- Keyframes are chosen only from candidates.

So the live choice can be re-run exactly from a recording, and record mode only adds the cost of keeping the non-keyframe candidates. The spike sets the thresholds and rates.

### Profiles

| Profile | The recording adds | Estimated size |
| --- | --- | --- |
| `lean` | Every frame's pose, intrinsics and tracking; IMU and device motion; relative altitude; the anchor history; the mesh history every 5 s; events; actions; telemetry; GNSS windows; the boundary trace. No images and no depth | About 6 MB/min plus the mesh history (10–50 MB/min) |
| `standard` | `lean`, plus the non-keyframe candidates through `writeBlurredJPEG`, with their depth and confidence | `lean` plus about 80 MB/min |
| `dense` | `standard`, with the mesh history every 2 s and candidates at up to 10 Hz. Sessions of at most 10 minutes | About 300 MB/min |

- `lean` needs no blur, so walks can start with it before the face, head and screen detectors pass `privacySelfTest()`. Until they do, a session writes no bundle (a bundle needs blurred keyframes), only the lean recording, and `markAnchor` and `addTag` record their results (raycast, facing, position) in it without a photo.
- Routine walks use `lean`; `standard` is for walks meant as fixtures; `dense` is for short experiments.
- The sizes are estimates. The candidate rate, the gate thresholds, the default profile and the recording limits are set in the spike from measured heat, drops and sizes, not before.

### What a recording holds

One recording per ARKit session, `rec-<recording_id>/`, kept beside that session's bundles; together they form a **replay set**. It uses the session's world frame, `t` time base ([capture-bundle.md](../capture-bundle.md#coordinate-frame-and-time-base)) and frame numbering, with each segment's frame offset in `recording.json`. Fields and encodings are in [session-recording.md](../session-recording.md).

| File | Rate | Contents and purpose |
| --- | --- | --- |
| `recording.json` | Written at start, rewritten at close | Version, `origin` (`device` or `synthetic`), profile and achieved rates, build (git commit, EAS build id, profile), device, OS, clocks at start, ARKit configuration, detector versions, the venues walked, the recording window, and the segments: each bundle's `capture_id` and manifest SHA-256, start and end `t`, frame offset. Every file with bytes and SHA-256 |
| `frames.jsonl` | Every ARFrame (60 Hz) | Pose and intrinsics (they change within a session), tracking, world mapping, exposure, light, gaps. The candidate status (keyframe, kept, or dropped and why), the pre-blur sharpness score as a number, stage timings. Selection can be re-run and diffed without decoding an image |
| `candidates/`, `depth/`, `confidence/`, `privacy/blur.jsonl` | Non-keyframe candidates (`standard`, `dense`) | Through `writeBlurredJPEG`, with the keyframes' encodings and JPEG rules. Keyframes are never stored twice: they stay in their bundle |
| `imu.jsonl`, `motion.jsonl` | 100 Hz | The bundle's IMU line, for the whole session. Device motion: attitude, gravity, user acceleration, rotation rate, calibrated magnetic field, heading |
| `altitude.jsonl` | As Core Motion delivers it | Relative altitude and pressure only, for level-change experiments |
| `anchors.jsonl` | Sampled with each mesh snapshot; everything when the recording opens and closes | Keyframe, image and mesh anchors that moved more than about 1 mm or 0.05°, and adds and removals; every anchor in the first sample and in the final one |
| `mesh/history.bin`, `mesh/history.jsonl` | Every mesh anchor when the recording opens, changed ones every 5 s (2 s in `dense`), and a final snapshot when it closes | Raw DEFLATE of each anchor's vertices, faces and classifications, with an index. Gives the mesh, the coverage and the floor triangles at any `t` |
| `events.jsonl` | On change | ARKit configuration, interruptions, relocalization, image-anchor detections, thermal and memory warnings, background and foreground, screenshots, a denied altimeter, the degradation steps |
| `actions.jsonl` | Per module call | Arguments and native results: raycast hit, normal and frame used; when the session-end reads happen |
| `telemetry.jsonl` | 1 Hz | Thermal state, memory, CPU, free disk, queue depth, blurred and dropped candidates, p50 and p95 stage timings |
| `location.jsonl` | 1 Hz, in windows | GNSS around street-facing anchors only (below) |
| `boundary.jsonl`, `boundary/<seq>.f32` | As JavaScript receives it (about 5 Hz) | Exactly what JavaScript saw, compact results included. TypeScript produces it and hands it to the module (`appendBoundary`), which writes it. It drives the TypeScript fake |

When a recording runs:

- The ARSession starts when the mapper taps Start, never when the capture screen mounts.
- The recording opens at the session's first start-anchor mark. Marking an end anchor offers **End the session here**, which closes the recording a set margin later (a few seconds; the spike sets it) and stops the session at that moment, so the session-end reads and the recording's final sample coincide. It also closes after an idle timeout (no movement for a set time), when the app goes to the background (a locked screen included) and at its limits. Once it has closed, nothing more of that session is recorded.
- A recording still open when the session closes, or found cut off at the next launch, is cut back to its last end anchor plus the margin, and the tail is deleted. Sessions start and stop at a public anchor: a station exit's street door or a venue door on the corridor.
- Location permission is "when in use". Fixes are held in an in-memory ring buffer, so a GNSS window can begin before an anchor marked mid-session, but no fix from before the recording opened is ever written. Only fixes within ±30 s of marking a street-facing anchor, inside the recording's window and within about 50 m of that anchor's first fix are written.

Never recorded:

- raw `capturedImage` or video, or anything from a second image encoder;
- Vision observations beyond the padded boxes;
- `ARWorldMap` or `rawFeaturePoints`: feature points can be inverted into images, so keeping a world map at all is decided with registration in [0008](0008-anchors-and-georeferencing.md);
- absolute altitude, or continuous GNSS;
- Wi-Fi, Bluetooth or audio.

**World maps and reference images in the spike.** The registration experiment archives `ARWorldMap`s to relocalize later sessions. They stay on the phone: in `Library/Application Support/worldmaps/`, `NSFileProtectionComplete` and excluded from backup. They are never exported or pulled, and they are deleted when the experiment ends, until [0008](0008-anchors-and-georeferencing.md) decides. An image anchor's reference image is cropped only from a `BlurredImage` (a crop is still one) and stored only through `writeBlurredJPEG`.

**Degradation.** Under heat or low disk the recorder steps down in a fixed order, recording each step as an event: first fewer extra candidates, then no mesh history, then no recording. The candidate gate, poses, IMU, the bundle's keyframes and the blur detectors are never changed for the recording's sake.

### One image path, enforced by the compiler

- Unblurred pixels reach disk only through `writeBlurredJPEG`, for keyframes and candidates alike. Its only input is a `BlurredImage`, defined in its own SwiftPM target (`CaptureBlur`). Its initialiser is not even internal: it is `fileprivate`, in the blur's own file, so neither the rest of the target nor a `@testable import` can make one. The target is its own Swift module in the app build too (a podspec of its own, or a Swift package the module links), built without testability (`ENABLE_TESTABILITY = NO`). A negative compile test in the macOS CI job, code outside the blur's file that constructs a `BlurredImage`, directly and through `@testable import CaptureBlur`, must fail to compile both under SwiftPM and in the app build.
- **The blur fails closed.** A `BlurredImage` exists only after every detector (face, person_head, screen) ran successfully on that exact frame, at the resolution the spike fixes. A detector error, a timeout or a model not yet loaded drops the frame: it is never written, and `frames.jsonl` says why. A keyframe forced by `markAnchor` or `addTag` that can't be blurred fails the call, and the app asks again. Boxes are never reused or carried over between frames.
- **The encoder check runs on compiled code**, not on names in the source. From the module skeleton's first build, the macOS CI job inspects every object file the module compiles. It fails if one outside the allowed places references an image or video encoder, a write to the Photos library or raw pixel access. It reads two things, because Swift calls an Objective-C method through `objc_msgSend` and leaves only the selector's name in the object:
  - undefined symbols, Objective-C class references (`_OBJC_CLASS_$_…`) included: `CGImageDestination*`; `UIImageJPEGRepresentation` and `UIImagePNGRepresentation` (Swift's `jpegData` and `pngData`); `UIGraphicsImageRenderer`; `AVAssetWriter`; `VTCompressionSession*`; `CVPixelBufferGetBaseAddress` and `CVPixelBufferGetBaseAddressOfPlane`; `CGDataProviderCopyData`; `CGBitmapContextGetData`; `vImage*`; `PHPhotoLibrary`, `PHAssetCreationRequest`, `UIImageWriteToSavedPhotosAlbum` and `UISaveVideoAtPathToSavedPhotosAlbum`; and the dispatch thunk of `ARView.snapshot`;
  - Objective-C selector references: the `objc_msgSend$<selector>` stubs that Xcode 26's Swift calls Objective-C methods through, which are undefined symbols (its objects then have no `__objc_methname` section, found 2026-10-20), and the `__objc_methname` strings of an object compiled without stubs: `CIContext`'s writers (`JPEGRepresentationOfImage:colorSpace:options:`, `PNGRepresentationOfImage:format:colorSpace:options:`, `HEIFRepresentationOfImage:format:colorSpace:options:` and the `write…RepresentationOfImage:…` selectors) and its `render:toBitmap:…`, and `MTLTexture`'s `getBytes:…`.

  The allowed places are `CaptureBlur`; the depth and confidence PNG writer, whose inputs (`DepthMap`, `ConfidenceMap`) are built only from `ARDepthData`'s Float32 and UInt8 buffers and refuse any other pixel format; and the frame copy in `ARKitSource`, which copies into memory and writes nothing. Each joins the allow-list when it lands, so the first walk build, `lean`, is checked against an empty one. A planted call of each kind, a listed symbol and a `CIContext` writer, fails the check.
- **Native dependencies.** The encoder check covers the module. The app's other native code comes from npm packages, so `apps/mapper` keeps an allow-list of its native dependencies, checked by a test over `package.json` and the autolinked modules. A package that writes images, snapshots views or writes to the Photos library (expo-media-library, react-native-view-shot or expo-image-manipulator, for example) is refused unless this ADR is amended.
- The recorder's candidate sink takes only `BlurredImage` values and plain value types. Each recorded candidate has its own `privacy/blur.jsonl` line and follows the keyframe JPEG rules (3-component, no thumbnail, no MPF segment); `validate-recording` checks this.
- A recorder blur test on the macOS runner sends the [0005](0005-privacy-by-design.md) fixture images through the recorder path and checks that they come out blurred, and that a failing detector writes nothing.
- `listRecordings` shows no thumbnails, or only one made from an already blurred candidate.
- Derivation on the PC copies image bytes and never decodes or re-encodes them.

### The camera view, iOS's snapshot and screenshots

This holds for every capture, recorded or not.

- **The app-switcher snapshot.** When an app leaves the foreground, iOS saves a snapshot of its screen inside the app's container, outside `writeBlurredJPEG`. So the module covers `<CaptureView>` with an opaque view before that happens (`sceneWillResignActive`).
- **Screenshots and screen recordings.** The side and volume buttons write the live camera view, bystanders' faces included, to the Photos library, which iCloud Photos may sync out of Singapore. Without a Mac, a screenshot is also the obvious way to report a UI bug. So:
  - the module hosts the camera layer where iOS leaves it out of screenshots and screen recordings. A known technique puts it inside the layer of a secure-entry `UITextField`, which captures render blank; Apple doesn't document it, so the device check confirms it on the iOS in use;
  - while the screen is being recorded or mirrored, the cover stays on. The module reads the scene's capture state: `UIScreen.isCaptured`, or the `sceneCaptureState` trait where that has replaced it (checked on iOS 27 in the spike);
  - a screenshot taken anyway is caught through `userDidTakeScreenshotNotification`: the module records an event (in `events.jsonl` when recording) and asks the owner on screen to delete the screenshot, from Recently Deleted too;
  - screenshots and screen recordings of the capture view are never shared with an AI agent, and debug screenshots show only screens without the camera view ([CLAUDE.md](../../CLAUDE.md), [phone-testing.md](../phone-testing.md)).
- **The device check**, part of spike criterion 5, backgrounds the app mid-capture and confirms that the snapshot iOS stored shows only the cover, and takes a screenshot mid-capture and confirms that it shows no camera content.
- The crash reporter never attaches screenshots or view hierarchies, with a test.

### Swift structure

Three SwiftPM targets, each tested with `swift test` on the macOS runner:

| Target | Holds | Imports |
| --- | --- | --- |
| `CaptureCore` | `CaptureEvent`, `CaptureSource`, the candidate gate, the keyframe selector, backpressure with an injected clock, the JSONL and binary line writers | Foundation only, so it also builds on Linux and Windows |
| `CaptureBlur` | The Vision face and person detectors, the Core ML screen model, the blur, `BlurredImage` and `writeBlurredJPEG` | Vision, Core ML, ImageIO |
| `CaptureIO` | The depth and confidence PNG writer, raw DEFLATE for the mesh history, the recorder's sink | ImageIO (PNG only), Compression |

The Expo module holds `ARKitSource` (it copies a frame's data and releases the `ARFrame` at once), the view, the snapshot cover, the screenshot handling and the bindings. Its podspec excludes `Package.swift` and `Tests/`. Only a device can test `ARKitSource`, mesh extraction, raycasts, image anchors, heat, Data Protection, the snapshot cover and the screenshot handling.

### Where replays run

| Target | How | What it lets us iterate | Native build |
| --- | --- | --- | --- |
| TypeScript fake, Vitest on Windows | A `CaptureNative` interface, implemented by the module and by a fake that plays `boundary.jsonl` on a virtual clock (×1, ×10, step) | The capture screen, anchor and tag flows, warnings, preview, coverage, drift, draft, route tests | None |
| The same fake in the web export on localhost, and in Expo Go | Venue traces load only through a file picker that works only when `location.hostname` is loopback. Expo Go gets synthetic traces from git only: Metro never reads `.data/` | The UI | None |
| Re-derivation on the PC | `deriveBundle(replaySet, segment, policy)` in `@usg/recording` (below) | Keyframe policy, segment cuts, a future bundle version, a check of the Swift writers on every walk | None |
| The server pipeline (Phase 2) | `pnpm rec pipeline <set>` sends a set's bundles through validation, the privacy re-check, trajectory clean-up, the network adjustment, extraction and the diff, against a scratch database copied from the migrated template, with the venue's restricted zones loaded from `db/private/` | Phase 2 processing | None |
| Floor plan and coverage | `pnpm test:venue` over the bundle meshes, and the mesh history at any `t` (`meshAt(t)`) | Floor-plan defaults, a height band, coverage | None |
| `CaptureCore` under `swift test` | macOS CI over synthetic replay sets, with keyframe sets from the TypeScript policy as goldens | The Swift candidate gate, selector, backpressure and writers | CI only, no signing |
| Later, only when the targets above stop being enough | In-app replay in the development build (`RecordingSource` feeding the real module and JavaScript), or `capture-replay` on WSL | Swift on the device, Hermes memory | One |

- Venue replay sets are kept in `.data/fixtures/recordings/` and run in the uncached `pnpm test:venue`, which skips when they are absent. CI runs synthetic replay sets only.
- A keyframe policy proven in TypeScript is ported to Swift in one build; the goldens, and the next walk's `recorded` check, confirm the port.

### Re-derivation

- `deriveBundle` writes v1 bundles from the recorded candidates under another keyframe policy, segment cut or later bundle version. Images are byte copies, and a candidate that hasn't been through the import re-check, or was quarantined, is refused. The tar is deterministic (fixed mtimes, sorted members). A derived bundle's `capture_id` is a UUIDv5 of the recording, the segment, the policy's SHA-256 and the deriver's major version.
- With the policy `recorded`, it rebuilds the phone's own bundle. `capture_id` and the JSON TypeScript wrote from user input (names, notes, tag kinds) come from the paired bundle, or from the boundary trace. JSON and JSONL are compared as parsed values. The module takes a final sample of every anchor and mesh anchor when the recording closes, which End the session here makes the session-end reads too ([session-recording.md](../session-recording.md#streams)), and PLY faces and classifications are compared exactly, vertices within 1e-5 m: the phone applies mesh transforms in float32 (with fused multiply-add), TypeScript in float64. Keyframe JPEGs are copies, so comparing them proves nothing.
- So `recorded` proves that the Swift writers and the deriver agree, on every walk. Correctness stays with `validate-bundle` and the synthetic goldens.
- Derived bundles never enter ingest or the real database: they are experiment and fixture data. Ingest refuses version-5 `capture_id`s. Using one on a publish path needs a new decision.

### What a replay can't do

- Re-run ARKit: tracking, reconstruction, depth smoothing, loop closures, anchor refinement, relocalization, or image-anchor detection with new reference images. Any `ARConfiguration` change needs a walk.
- Tune the blur on venue faces, which were blurred at capture. Recordings only reveal misses, through the re-check; recall is tuned on consented or open-licence fixtures and `privacySelfTest()`.
- Use pixels that weren't recorded: frames between candidates, a higher resolution, a new metric on unblurred pixels.
- Reproduce real load: heat, memory pressure, dropped frames, blur latency.
- Answer live raycasts at points never tapped, give GNSS outside the windows, or cover human factors, new anchors or changes on site.

Batch these into planned walk days.

### Storage and transfer

**On the phone**

- Recordings are written to `Library/Application Support/recordings/rec-<recording_id>/`, outside the shared Documents folder. Files are `NSFileProtectionCompleteUnlessOpen` while being written and `NSFileProtectionComplete` once closed, with `isExcludedFromBackup`. Swift writes every recording file, the boundary trace included, so all of them get the same attributes.
- In the development and walk builds, only `exports/` lives under Documents, the folder `UIFileSharingEnabled` exposes. The draft store and any other database or file the app keeps go under `Library/Application Support` (expo-sqlite's `directory` option, since its default is under Documents). A device check in the first walk build lists Documents and finds only `exports/`.
- iCloud Backup is off for the app. Local backups of the phone are encrypted ("Encrypt local backup" on in the Apple Devices app), and Apple Devices doesn't sync automatically when the phone is connected.
- The recorder refuses to start without room for twice the profile's limit.

**Export in Phase 1: Documents, over USB.** There is no upload API before Phase 2 and no LAN (the PC's Wi-Fi has the Public profile). This path works with development-signed and ad hoc (internal distribution) builds on Windows:

- `exportRecording(id)` packs a replay set (the recording plus the session's bundles, or only the bundles of an unrecorded session) as plain ustar in 16 MiB parts into `Documents/exports/replay-<recording_id>/`, with `parts.json` listing each part's bytes and SHA-256, under the same protection and backup exclusion. It deletes the raw files once the parts are written and hashed, so the phone keeps one copy. `UIFileSharingEnabled` is set only in the development and walk builds, and the development build refuses to export.
- `pnpm rec pull` runs a pinned `pymobiledevice3`, installed with hashes in an isolated venv, and copies over USB, through house_arrest's `VendDocuments` (`apps pull --documents`), only the files `parts.json` lists. It never pulls the container root, `Library/`, `Caches/`, `SplashBoard/` or `tmp/`, and refuses any file not listed. It verifies every SHA-256, then removes the parts from the phone (`apps rm --documents`).
- Until `pnpm rec pull` exists, the fallback is the Apple Devices app's file sharing on Windows. The owner saves the parts straight into `.data/holding/<recording_id>/`, never into Downloads, Documents, Desktop or any folder that OneDrive or another cloud service syncs. `pnpm rec import` then makes the same checks and refuses a source folder outside `.data/`, and the owner deletes the parts on the phone.

**Phase 2: LAN.** An owner-only upload to a private `usg-recordings` bucket, never `usg-bundles`, after the device-token and multipart tasks. Upload routes refuse requests that arrive through a tunnel.

**Never:** git, cloud CI, EAS artefacts, Metro, ngrok or any other TLS-terminating tunnel, iCloud, OneDrive or any other cloud-synced folder, AirDrop, email, Cloudflare or R2.

**On the PC**

- `.data/` is on the BitLocker drive, outside any folder OneDrive syncs, and `pnpm rec pull` refuses otherwise. Recordings are in the encrypted backups. Until the backup script exists (Phase 2), `.data/` is backed up only to the BitLocker-encrypted backup drive, never to a consumer cloud sync. Backup sets are kept at most 30 days.
- Pulls land in `.data/holding/`, which tests, derive and pipeline never read. `pnpm rec import` validates a set and runs the server's YuNet face re-check ([0005](0005-privacy-by-design.md)) over every image in it, bundle keyframes and candidates alike; a still-sharp image is deleted and listed in `import.json`. Only then does the set move to `.data/fixtures/recordings/<recording_id>/`. A `lean` set made before bundles exist has no images and imports after validation alone. Until the re-check is built (Phase 2), sets with images wait in holding.
- When ingest later quarantines a frame or fails a bundle for privacy, the fixture copies follow by `capture_id`: the files are deleted, and `import.json` records it.
- Derived output goes to `.data/replays/`; it can be regenerated and isn't backed up.

### Privacy

- A recording is personal data, at least as private as a raw bundle: a full-rate trajectory, 100 Hz motion (which can identify a walker by gait), the magnetometer, relative altitude, timestamps, GNSS windows and, in the standard profile, about 2.5 times a bundle's blurred bystander images. It follows the raw-bundle rules of [0005](0005-privacy-by-design.md): private, Singapore only, encrypted at rest. Its wall-clock times are treated as sensitive.
- Depth, confidence and the mesh history still show bystanders' outlines. Masking depth inside `person_head` boxes for non-keyframe candidates is a minimisation option, decided in the spike.
- The mesh history, and anything a replayed extraction produces, can show back-of-house geometry before clipping, so it is kept like the `restricted_zones` outlines: never in git, goldens or logs.
- **Logs and errors.** Every sink names files, lines and frames, never poses, times, fixes or boundary values:
  - CLI and validator output;
  - `os.Logger`, whose interpolated poses, fixes and times use `privacy: .private`;
  - crash reports: no recording values, poses or GNSS in breadcrumbs, context or exception messages. The reporter's `beforeSend` strips the messages of errors from capture code;
  - JavaScript: no pose, transform, GNSS or boundary value in `console.*`, `new Error(…)`, `throw` or a template literal, checked by a lint rule. Pose-bearing values cross into TypeScript inside wrappers whose `toString`, `toJSON` and `inspect` give `[redacted]`; only the code that uses a value, and the boundary-trace writer, unwraps it. React Native forwards JavaScript console output and errors to the device log in release builds too, so the walk build replaces React Native's log function to drop JavaScript messages while a capture runs.

  A test throws an error carrying a fake pose and checks that neither the crash event nor the device log holds it. The crash reporter's data region and transfer terms are recorded in [0009](0009-hosting-and-budget.md) when it is chosen.
- **AI agents.** Claude Code and other agents may run the replay and venue-test tools on anything the phone recorded (`origin: device`, from any build, desk checks included), on what is derived from it in `.data/replays/`, and on the outlines in `db/private/`. They never read its raw contents into a conversation: no poses, timestamps, GNSS fixes, images, boundary traces, mesh or derived geometry, and no screenshots or page reads of the app or the web export while it shows a venue trace or a replay. They never copy it outside `.data/` (no temp or scratchpad copies), where `pnpm rec delete`, the BitLocker check and the review wouldn't reach it. Their tool output goes to a model provider outside Singapore. So the tools print aggregate results only (counts, frame numbers, selection diffs as frame lists, scores, timings, ages in days, pass or fail); venue tests assert with value-free checks whose messages name only the file and the item; and a step that needs someone to look at the data itself is the owner's. Screenshots and screen recordings of the capture view are never shared with an agent. [CLAUDE.md](../../CLAUDE.md) carries the rule.
- **Retention, decided now.** Venue recordings are kept while they serve development. Every 3 months the owner reviews them (`pnpm rec ls` flags sets not reviewed for 3 months, by id and age in days, never by date or time), deletes those no longer needed and drops `location.jsonl` from those that don't need it. Any recording is deleted on request, from a venue or a person, through a contact address in the README and the app's About screen; `recording.json` lists the venues walked. `pnpm rec delete` removes every copy: the phone's export parts (at the next pull, if the phone isn't connected), `.data/holding/`, `.data/fixtures/recordings/`, `.data/replays/` and, from Phase 2, RustFS. It also puts the id on the backup script's deletion list, and backup sets are kept at most 30 days, so a deletion is complete within 30 days. Venue bundles kept as fixtures follow the same rule.
- **Git and EAS.** Synthetic replay sets are generated files (`pnpm rec synth`, from public geometry at real corridor coordinates, never from walks), one directory per set, `packages/recording/fixtures/synthetic/<set>/`, holding `rec-<id>/` beside its `capture-<id>/` bundles. CI regenerates them and fails on a diff, as with `pnpm gen`, and fails if they hold no tracked `recording.json`. A pushed branch of the public repo is already published, so the same check runs in CI and in a pre-push hook kept in the repo. It fails on any tracked `recording.json` that doesn't say `origin: synthetic`, and on recording or bundle files outside the generated sets and the hand-made fixture directories: `recording.json`, `frames.jsonl`, `boundary.jsonl`, `candidates/`, `location.jsonl`, `history.bin`, `capture-*/manifest.json`, `poses.jsonl`, `gnss.jsonl`, `*.part` and `parts.json`. `.gitignore` ignores `rec-*/`, `replay-*/` and `*.part` wherever they are, re-including only the generated sets. EAS cloud builds upload the working tree under the same ignore rules; an `.easignore` would replace them, so the repo has none. `venue` Vitest projects use no snapshot matchers at all, inline and file snapshots included (a test over their source), and the `pnpm rec` commands refuse output paths outside `.data/`.

### Measurements in the spike

- **Heat at the planned session lengths.** Spike criterion 2 becomes a sustained session of the planned length, at least 15 minutes, indoors and on a street leg, with record mode off, `lean` and `standard`: time to `.fair` and `.serious`, dropped frames, blur time per candidate, memory growth and MB/min per stream. The corridor is then walked as one session per leg, each under the measured safe time, cooling the phone between legs; `continuous_session` is used only within a leg.
- **Keyframe-anchor refinement.** An Apple engineer said in August 2026 that the world map is optimised without anchor update notifications, so update callbacks may never come. The recorder samples anchor transforms on its own timer instead (above). Whether keyframe anchors move at all, and by how much, is measured; it also decides whether `refined_keyframes.jsonl` is worth an ARAnchor per keyframe ([0008](0008-anchors-and-georeferencing.md)). An ARAnchor per candidate is an optional experiment.
- **Clocks.** `recording.json` records `ProcessInfo.systemUptime`, `CACurrentMediaTime()` and `Date()` at session start. The spike measures the offset between `ARFrame` and `CMDeviceMotion` timestamps and how location times are converted to `t`.
- A denied or unavailable altimeter is an event, never a failure.

### Versioning

- Changes go in this order: [session-recording.md](../session-recording.md) first, then `packages/contracts` (`schemas/recording/`, `RECORDING_VERSION`, `DEFAULT_RECORDING_LIMITS`, `pnpm gen` with Swift types for the lines Swift writes), then the Swift recorder and `validate-recording`.
- Unknown fields are rejected, and any breaking change bumps `recording_version`.
- Old recordings must stay usable, or the walk is lost. The TypeScript reader keeps an upgrader for every older `recording_version`, tested on synthetic sets of each version, and derivation always writes the current bundle `schema_version`.

## Why

- Apple's replay (Reality Composer's recording with Xcode's "ARKit: Replay data") drives only an app launched from Xcode's Run action on a Mac, and its .mov holds raw camera video and location, which [0005](0005-privacy-by-design.md) forbids. An Apple engineer suggested serialising `ARFrame` properties into your own harness instead. ARCore's recording and playback is the model.
- Keeping the bundle as the phone's product leaves the spike's Done-when, the validator, ingest and the Phase 4 contributor path as they are. With record mode off, the recorder costs nothing.
- A runtime option alone would ship the recorder, and its permission prompt, in every binary, guarded only by JavaScript. A prompt that a build doesn't use is also an App Review risk.
- A development build loads its JavaScript from Metro and sends console output back to it. On a walk the only way to Metro is the tunnel, where TLS ends at ngrok's edge. An embedded bundle has no such path, and also works without signal. The development build is used at a desk, often at home, so what it captures is kept on the phone and deleted.
- Off by default, owner-only and compiled only into owner builds: the extra personal data exists only when the owner wants a fixture, and production uploads carry only what processing needs (PDPA data minimisation).
- The `lean` profile lets the owner walk the corridor early, before the blur stack is finished: what a walk loses for good is what the Swift writer didn't record, while PC tooling can be written afterwards against real data.
- Screenshots are the likeliest way an unblurred frame would leave the phone: without a Mac they are how a UI bug gets reported, and they land in Photos, which syncs.
- Swift calls Objective-C methods through `objc_msgSend`, so a symbol listing alone would miss `CIContext`'s writers. A `fileprivate` initialiser holds even in a debug build, where testability would open an internal one to `@testable import`.
- Whole-container access through house_arrest has historically worked only for development-signed apps, and EAS internal-distribution builds are ad hoc-signed. `VendDocuments` with `UIFileSharingEnabled` works with both, and keeps the pull away from the snapshot iOS stores in the container.
- A recording per session, not per segment, fits `continuous_session` and the session-end reads, and needs no per-segment time windows.
- Making keyframes a subset of candidates is what makes keyframe selection replayable; forcing candidates at anchors and tags gives replays the images they need.
- Re-deriving in TypeScript is the fastest loop for keyframe policy and bundle-format changes: no Swift, no cloud build, no dependence on the Swift toolchain on Windows. The `recorded` check tests the Swift writers on real walks without a Mac.
- PDPA needs a retention period justified by its purpose, and recordings start in Phase 1, so the rule can't wait for Phase 4. A deletion has to reach the backups too, so their rotation is bounded. Tool output read by an AI agent leaves Singapore, which the Transfer Limitation Obligation covers.
- The EAS Free plan allows 15 iOS builds a month, at low priority with peak queues over 90 minutes and one macOS build at a time. The recorder rides the spike's planned builds; in-app replay costs a build, so it waits until it is needed.

Background and sources:

- [Apple: recording and replaying AR session data](https://developer.apple.com/documentation/arkit/recording-and-replaying-ar-session-data)
- [Apple Developer Forums, thread 831645 (June 2026)](https://developer.apple.com/forums/thread/831645), and [thread 842466 (August 2026)](https://developer.apple.com/forums/thread/842466) on anchor updates
- [ARCore recording and playback](https://developers.google.com/ar/develop/recording-and-playback)
- [OWASP MASTG-TEST-0290](https://mas.owasp.org/MASTG/tests/ios/MASVS-PLATFORM/MASTG-TEST-0290/) on iOS's app-switcher snapshots
- [Expo: logging](https://docs.expo.dev/workflow/logging/) and [internal distribution](https://docs.expo.dev/build/internal-distribution/)
- [pymobiledevice3 `apps` commands](https://github.com/doronz88/pymobiledevice3/blob/master/pymobiledevice3/cli/apps.py)
- [COMPRESSION_ZLIB](https://developer.apple.com/documentation/compression/compression_zlib)
- [Apple Platform Security: Data Protection classes](https://support.apple.com/guide/security/secb010e978a/web)
- PDPC Advisory Guidelines: [chapter 18, retention](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Advisory-Guidelines/AG-on-Key-Concepts/Chapter-18-9-Oct-2019.pdf), and [chapter 19, transfer](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Advisory-Guidelines/the-transfer-limitation-obligation---ch-19-(270717).pdf)
- [Pittaluga et al., CVPR 2019](https://arxiv.org/abs/1904.03303)
- [Expo pricing](https://expo.dev/pricing)

## Consequences

**ADR and format changes**

- [0005](0005-privacy-by-design.md) is amended: the recorder's candidate path is a `writeBlurredJPEG` path; `BlurredImage` and the fail-closed blur; the encoder check, the native-dependency allow-list and the recorder blur test; the snapshot cover and screenshots; world maps and image-anchor reference images; recordings as personal data, with their retention; the logging sinks; the rule for AI agents; the re-check on import.
- [0007](0007-expo-mapper-app.md) is amended: the candidate gate in every capture; the SwiftPM targets; the recorder behind the build-time switch, with `record`, `listRecordings`, `exportRecording`, `deleteRecording` and `appendBoundary`; the `walk` build and desk checks in the development build; the Phase 1 export path and what Documents holds; the clean-up in builds without the recorder; the debug screen's recording figures; spike criteria 1, 2, 3, 5 and 6.
- [0009](0009-hosting-and-budget.md) is amended: `pnpm dev:phone` is for desk testing, recordings and anything pose-bearing never go through tunnels or Metro, the `usg-recordings` bucket in Phase 2, local builds for recorder iterations and how their .ipa reaches the phone, backup retention, and the crash reporter's data region.
- [0008](0008-anchors-and-georeferencing.md) is amended to say that the spike measures keyframe-anchor refinement (and, with the MVP's move to the corridor, [0011](0011-mvp-scope-esplanade-corridor.md), its synthetic test uses corridor coordinates). The recorded anchor history and actions feed the spike's registration choice and the `continuous_session` open point.
- [capture-bundle.md](../capture-bundle.md) gets clarifications only: no format change and no `schema_version` bump.

**Costs and risks**

- The recorder and mesh history are about 1–1.5k more lines of Swift; in-app replay would add about 0.5k.
- About 2.4 GB of PC disk and backup per 15-minute standard walk with its bundles (an estimate). Routine walks use `lean`.
- Trusting replays too much is a risk. Results from replays are labelled as such; conclusions about ARKit configuration, registration, blur and performance need live walks.
- A replay set without its bundles can't be re-derived. Pull, import and delete keep them together, and the manifest SHA-256 in `recording.json` detects a mismatch.
- Every JavaScript change for a walk costs a walk build.
- Keeping the camera layer out of screenshots relies on behaviour Apple doesn't document. If an iOS update breaks it, the device check fails, and screenshots of the capture view are then caught only after they are taken, until this ADR finds another way.

## Alternatives considered

- **Recording first: the phone writes only recordings, and the PC derives every bundle.** The best iteration story, and its deriver, deterministic tar, UUIDv5 ids, per-session recording, `BlurredImage`, degradation ladder and synthetic recordings are all kept. Rejected as the architecture because it rewrites who writes bundles before the first native build, makes the recorder the only output path, makes ingest take recordings (about 2.8 times the data, and richer personal data, than processing needs), records every capture by default, and would leave Phase 4 contributors needing either derivation on the phone (per-frame data in JavaScript, against the native-boundary rule) or a Swift port of the deriver.
- **A sidecar per segment, re-derived with a Swift `capture-replay` on Windows.** Most of it is kept. Changed: one recording per session instead of per segment, and the TypeScript deriver as the first re-derivation tool, because Swift on Windows isn't proven for this target yet. `capture-replay` on WSL and in-app replay come last.
- **Recording in development builds connected to Metro.** Simpler, one build fewer, but console output, LogBox errors and traces would cross ngrok on every walk, and the app would need a signal underground.
- **Pulling the whole app container.** Unlikely to work on ad hoc builds, and the container holds iOS's snapshots, Expo's caches and `tmp/`.
- **Apple's Reality Composer recording with Xcode replay, or the private `ARReplaySensor` SPI.** Both need a Mac or a private API archived in 2021, and both store unblurred video.
- **Blurred HEVC video at 30 fps.** The blur would have to run at 30 fps: about 90 detector runs a second on top of ARKit.
- **Bundles only.** They already replay everything after keyframe selection, but not keyframe re-selection, the mesh over time, events or the JavaScript flows.
- **An ARAnchor per candidate by default.** Its cost to tracking (about 900 to 4,500 anchors per session) is unmeasured, so it is a spike experiment. Derived bundles carry `refined_keyframes.jsonl` lines only for keyframes that had an anchor.
- **`ARWorldMap` in recordings.** It can be inverted into images; decided with registration in [0008](0008-anchors-and-georeferencing.md).
- **Setting the retention period before Phase 4, with the raw-bundle rule.** Recordings start in Phase 1, and the raw-bundle rule (delete after approval unless flagged) would exempt every fixture.
- **An internal `BlurredImage` initialiser.** It holds under SwiftPM, but a debug build with testability lets `@testable import` reach it.
