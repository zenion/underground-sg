# 0005: Privacy by design

Status: accepted · 2026-10-12 · amended 2026-10-12

## Decision

### Blur on the phone

- Faces, the head region of every detected person, and screens are blurred on the phone before any image is written to a capture bundle. Every keyframe goes through one Swift choke point, `writeBlurredJPEG`. Photos taken outside a capture go through `blurPhoto(src, dst)` before they are stored or uploaded, and the unblurred source is deleted at once. Nothing per frame, images included, crosses into JavaScript ([0007](0007-expo-mapper-app.md)).
- Blur is irreversible: a solid fill, or pixelation with cells of 16 px or larger, over a padded box.
- "Screens" means personal devices plus any display showing people.
- `privacy/blur.jsonl` in the bundle has one line per keyframe with its blur boxes (`face`, `person_head` or `screen`) in keyframe pixel coordinates. The manifest records `privacy.detector_versions` and the blur counts ([capture-bundle.md](../capture-bundle.md)).

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

### Storage and residency

- Bundles are private; nothing in a bundle is served publicly.
- Private data stays in Singapore: the owner's PC through Phase 3, then S3 in ap-southeast-1 with Block Public Access and encryption. Public, non-personal files may be served from Cloudflare's global edge. R2 cannot be pinned to Singapore, so nothing private goes there ([0009](0009-hosting-and-budget.md)).
- `captures.contributor_id` is set from the upload's auth, never from the manifest.

### Localization queries

Query photos and feature payloads are processed in memory, dropped once the pose is returned, and never stored or logged. The release-blocking privacy-path checklist is kept in one place, [0002](0002-photo-localization.md).

### Node upload trap

`@fastify/multipart`'s `saveRequestFiles` and multer's disk storage write temp files. Any image that reaches Node streams to private storage or stays in memory, with a test.

### Other image paths

| Image | Rule |
| --- | --- |
| Anchor reference photos | Private (`anchors.photo_uri`). In a bundle they are keyframes, so already blurred. |
| Status-edit evidence photos | Private (`status_reports.evidence_uri`), never public. Taken in the mapper app, they go through `blurPhoto` on the phone; they are also blurred server-side, and an unblurred original is held only in private storage until a worker blurs it, then deleted. Kept only until the decision plus a retention period. |
| Landmark crops for directions | Dropped from the MVP unless landlords' permission covers publishing photos. If it does: re-encode (strips EXIF), blur people as well as faces, moderator approval per crop, a separate public bucket, and a takedown and cache-purge procedure. |

### Contributor trajectories

Poses, IMU, timestamps and GNSS fixes are the contributor's personal data. They need a privacy notice, a retention rule for raw bundles, and encryption at rest, which covers the owner's PC and the backups through Phase 3 ([0009](0009-hosting-and-budget.md)). The rule: delete a bundle a set period after approval unless it is flagged for reprocessing. The period is set before Phase 4.

### Restricted areas

- Only public walkways are published. No back-of-house, service corridors, plant rooms or security features.
- `restricted_zones` are drawn per venue and never published; the outlines also stay out of git and out of logs. Extraction clips against them, and no feature may overlap the interior of one (`ST_Relate(feature, zone, 'T********')`; sharing an edge is fine). The database refuses an overlapping feature in HEAD, so an overlap blocks publishing.
- This applies on every publish path, including `owner_mapper` and `trusted_status_auto`.

## Why

- Identifiable faces are personal data under Singapore's PDPA, and landlords will only grant scanning permission if the project is visibly careful.
- Rejecting a whole bundle for any unblurred face would reject most mall bundles: posters, ads and mannequins trigger detectors, and the server detector differs from Vision. Quarantining frames keeps sharp faces out without throwing away good captures.
- Face detectors miss the backs of heads and small or turned faces. The head region from human rectangles is a second net.
- A light blur can be reversed. A solid fill or coarse pixelation cannot.
- Blur boxes in the bundle let the server and the tests check what the phone did.
- IP, time and position together count as location personal data.
- A trajectory shows where and when a person walked.

Background and sources: [stack review](../reviews/2026-10-12-stack-review.md), sections 0, 2 (screen detection), 5 (privacy path) and 7 (items 7, 8 and 12).

## Consequences

Any code that touches images must keep these guarantees. Treat a violation as a release blocker, and add a test whenever an image path changes. In practice:

- Any change to the module's image code runs the blur tests in CI: `swift test` on the macOS runner with fixture images, including a poster face, a small far face, the back of a head and a phone screen.
- `privacySelfTest()` must also pass on the phone, because Vision on macOS can differ from iOS. It is a Phase 1 spike exit criterion.
- The localization path has its no-temp-file, no-body-logging test.
- Every image upload that reaches Node has a test that it writes no temp file.
- The repo is public, so fixtures in git are synthetic, recorded where the owner is happy to publish them (no images or GNSS fixes), or images used with the subject's consent or under an open licence. Nothing recorded in a venue goes in git; tests that need it read it from the git-ignored `.data/fixtures/` and skip when it is absent.
- The retention periods for raw bundles and evidence photos, and the privacy notice, are set before Phase 4.
