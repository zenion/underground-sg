# 0002: Photo-based localization for public users

Status: accepted · 2026-10-12 · amended 2026-10-12, 2026-10-15

## Decision

"Where am I" works by matching one camera photo from the webapp against keyframes from approved captures: image retrieval, then local feature matching and a pose solve. It returns level, position, heading and confidence.

This is Phase 4 work. Nothing is built for it now, but the capture bundle already records what the index will need.

### Service

- A Go service, `services/localization`, built in a Linux container because PoseLib needs cgo. It is the only Go code in the repo and the one exception to an all-TypeScript server ([0006](0006-typescript-backend.md)).
- Inference runs on CPU with onnxruntime_go. A GPU only with the owner's explicit approval ([0009](0009-hosting-and-budget.md)).
- Python is never in the serving path. One-off model exports to ONNX are offline tooling, which is allowed.

### Models

| Step | Model | Licence |
| --- | --- | --- |
| Retrieval | MegaLoc | MIT (DINOv2 backbone: Apache-2.0) |
| Local features | (RaCo-)ALIKED | BSD-3 |
| Matching | LightGlue, exported with LightGlue-ONNX | Apache-2.0 |
| Pose | PoseLib, through a cgo shim, with focal-length estimation | BSD-3 |

Banned: SuperPoint and SuperGlue weights (non-commercial), SALAD (GPL-3.0), MixVPR (no licence). CI keeps a model allow-list.

### Reference data

- 3D points come from keyframe LiDAR depth plus refined poses (`refined_keyframes.jsonl`, see [0008](0008-anchors-and-georeferencing.md)). LiDAR is useful to about 5 m, so points further away come from a raycast into the mesh. The index needs no structure-from-motion.
- The index is built per published map version, from approved captures only, and held in memory. Rollback rolls it back too ([0004](0004-storage-and-versioning.md)). Nothing is indexed before approval. pgvector is optional.

### Latency on CPU

- Match only the top 3-5 retrieval candidates, with about 512 keypoints each.
- Pre-filter by level, position and heading hints.
- Use gravity from DeviceMotion so upright solvers apply.
- Stop early once a pose is good enough.
- When matching runs out of time, return a retrieval-only answer: level and approximate position.

The 3 s response time is measured and reported, not a gate.

### API

- `POST /locate` takes either a raw `image/jpeg` body or a features payload. The client resizes the photo to about 1024 px and strips metadata, sending the EXIF focal length as a hint when it has one. The other hints are last known position, selected level and compass heading ([spec](../spec.md)).
- The features payload exists so browser-side extraction can be tried later without changing the API. It is an experiment, not the default.
- Abuse limits: rate limits per IP, a bounded queue that answers 503 fast when full, and body size caps.

### Privacy path (release-blocking)

Every item holds before launch ([0005](0005-privacy-by-design.md)):

- Read the body into memory under a size cap. Never use multipart parsing that spills to disk.
- No proxy request buffering to disk.
- No TLS-terminating third-party proxy or request inspector on the path of a query photo or feature payload (development tunnels included, such as `pnpm dev:phone`'s ngrok; [0009](0009-hosting-and-budget.md#remote-access-during-phases-13)).
- No request-body capture in APM or crash reporting.
- Core dumps off.
- Never log IP together with position.
- The hostname that serves `POST /locate` is DNS-only, not proxied through a CDN.
- Feature payloads get the same never-store rule as photos.
- An automated test asserts no temp files and no body bytes in logs.

### Mapper mode

Testing a photo locate against the draft needs a private, owner-only draft index on the server. It arrives with localization in Phase 4. Route testing against the draft works on the phone from Phase 2 ([0003](0003-routing.md)).

## Why

- GPS fails underground. iOS Safari cannot scan Wi-Fi or Bluetooth beacons.
- The scans the mapper already collects double as the reference data, so no separate survey or hardware is needed.
- Go rather than Node: onnxruntime-node runs inference on the JS main thread, so a Node service would need worker threads, each loading its own copy of models of up to about 0.9 GB. Go can share one session across goroutines.
- Every model above is permissive for both code and weights. Popular alternatives are non-commercial or copyleft.
- LiDAR depth gives metric 3D points directly, so the index skips SfM.
- CPU keeps to the low budget. An always-on GPU in Singapore costs about US$540 a month on demand, and scaling to zero breaks the latency target because of model load time.
- A query photo proxied through a CDN is TLS-terminated at the CDN's edge. IP, time and position together count as location personal data.

Background and sources: [stack review](../reviews/2026-10-12-stack-review.md), section 5.

## Consequences

- Positions are discrete fixes, not continuous tracking. The dot stays at the last fix between photos.
- Fallbacks: the retrieval-only answer; tap a nearby landmark ("I'm at"); QR codes at junctions if landlords agree.
- Query photos and feature payloads are processed in memory, dropped once the pose is returned, and never stored or logged (0005).
- Target: correct level, within about 5 m. Validate in Phase 4 with a CPU benchmark on Funan data, and report the response time.
- Capture during opening hours on quiet weekday mornings. Shopfronts are the best landmarks; shutters at capture time would not match daytime queries.
- MegaLoc's training data (ScanNet, MSLS) has research-only terms. Get legal review if an agency adopts the project.
- PoseLib's robust focal-length estimation is only on master: pin a commit or wrap p4pf.
- Separate extractor and matcher ONNX files need LightGlue-ONNX's Python exporter. That is offline tooling.
- The capture bundle locks in what the index needs: intrinsics with image size and orientation, depth intrinsics, confidence maps, refined poses and the mesh ([capture-bundle.md](../capture-bundle.md)).
