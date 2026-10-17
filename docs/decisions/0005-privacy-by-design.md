# 0005: Privacy by design

Status: accepted · 2026-10-12 · amended 2026-10-12, 2026-10-15, 2026-10-17

## Decision

### Blur on the phone

- Faces, the head region of every detected person, and screens are blurred on the phone before any image is written to a capture bundle or a session recording. Every keyframe, and every candidate a recording keeps, goes through one Swift choke point, `writeBlurredJPEG`. Photos taken outside a capture go through `blurPhoto(src, dst)` before they are stored or uploaded, and the unblurred source is deleted at once. Nothing per frame, images included, crosses into JavaScript ([0007](0007-expo-mapper-app.md)).
- Blur is irreversible: a solid fill, or pixelation with cells of 16 px or larger, over a padded box.
- "Screens" means personal devices plus any display showing people.
- `privacy/blur.jsonl` in the bundle has one line per keyframe with its blur boxes (`face`, `person_head` or `screen`) in keyframe pixel coordinates. The manifest records `privacy.detector_versions` and the blur counts ([capture-bundle.md](../capture-bundle.md)). A recording has a line for each candidate it keeps ([session-recording.md](../session-recording.md)).
- **The blur fails closed.** `writeBlurredJPEG` accepts only a `BlurredImage`, which is defined in its own SwiftPM target with a `fileprivate` initialiser in the blur's own file, and compiled as its own module in the app build too, without testability, so only the blur can make one. The blur makes one only after every detector (face, person_head, screen) ran successfully on that exact frame, at the resolution the spike fixes. A detector error, a timeout or a model not yet loaded drops the frame, which is never written. Boxes are never reused or carried over between frames, and nothing done for heat or load changes the detectors ([0010](0010-capture-recording-and-replay.md)).
- **The encoder check runs on compiled code.** The macOS CI job fails if any compiled object outside the blur's target, the depth and confidence PNG writer and the frame copy references an image or video encoder, a write to the Photos library or raw pixel access. It reads both the undefined symbols and the Objective-C selector references, since a Swift call to an Objective-C method such as `CIContext`'s JPEG writer leaves only a selector ([0010](0010-capture-recording-and-replay.md) lists them). It runs from the module's first build, so the first walk build is checked too. `apps/mapper` keeps an allow-list of its native dependencies, which refuses packages that write images, snapshot views or write to the Photos library. A negative compile test shows that code outside the blur's file can't construct a `BlurredImage`, through `@testable import` included.
- **iOS's app-switcher snapshot, screenshots and screen recordings.** When the app leaves the foreground, iOS saves a snapshot of the screen in the app's container, which would show the live camera view. The module covers the camera view with an opaque view before that happens (`sceneWillResignActive`), and keeps it covered while the screen is being recorded or mirrored (the scene's capture state). A screenshot would write the live camera view to the Photos library, which may sync to iCloud: the module hosts the camera layer where iOS leaves it out of screenshots and screen recordings, and if a screenshot is taken anyway, it records the event and asks the owner to delete it. Screenshots and screen recordings of the capture view are never shared with an AI agent. A device check, part of the spike's privacy criterion, confirms that a snapshot taken mid-capture shows only the cover and that a screenshot shows no camera content. The crash reporter never attaches screenshots or view hierarchies.

### Detectors

| Target | Phone | Server re-check |
| --- | --- | --- |
| Faces | Apple Vision (`VNDetectFaceRectanglesRequest`) | YuNet (MIT), on tiles or at several scales, since it covers faces of about 10-300 px |
| Heads (backstop) | Head region of every person found by `VNDetectHumanRectanglesRequest` | - |
| Screens | Not chosen yet (see below) | Not chosen yet (see below) |

Apple Vision has no screen detector. The screen model is a permissively licensed Core ML model, chosen in the Phase 1 spike with a fixture benchmark. Candidates: Apple's MIT YOLOv3, RF-DETR N/S/M/L (Apache-2.0; its other sizes use the PML licence), D-FINE (Apache-2.0). The server's screen model is chosen in the Phase 2 screen re-check task ([backlog](../backlog.md)); the review's candidate is RT-DETR (Apache-2.0).

Licence rule: code and weights must both be permissive. Never Ultralytics YOLO (AGPL-3.0, including its weights). When the spike picks the models, record each one and its licence in the table above.

### Server re-check

- A processing worker re-runs detection with ONNX Runtime (onnxruntime-node), never in the API process.
- A detection counts as a miss only if the region is still sharp (variance-of-Laplacian test inside the detection).
- A frame with a still-sharp face is quarantined: removed from the stored bundle and excluded from processing, with its frame index recorded in `captures.quarantined_frames`. The capture is flagged (`captures.privacy_flagged`).
- A flagged capture blocks publishing on every path, the owner's included, until the owner or a moderator has looked at it and cleared the flag; the clearing is recorded in `moderation_events`. Any failed automated gate blocks publishing the same way ([0004](0004-storage-and-versioning.md)).
- The whole bundle fails (`captures.status = 'failed'`, `failure_reason = 'privacy'`) and is deleted only if the quarantined share exceeds a threshold, or an anchor photo is affected. The threshold is a tuning value, starting at 5%.
- Open: what a still-sharp screen does, quarantine like a face or a flag for review. The server model also finds displays the phone rightly left sharp (signage not showing people). Decided with the server screen detector in the Phase 2 screen re-check task.
- The same face re-check runs over every image in a replay set (bundle keyframes and recorded candidates) when it is imported on the PC, before any test or tool reads it. A still-sharp image is deleted, and quarantines and privacy failures that ingest decides later are carried over to the fixture copies ([0010](0010-capture-recording-and-replay.md)).

### Storage and residency

- Bundles and session recordings are private; nothing in either is served publicly.
- Private data stays in Singapore: the owner's PC through Phase 3, then S3 in ap-southeast-1 with Block Public Access and encryption. Public, non-personal files may be served from Cloudflare's global edge. R2 cannot be pinned to Singapore, so nothing private goes there ([0009](0009-hosting-and-budget.md)).
- `captures.contributor_id` is set from the upload's auth, never from the manifest.
- Capture bundles, session recordings, anchor and evidence photos never pass through a TLS-terminating third-party proxy or a request inspector, development tunnels included: `pnpm dev:phone`'s ngrok endpoints carry public map data and the mapper app's development code only ([0009](0009-hosting-and-budget.md#remote-access-during-phases-13)). Query photos follow the same rule ([0002](0002-photo-localization.md)).
- Nor does anything pose-bearing (poses, transforms, floor triangles, GNSS fixes, boundary traces), and none of it passes through Metro: captures in a venue use the walk build, whose JavaScript is embedded, so nothing connects to a dev server during a walk ([0010](0010-capture-recording-and-replay.md)).
- On the phone, recordings and their exports use Data Protection (`NSFileProtectionComplete` once closed) and are excluded from backup. In the development and walk builds only the export folder lives under Documents, which file sharing exposes. iCloud Backup is off for the app, local backups of the phone are encrypted, and the Apple Devices app doesn't sync automatically.

### Localization queries

Query photos and feature payloads are processed in memory, dropped once the pose is returned, and never stored or logged. The release-blocking privacy-path checklist is kept in one place, [0002](0002-photo-localization.md).

### Node upload trap

`@fastify/multipart`'s `saveRequestFiles` and multer's disk storage write temp files. Any image that reaches Node streams to private storage or stays in memory, with a test.

### Other image paths

| Image | Rule |
| --- | --- |
| Anchor reference photos | Private (`anchors.photo_uri`). In a bundle they are keyframes, so already blurred. |
| Session-recording candidates | Non-keyframe candidates that a `standard` or `dense` recording keeps. They go through `writeBlurredJPEG` like keyframes, each with its `privacy/blur.jsonl` line, under the keyframe JPEG rules. A recorder blur test runs on the macOS runner: the fixture images sent through the recorder path come out blurred, and a failing detector writes nothing. Private, and never uploaded to ingest ([0010](0010-capture-recording-and-replay.md)). |
| iOS's app-switcher snapshot | Written by iOS, not the app, so the camera view is covered first (above). The Phase 1 pull never reads the app container, only the export files it lists. |
| Screenshots and screen recordings | Written by iOS to the Photos library. The camera layer is kept out of them, and a screenshot taken anyway is flagged on screen to be deleted (above). Never shared with an AI agent. |
| `ARWorldMap`s in the spike's registration experiment | Their feature points can be inverted into images. They stay on the phone in `Library/Application Support/worldmaps/`, `NSFileProtectionComplete` and excluded from backup, are never exported or pulled, and are deleted when the experiment ends, until [0008](0008-anchors-and-georeferencing.md) decides ([0010](0010-capture-recording-and-replay.md)). |
| Image-anchor reference images | Cropped only from a `BlurredImage` and stored only through `writeBlurredJPEG`. |
| Status-edit evidence photos | Private (`status_reports.evidence_uri`), never public. Taken in the mapper app, they go through `blurPhoto` on the phone; they are also blurred server-side, and an unblurred original is held only in private storage until a worker blurs it, then deleted. Kept only until the decision plus a retention period. |
| Landmark crops for directions | Out of the MVP; adding them later is an owner decision. If they are added: re-encode (strips EXIF), blur people as well as faces, moderator approval per crop, a separate public bucket, and a takedown and cache-purge procedure. |

### Trajectories and recordings

Poses, IMU, timestamps and GNSS fixes are the contributor's personal data. They need a privacy notice, a retention rule for raw bundles, and encryption at rest, which covers the owner's PC and the backups through Phase 3 ([0009](0009-hosting-and-budget.md)). The rule: delete a bundle a set period after approval unless it is flagged for reprocessing. The period is set before Phase 4.

A session recording is richer personal data: a full-rate trajectory, 100 Hz motion that can identify a walker by gait, the magnetometer, relative altitude, GNSS windows at street anchors and, in the standard profile, more blurred bystander images. Recordings start in Phase 1, so their retention is set now: a recording is kept while it serves development, reviewed by the owner every 3 months, and deleted on request, every copy of it; backup sets are kept at most 30 days. Venue bundles kept as fixtures follow the same rule ([0010](0010-capture-recording-and-replay.md)). Desk checks in the development build, often made at home, write no GNSS and are deleted on the phone.

### Logs

Every log sink names files, lines and frames, never poses, times, GNSS fixes or boundary values: CLI and validator output; `os.Logger`, where interpolated poses, fixes and times use `privacy: .private`; crash reports, with none of them in breadcrumbs, context or exception messages; and JavaScript's console, errors and thrown values, checked by a lint rule, with pose-bearing values wrapped so that printing one gives `[redacted]`. The walk build drops JavaScript messages from the device log while a capture runs ([0010](0010-capture-recording-and-replay.md)).

### AI agents

AI agents (Claude Code included) may run the replay and venue-test tools on anything the phone recorded (from any build, desk checks included), on what is derived from it and on the restricted-zone outlines, but never read raw contents into a conversation: no poses, timestamps, GNSS fixes, images, boundary traces, mesh or derived geometry, and no screenshots or page reads of a replay. They never copy such data outside `.data/`, and screenshots of the capture view are never shared with them. An agent's tool output goes to a model provider outside Singapore, so those tools print aggregate results only (counts, frame numbers, scores, timings, pass or fail), venue tests assert without printing values, and a step that needs someone to look at the data itself is the owner's. [CLAUDE.md](../../CLAUDE.md) carries the rule.

### Restricted areas

- Only public walkways are published. No back-of-house, service corridors, plant rooms or security features.
- `restricted_zones` are drawn per venue and never published; the outlines also stay out of git and out of logs. Extraction clips against them, and no feature may overlap the interior of one (`ST_Relate(feature, zone, 'T********')`; sharing an edge is fine). The database refuses an overlapping feature in HEAD, so an overlap blocks publishing.
- This applies on every publish path, including `owner_mapper` and `trusted_status_auto`.
- A recording's mesh history, and the output of a replayed extraction, can show back-of-house geometry before clipping, so they are kept like the outlines: never in git, test goldens or logs. Replays of the pipeline load the venue's zones from `db/private/`, so they clip as production does.

## Why

- Identifiable faces are personal data under Singapore's PDPA, and a project that scans public places should be visibly careful.
- Rejecting a whole bundle for any unblurred face would reject most mall bundles: posters, ads and mannequins trigger detectors, and the server detector differs from Vision. Quarantining frames keeps sharp faces out without throwing away good captures.
- Face detectors miss the backs of heads and small or turned faces. The head region from human rectangles is a second net.
- A light blur can be reversed. A solid fill or coarse pixelation cannot.
- A blur that skipped a detector that hadn't loaded, or reused old boxes under load, would write sharp faces exactly when the phone is busiest. A type only the blur can make, and a check on compiled code, hold where a code review alone wouldn't.
- iOS's snapshot, and a screenshot, are images the app never writes itself, so the one write path can't cover them.
- Blur boxes in the bundle let the server and the tests check what the phone did.
- IP, time and position together count as location personal data.
- A trajectory shows where and when a person walked.
- What an AI agent reads leaves Singapore, which PDPA's Transfer Limitation Obligation covers.

Background and sources: [stack review](../reviews/2026-10-12-stack-review.md), sections 0, 2 (screen detection), 5 (privacy path) and 7 (items 7, 8 and 12); [0010](0010-capture-recording-and-replay.md) for recordings.

## Consequences

Any code that touches images must keep these guarantees. Treat a violation as a release blocker, and add a test whenever an image path changes. In practice:

- Any change to the module's image code runs the blur tests in CI: `swift test` on the macOS runner with fixture images, including a poster face, a small far face, the back of a head and a phone screen; the recorder blur test and its detector-failure case; the negative compile test; the encoder check; and the native-dependency allow-list.
- `privacySelfTest()` must also pass on the phone, because Vision on macOS can differ from iOS, and the snapshot and screenshot checks must show no camera content. Both are part of a Phase 1 spike exit criterion.
- The localization path has its no-temp-file, no-body-logging test.
- Every image upload that reaches Node has a test that it writes no temp file.
- The repo is public, so fixtures in git are synthetic, recorded where the owner is happy to publish them (no images or GNSS fixes), or images used with the subject's consent or under an open licence. Nothing recorded in a venue goes in git, recordings included; tests that need it read it from the git-ignored `.data/fixtures/` and skip when it is absent.
- The retention periods for raw bundles and evidence photos, and the privacy notice, are set before Phase 4. Recordings' retention is set already (above).
