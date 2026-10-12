# Stack and spec review

2026-10-12 · Review done before the MVP build starts. This is not a decision record. Once the owner answers the questions in section 9, the outcomes go into `docs/spec.md`, `docs/decisions/` and `docs/backlog.md` in one change, and this file stays as background.

**Inputs:**
- The owner's two new constraints: development happens only on Windows and WSL, with no macOS; and there is no Python in core systems, with Go and/or Node preferred.
- Six research tracks. Each was fact-checked against primary sources: 293 of 325 load-bearing claims were confirmed, and the corrections are folded in below.
- An independent review of the spec, the schema and the capture-bundle format.

Versions and prices below are as of today. Recheck them when you pin dependencies.

## 0. Owner decisions (2026-10-12)

| Question | Decision | Effect on this review |
| --- | --- | --- |
| Backend language | **All TypeScript** on the server. The one exception is localization, which stays a Go service (Phase 4). | This replaces section 3's Go recommendation; the "fallback" stack there becomes the plan. |
| Python | **Allowed for offline tooling and for containerised batch workers** (for example COLMAP/pycolmap or hloc-style steps) behind the Node job queue. Never in the API or the localization serving path. | Section 4: the gated COLMAP step can use pycolmap if that is simpler. Section 5: separate ONNX exports are allowed. |
| Mac | **An escape hatch is OK.** The default is EAS builds plus macOS CI; rent a cloud Mac for occasional Xcode/Instruments days; reconsider a used Mac mini if blind debugging costs more than about a day a week. | Section 2 stands as written. |
| Contributors | **The owner is the only mapper through Phase 3.** Contributor sign-up, trust tiers, shared drafts and external TestFlight arrive in Phase 4. | Auth is one owner account with a device token until Phase 4. |
| Repo | **Public on GitHub.** | macOS CI runners are free. iOS device builds can also run on them (`eas build --local` on a macOS runner), so a paid EAS plan is optional. |
| Webapp | **Vite + React SPA** on Cloudflare. The moderation UI is an authenticated route that calls the Node API. | Drop Next.js from the spec. |
| Auto-publish | **Owner mapper-mode work, plus trusted contributors' status edits** published as a short-lived overlay. Each is a separate publish path enforced in the database, and automated privacy and restricted-area checks still run on both. | Fix CLAUDE.md, the spec and the schema CHECK to match (section 7, item 6). |
| Budget | **As low as possible.** | See below. |

The low-budget plan:

- **Phases 1–3: no cloud hosting.** PostGIS, the S3 stand-in, the API and the processing workers run on the owner's PC (Docker on WSL2). The phone uploads over home Wi-Fi on the LAN, which fits the "queue for upload on Wi-Fi" rule. Raw bundles stay on the local disk in Singapore. Back them up to an external drive or a cheap S3 Singapore bucket.
- **Builds.**
  - Start on the EAS Free plan (15 iOS builds a month).
  - Add free GitHub macOS runner builds for the public repo.
  - Consider Xcode Cloud, whose 25 hours a month come with Apple membership.
  - Pay for EAS Starter only if the native loop becomes the bottleneck.
  - The only fixed cost is the $99/yr Apple Developer Program.
- **Public map.** Cloudflare Pages plus R2 on free tiers for the webapp and immutable snapshots.
- **Phase 4.**
  - Hosting: the smallest x86 Singapore server that runs the Node API and PostGIS (about $12–24/mo).
  - "Locate me": runs on CPU. The 3 s target becomes "measure and report" rather than a gate, with retrieval-only answers when matching runs out of time, and no GPU.
  - Processing: can stay on the owner's PC or move to the same server.

What all-TypeScript means for the server:

- **Services.** `services/api` and `services/processing` use Node 24 LTS (Node 26 once it becomes LTS on 28 Oct), Fastify 5, and Kysely with raw SQL and `ST_AsGeoJSON` for geometry. The job queue is Postgres-backed: pg-boss or River's TypeScript client, chosen at scaffold time.
- **Heavy work stays out of the API process.** CPU-heavy steps (PLY and depth parsing, the network adjustment, ONNX privacy checks) run in separate worker processes.
- **Shared code.** `packages/floorplan`, the network-adjustment maths and the bundle validator are now shared by the phone and the server. That is a real win of this choice.
- **Contracts.** These are still JSON Schema, because the Swift bundle writer needs them. Author them either as JSON Schema files, or in TypeBox or zod 4 and emit JSON Schema. Swift types are still generated with quicktype.
- **Upload privacy trap.** `@fastify/multipart`'s `saveRequestFiles` and multer's disk storage write uploads to temp files. Any image upload that reaches Node, such as status evidence, must stream to private S3 or stay in memory, with a test.
- **The one Go service.** Localization is the only Go code in the repo, built in a Linux container because it uses cgo.

## 1. Recommendation in brief

| Layer | Spec today | Recommended |
| --- | --- | --- |
| Mapper app | Swift, ARKit, RealityKit, Vision | Expo TypeScript app plus one local Swift Expo module (`capture-native`). The module handles ARKit, RealityKit, Vision blur and the bundle writer. Start on SDK 57 and move to SDK 58 once it is stable. |
| Mapper map | MapLibre Native | maplibre-gl-js + terra-draw in an Expo DOM component, the same code as the web moderation UI. `@maplibre/maplibre-react-native` v11.5 is the fallback for read-only views. |
| API | Python, FastAPI | Go 1.27: `net/http` with the oapi-codegen strict server, pgx v5 + sqlc, goose migrations |
| Jobs | "job queue" | River: Postgres-backed, no Redis |
| Processing | Python GPU workers, COLMAP, Open3D | Go workers, PostGIS and ONNX Runtime. Use the COLMAP 4.x command-line tool only if Phase 2 drift data calls for it. No Open3D, and no GPU for the MVP. |
| Localization | hloc-style pipeline (Python) | A Go service: onnxruntime_go running MegaLoc and (RaCo-)ALIKED + LightGlue, with PoseLib through cgo |
| Contracts | Prose in `capture-bundle.md` | `contracts/` holds OpenAPI 3.1 and JSON Schema 2020-12 files; Go, TypeScript and Swift code is generated from them |
| Webapp | Next.js + MapLibre GL JS | A Vite + React SPA with MapLibre GL JS v6. Keep Next.js only if you want server rendering or SEO pages (question 6). |
| Shared TypeScript | routing, plus a Swift port of it | `routing`, `map-style`, `floorplan` and `api-client`: one copy each, used by both the web app and the mapper app |
| Database | PostGIS | Postgres 18 + PostGIS 3.6 (`postgis/postgis:18-3.6`) |
| Object storage | S3-compatible; MinIO locally | S3 in ap-southeast-1 for private data; Cloudflare (R2/Pages) for public files; RustFS or SeaweedFS locally |
| Auth | Open question | Defer until external contributors join; then email one-time codes plus passkeys. Singpass needs a registered entity (UEN). |

**Python:** none at runtime. At most it is offline tooling, such as one-off model exports to ONNX and evaluation scripts (question 2).

The heavy compute was never Python. COLMAP is C++/CUDA, and neural networks run in ONNX Runtime or CUDA. Switching to Go changes the glue code, not the speed of the maths.

## 2. Mapper app: Expo plus one Swift module

### Verdict

Expo works without a Mac, but "Expo" really means a TypeScript app wrapped around one Swift module that you write yourself. No maintained React Native library exposes ARKit LiDAR scene reconstruction together with depth and pose export:

- ViroReact is a rendering engine and records unblurred video.
- react-native-arkit has been unmaintained for years.
- Newer packages such as `expo-ar` and `munim-xr` are single-maintainer and cannot read raw frames.

Only one ARSession can own the camera, so these libraries cannot be mixed with custom capture code. Expect roughly 2.5–3.5k lines of Swift, about 25–35% of the mapper code but most of its risk, and 6–9k lines of TypeScript.

### Where the boundary sits

Nothing that runs per frame crosses into JavaScript. JS holds a session handle and receives about 5 status events per second plus small results.

| Swift (`apps/mapper/modules/capture-native`) | TypeScript |
| --- | --- |
| ARSession (`.meshWithClassification`, `.smoothedSceneDepth`) and the RealityKit `ARView` view component | All screens, navigation, and the anchor and tag flows |
| Keyframe selection. Copy the pixel buffer and release the ARFrame at once; holding ARFrames starves the camera buffer pool. | `manifest`/`anchors`/`tags` JSON, typed from the shared contracts |
| Vision blur through one `writeBlurredJPEG` path: faces, plus human rectangles as a backstop, plus a screen detector | Drift calculation from the anchor transforms the module returns |
| 16-bit depth PNG, confidence PNG, binary PLY with per-face classification, poses/IMU writers | `packages/floorplan`: occupancy grid, close, marching squares, simplify, GeoJSON |
| Export of floor-classified triangles as a zero-copy `ArrayBuffer` | Coverage grid, the draft store (expo-sqlite), routing tests, upload orchestration |
| `packBundle`: split the bundle into 16 MB part files | The map and draft editor (DOM component) |

API sketch:
- `getCapabilities()`
- The `<CaptureView>` view with `onStatus`, `onTrackingChange` and `onWarning` events
- A `CaptureSession` shared object with `start`, `markAnchor`, `addTag`, `stop`, `floorTriangles`, `poseTrack` and `discard`
- `blurPhoto(src, dst)` for anchor and status photos taken outside a capture
- `privacySelfTest()`
- `packBundle(dir, partBytes)`

Build it on the stable Expo Modules API. Expo Modules 2.0 is still in beta and undocumented.

**Floor-plan preview in TypeScript, not Swift.** The deciding factor is that, with no Mac, TypeScript can be unit-tested on Windows against recorded bundles. Hermes does not run WebAssembly, so the geometry has to be pure JS (earcut, polygon-clipping, own grid code). Benchmark it on the phone with a real Funan mesh. If it takes more than about 2 s, move only the rasterise step into Swift behind the same signature.

**Map.** An Expo DOM component runs maplibre-gl-js and terra-draw in a WebView. That gives the same renderer and style as the web app and editing tools that work out of the box, and you can develop it in desktop Chrome. maplibre-react-native has no polygon editing. Two rules:
- Unmount the map on the capture screen, because it competes with ARKit for GPU, memory and heat.
- Base tiles need a signal. Offline OneMap tiles need SLA's permission.

**Upload.**
1. Native `packBundle` writes the part files.
2. The API creates an S3 multipart upload and returns presigned part URLs.
3. JS queues every part at once while the app is in the foreground, using `File.createUploadTask` with a background session.
4. The server completes the upload using `ListParts`.

JS cannot feed parts in a little at a time. It does not run while the app is suspended, and iOS rate-limits tasks started from the background. The JS task object does not survive the app being killed, and there is no Wi-Fi-only flag. If uploads must be strictly Wi-Fi-only or survive termination, add a small native uploader (about 250 lines) using `allowsCellularAccess=false`. Delete the raw files after packing so the bundle is not stored twice on disk.

### The build loop without a Mac

- **JS/TS changes:** Fast Refresh on the phone through a dev client, with Metro running on Windows-native Node. Metro inside WSL needs mirrored networking or `--tunnel`.
- **Swift changes:** every change is a cloud build.
  - EAS: 10–20 min per medium iOS build, plus queue time and reinstall. ccache does not cache Swift.
  - Free plan: 15 iOS builds a month in the low-priority queue.
  - Starter: $19 a month with $45 credit, then $2 per medium or $4 per large build.
  - Xcode Cloud (25 compute hours a month come with Apple membership) could be a cheaper build lane. Its first workflow must be created in Xcode, which takes one rented-Mac day.
- **CI gate:** a GitHub Actions macOS runner. It runs `expo prebuild`, an unsigned `xcodebuild build`, then `swift test` for the Vision blur and geometry SwiftPM targets with fixture images. Vision exists on macOS, but its results can differ from iOS, so keep the on-device self-test too. macOS runners are free on public repos; private repos pay about $0.062/min.
- **Pure Swift maths** (stdlib SIMD, no ARKit/UIKit/`import simd`) can also be tested with the Swift toolchain on Windows or WSL.
- **Debugging:**
  - Use `os.Logger` with a subsystem; `print` does not reach the device log.
  - An in-app log ring buffer and debug screen showing tracking state, keyframe processing time, memory, thermal state and dropped frames.
  - `pymobiledevice3` syslog and `crash pull` on Windows.
  - EAS Observe (native crash reporting, in preview) or Sentry. Check that dSYM symbolication works.
- **Fallback:** rent a cloud Mac (Scaleway M4 is about €0.22/hour) for Xcode, Simulator or Instruments days. A cloud Mac cannot practically debug your physical phone, because pairing needs USB, again after every reboot. If blind native debugging costs more than about a day a week, a used Apple-silicon Mac mini pays for itself.
- **Distribution:** internal TestFlight (up to 100 App Store Connect users) skips review. External TestFlight needs Beta App Review of the first build. Ad hoc builds need each device's UDID registered with `eas device:create` and Developer Mode on the phone.

### Platform timing

- **Expo SDK.** SDK 57 is current (React Native 0.86). SDK 58 has been in beta since 15 Sep and is close to stable. Start the spike on 58 if it has shipped. Otherwise write the module scene-aware from day one: no `keyWindow` or AppDelegate assumptions.
- **Xcode requirement.** Expect an Xcode 27 / iOS 27 SDK upload requirement around April 2027.
- **CocoaPods.** CocoaPods trunk becomes read-only on 2026-12-02, so keep third-party pods out of the module.
- **iOS versions.** iOS 26.4–26.6.0 had a reported LiDAR world-tracking drift regression. Map on 26.6.1 or later, and record `os_version` and `device_model` with every segment's drift.

### Screen detection

Apple Vision has no screen detector. Options:
- Apple's MIT-licensed Core ML YOLOv3: old and large, with unknown recall on phones.
- RF-DETR N/S/M/L (Apache-2.0). Its other sizes use the PML licence.
- D-FINE (Apache-2.0).

Never use Ultralytics YOLO, which is AGPL-3.0 including its weights. Record the model's licence in ADR 0005 and benchmark it on fixture images.

### Rejected alternatives

- **Pure Swift with no Mac:** every UI change becomes a cloud build.
- **Flutter + Codemagic:** needs the same Swift, shares no TypeScript, and has no official hot reload to an iPhone from Windows.
- **Unity AR Foundation:** Unity Personal excludes non-game apps, so this would need Pro at $210/month, and there is no MapLibre.
- **xtool:** Xcode licence problems.

### Phase 1 spike (1–2 weeks), with exit criteria

1. Measured native build-to-device loop time.
2. ARKit + Vision + JPEG throughput at the target keyframe rate, without dropped frames or thermal throttling over a 3-minute walk.
3. Memory use when going from capture to the draft map and back to capture again.
4. Floor-plan preview latency in Hermes.
5. A privacy self-test that passes on the device.
6. The anchor-registration approach from section 4 working on a real door.

If the Swift core turns out to be unworkable without a Mac, only that module needs a Mac workflow. The TypeScript app stands either way.

## 3. Backend: Go for every server component

### Why Go rather than Node

Performance alone does not decide it:
- The public map is a CDN-cached file.
- Bundles go straight from the phone to S3.
- Moderation traffic is a handful of people.

Go wins on four points that matter here:
1. CPU-bound pipeline glue (PLY parsing, 16-bit PNG decoding, least-squares fits) uses every core without fighting an event loop.
2. Localization: `onnxruntime-node` runs inference on the JS main thread. With Node you would need worker threads, each loading its own copy of models of up to about 0.9 GB.
3. pgx is solid on PostGIS, while TypeScript ORMs barely know it. Drizzle only predefines `point`.
4. A single static binary, which builds natively on Windows with `CGO_ENABLED=0`.

The usual argument for all-TypeScript is weaker than it looks. The shared routing code runs only on the clients. Everything that crosses into the server is a data contract that Swift (the bundle writer) and SQL (the snapshot writer) must also read, so it needs a language-neutral schema anyway.

**Fallback if you want one language:** Node 24 (or Node 26 once it becomes LTS on 28 Oct), Fastify 5, Kysely with raw SQL plus `ST_AsGeoJSON`, pg-boss or River's TypeScript client, and zod. Localization should stay in Go even then.

### Components

**`services/api`:**
- Ingest: create the multipart upload, presign the parts, complete the upload. Insert the `captures` row and enqueue validation in one transaction.
- Moderation.
- `GET /map/latest`.
- The router is stdlib `ServeMux` plus the oapi-codegen strict server.

**Data:**
- Use pgx v5 + sqlc. Geometry crosses the boundary as GeoJSON text, with explicit casts in every query. sqlc's analyser does not know PostGIS functions, and open bugs affect geometry type overrides.
- Metric work stays in PostGIS: `ST_Transform(..., 3414)`, `ST_Union`, `ST_Length`.

**Migrations:** goose, with plain SQL files embedded in the binary. Atlas Community cannot run `CREATE EXTENSION`.

**Jobs:** River (MPL-2.0, still pre-1.0).
- Chain pipeline steps with `JobCompleteTx` plus `InsertTx`.
- Use the River UI for operations.
- River Pro (workflows, concurrency limits) is not needed.

**Snapshot writer:**
- One SQL query per layer using `ST_AsGeoJSON(t.*, id_column => 'id')`. This needs PostGIS 3.5 or later, so pin `18-3.6`.
- Validate the output against `contracts/schemas/snapshot.schema.json`.
- Publish order:
  1. Build the snapshot inside the approval transaction.
  2. Upload it to a content-addressed key.
  3. Commit.
  4. Update a short-TTL `latest.json` pointer.
- Serialize publishes. With an async snapshot job, two close approvals can interleave.

### Contracts

`contracts/openapi.yaml` (OpenAPI 3.1) references `contracts/schemas/*.schema.json` (JSON Schema 2020-12): the snapshot, the bundle manifest/anchors/tags/pose lines, the diff format, the status overlay and the routing config.

Code is generated in one direction:
- Go: oapi-codegen.
- TypeScript: openapi-typescript + openapi-fetch.
- Swift Codable types: quicktype.

CI runs `gen` and then `git diff --exit-code`. A Go integration test using testcontainers and real City Hall coordinates writes a golden snapshot. The TypeScript routing tests read the same file, so the producer and the consumer are tested against one artifact.

### Rules to write into CLAUDE.md

- The API module is pure Go, with no cgo. cgo (ONNX Runtime, PoseLib, GEOS) is allowed only in worker and localization images, which are built in Linux containers.
- Never parse the localization photo with `ParseMultipartForm`, which writes parts larger than its memory limit to temp files. Accept a raw `image/jpeg` body under `http.MaxBytesReader`.

## 4. Processing pipeline without Python

| Step | Runs in | Notes |
| --- | --- | --- |
| Ingest and validate | Go (stdlib) | Validate against the contracts schemas. Check frame counts, timestamps that only increase, and the share of frames with `limited` tracking. Recompute `drift_m`. Enforce size and count limits, reject `..` paths and fuzz-test the validator. This replaces the backlog's Python validator. |
| Privacy re-check | Go + onnxruntime_go (CPU) | Faces: YuNet (MIT; run it on tiles or at several scales, since it covers about 10–300 px). Screens: RT-DETR (Apache-2.0, COCO tv/laptop/cell phone). Treat a detection as a miss only if the region is still sharp (variance-of-Laplacian test). |
| Trajectory clean-up | Go | Drop `limited` frames and split the trajectory at relocalization jumps |
| Align + georeference | Go + gonum | One network adjustment instead of a per-segment fit (see below) |
| Extract | Go + PostGIS | Floor polygons: transformed floor faces → `ST_UnaryUnion` → buffer out and back in → simplify → `ST_MakeValid` (or a Go raster). Centrelines: the corrected walk path, simplified, with tags snapped onto it. `CG_ApproximateMedialAxis` (SFCGAL) only for wide halls. Levels: cluster floor heights. |
| Diff | PostGIS + Go | Match against HEAD with `ST_DWithin` in SVY21, Hausdorff distance and symmetric-difference area. Keep existing IDs where features match (see 7.5). |
| Index for localization | Go + ONNX | Phase 4 |

**Server-side SfM is probably not needed for the MVP.** Published ARKit LiDAR drift is about 0.1–1% of the distance walked. That evidence is weak, though: it comes from closed loops and motion-capture rooms, where ARKit corrects itself on revisit. "Sub-metre after anchor correction" is a hypothesis for Phase 2 to test. Keep COLMAP 4.x (BSD licence) as a command-line tool in Docker, driven from Go with ARKit pose priors. Switch it on only if one of these happens:
- more than about 20% of segments drift over 1 m;
- network residuals exceed 1–2 m;
- overlays cross walls.

Open3D/TSDF re-meshing is dropped: apply each segment's correction to the ARKit mesh instead. Nothing in the MVP pipeline needs a GPU; one CPU VM, or your PC under WSL/Docker, is enough for the pilot.

**Network adjustment.** Most segments have zero or one street-facing anchor, so a per-segment 2D similarity fit (the current backlog task) is under-determined. A similarity fit also adds a free scale term that LiDAR does not need. The replacement:
- Unknowns: x, y, z and yaw per anchor. ARKit is gravity-aligned, so roll and pitch don't drift.
- Each segment gives one relative constraint between its anchors.
- Street anchors are absolute priors with metre-level sigma.
- Ordinals are soft height priors.
- Solve with Gauss-Newton on dense gonum matrices. Fewer than 800 unknowns per cluster solve in milliseconds.
- Spread each segment's end correction along the walk by distance.

Rewrite the backlog test as a chain of 4 synthetic segments where only the ends are surveyed.

**The hinge problem: must solve in Phase 2.** Each ARKit session picks an arbitrary heading. If an anchor is just "the phone's pose when I tapped", consecutive segments rotate freely at shared anchors, like a hinge, and the adjustment is under-determined. The on-device drift check has the same dependency. The same anchor tapped twice also differs by roughly 0.5–1 m and several degrees, which is as large as the drift being measured. Pick one or more of these:
- `ARWorldMap` relocalization at the start anchor;
- one continuous session across consecutive segments;
- an `ARImageAnchor` on a permanent sign (gives a repeatable 6-DoF pose);
- relative pose from the anchor photo plus depth, which brings a small ALIKED/LightGlue step forward into Phase 2.

Define an anchor as a physical feature (a floor point at a door threshold plus the door normal, or an image anchor), not as a phone pose.

**Logged poses vs ARKit's later corrections.** `camera.transform` values in `poses.jsonl` are snapshots that jump at loop closures, while ARKit later refines anchors and mesh anchors. The path and the mesh can disagree. Add ARAnchors at keyframes and re-read their transforms at session end, and bump `schema_version`.

**Street anchors are not "surveyed".** OneMap search returns address and building points, not door positions. Better sources:
- LTA's MRT Station Exit GeoJSON on data.gov.sg (open licence, refreshed every 6 months) for City Hall and Esplanade exits;
- phone GNSS fixes at street exits, added to the bundle with their accuracy;
- careful placement on imagery.

Require at least two widely spaced street priors per connected group of segments before it can be published.

## 5. Localization (Phase 4; build nothing now)

**Stack:**
- A Go service: onnxruntime_go (CPU execution provider first), using `DynamicAdvancedSession` so goroutines can share a session, and with intra-op threads set explicitly.
- Models, all with permissive licences for code and weights:
  - Retrieval: MegaLoc (MIT; DINOv2 backbone Apache-2.0). An official `megaloc.onnx` exists. Indoor R@1 is 87.7, against 69–73 for EigenPlaces, SALAD and MixVPR.
  - Matching: RaCo-ALIKED or ALIKED (BSD-3) with LightGlue (Apache-2.0), exported with LightGlue-ONNX v3.0.
- Pose: PoseLib (BSD-3) behind a cgo shim of about 100 lines. Robust focal-length estimation is only on master, so pin a commit or wrap p4pf.
- 3D points come from each keyframe's LiDAR depth plus its refined pose, so the index needs no SfM. Depth is only good to about 5 m: raycast into the fused mesh and use the confidence map, because distant shopfronts will often have no depth.
- Keep an in-memory index per `map_version` (snapshots are immutable). pgvector is optional at this scale: HNSW cannot index 8448 dimensions without quantization.

**Licences to avoid:**
- SuperPoint and SuperGlue: Magic Leap non-commercial, including the `superpoint_lightglue` ONNX files.
- SALAD: GPL-3.0.
- MixVPR: no licence file.

Add a model allow-list check to CI. MegaLoc's training data (ScanNet, MSLS) has research-only terms. That only matters if an agency adopts the project or it goes commercial, but get it reviewed then.

**Latency.** The first estimate (0.8–2.7 s on CPU) was refuted. Running LightGlue at 1024 keypoints costs about as much per pair as MegaLoc, so matching 10–20 candidates on 8 vCPUs takes several seconds. Design for:
- 3–5 candidates;
- about 512 keypoints;
- level, position and heading pre-filters;
- gravity from DeviceMotion, which allows upright 2-point solvers;
- early stopping;
- a retrieval-only fallback answer when the matching budget runs out.

Benchmark on Funan data. Move to a GPU only if p95 exceeds 3 s. An always-on g4dn in Singapore costs about $540 a month on demand, and scale-to-zero breaks the 3 s target because of model load time.

**Python.** Separate extractor and matcher ONNX files, needed so keyframe features are computed once, require custom export code using LightGlue-ONNX's Python exporter. That is the main reason for question 2.

**Browser-side extraction** (only descriptors leave the phone): keep it as an experiment, not the MVP default.
- MegaLoc (458 MB) does not fit in the browser.
- The `raco_aliked` export needs opset 20, while ORT WebGPU implements GridSample only for opsets 16–19, so those nodes fall back to WASM.
- Descriptors are partly invertible, so they need the same never-store, never-log rule as photos.

Accept a "features" payload in the API from day one anyway.

**Privacy path:**
- Raw body only; never write it to disk.
- Turn off proxy request buffering.
- No body capture in APM or Sentry.
- Core dumps off.
- Never log IP together with position.
- Keep the API hostname DNS-only, not proxied through Cloudflare, or query photos are TLS-terminated at Cloudflare's edge.
- A test that asserts no temp files and no body bytes in logs.

**Abuse:** per-IP rate limits, a bounded concurrency queue with fast 503s, and size caps.

**Gaps in the spec:**
- **Mapper mode.** The spec's "test a photo locate against the draft, immediately" needs either a private draft index on the server or an on-device path.
- **Shutters.** The "capture early mornings" mitigation means shops are shuttered at capture time, while users query by day. Capture during opening hours on quiet weekday mornings, or capture both states.
- **Focal length.** Browser photos often lack a usable EXIF focal length. Read it before the client-side resize if it is there, and estimate it otherwise.

**Lock in now:** the bundle stores intrinsics with image resolution and orientation, depth intrinsics, the confidence maps, refined poses and the mesh.

## 6. Infrastructure, data and auth

**Pattern:** AWS Singapore holds the private data and the backend. Cloudflare serves everything public (the static webapp, immutable snapshots, blurred landmark crops) with free egress.

**Private storage.** R2 cannot be pinned to Singapore: `apac` is only a best-effort location hint, and its only jurisdictions are EU, FedRAMP and US. So raw bundles go to S3 in ap-southeast-1, with Block Public Access and encryption on.
- Keep bundles in S3 Standard until the pipeline settles. Glacier Instant Retrieval charges for retrieval and has a 90-day minimum, which hurts while early algorithm changes mean frequent re-runs.

**Always-on box.** A Lightsail x86 server in Singapore: $24/mo for 4 GB, or $44/mo for 8 GB.
- It runs the Go API, PostGIS, River and Caddy.
- It must be x86, because the official `postgis/postgis` image is amd64-only.
- Lightsail CPU is burstable (20–30% baseline), which is fine for the API and database, but localization needs its own non-burstable compute in Phase 4.
- Back up with WAL-G or pgBackRest to S3 and run a restore drill. Version history must survive, because rollback depends on it.
- Lightsail may not support IAM instance roles (verify). If so, presigning needs scoped, rotated keys, or use EC2 with an instance profile.

**GPU (only if SfM becomes necessary):**
- AWS Singapore sells T4-class only: g4dn spot is about $0.24/h and on-demand $0.736/h. g5g (Graviton2 with a T4G) spot is about $0.08/h.
- New accounts start with a G-instance quota of zero, so request an increase early.
- Fallback: Cloud Run Jobs with an L4 GPU in asia-southeast1, about $1.12/h for the minimum shape, with no quota ticket.
- Fly.io GPUs are retired. DigitalOcean, Hetzner and RunPod have no GPUs in Singapore.

**OneMap:**
- Raster tiles only. No token is needed for tiles; the API token lasts 3 days, so keep it server-side and refresh it.
- The official style JSON has `mapbox://` glyph URLs, which break MapLibre text layers, so `packages/map-style` uses its own glyphs.
- Tiles are served with `Content-Type: image/undefined`; test this.
- TileJSON says maxzoom 19 while the style says 20; indoor zooms will overzoom.
- Render the exact logo and attribution snippet.
- Email SLA before any tile caching or offline packs. The API terms and the Singapore Open Data Licence allow adapting the data with attribution.

**Auth:**
- Singpass requires a Singapore-registered entity (UEN). Private companies can onboard, but individuals cannot.
- Better Auth (MIT) gives email one-time codes and passkeys. A Go API verifies its JWTs through JWKS, but it adds a Node service. go-webauthn plus your own email codes means more security-critical code to write.
- Native passkeys in Expo need associated domains and a native module.
- Recommendation: defer real accounts until external contributors join. Until then, one owner account with a per-device token in the Keychain is enough.

**Local development:**
- MinIO community edition is archived (no maintained binaries or images). Use RustFS 1.0 (Apache-2.0) or SeaweedFS.
- LocalStack needs an auth token.
- Pin `postgis/postgis:18-3.6`. The `17-3.5` tags are on Debian bullseye with GEOS 3.9, and bullseye LTS ended 2026-08-31.
- Use pnpm workspaces with Turborepo (`experimentalGoWorkspaces`) and a root `go.work`. Use Taskfile rather than make for scripts that must run on Windows.
- Recommendation: keep the repo on the Windows filesystem, with Docker Desktop on the WSL2 backend. Run Expo/Metro and API builds from Windows-native Node and Go, and run cgo workers in containers. The alternative is moving the repo into WSL, which gives faster Docker bind mounts but needs mirrored networking for the phone.

**Rough monthly cost:**

| Item | Phases 1–3 | Phase 4 |
| --- | --- | --- |
| Apple Developer Program | $99/yr | $99/yr |
| EAS Starter (during native work) | $19 | $0–19 |
| Lightsail box | $24–44 | $24–44 |
| Localization compute (non-burstable, about 8 vCPU) | – | ~$40–80 (unpriced; benchmark first) |
| S3 + backups | ~$2 | ~$2–5 |
| GPU batch (only if SfM is needed) | $0–15 | $0–15 |
| Cloudflare, email, domain | ~$1–2 | ~$1–2 |
| **Total** | **≈ $45–80** | **≈ $70–165**, or about $540 more for an always-on GPU |

## 7. Spec, schema and bundle issues, independent of the stack

High severity:

1. **Georeferencing and anchors.** The per-segment fit can't work, and anchors aren't repeatable (section 4). `drift_m` is null for every new end anchor, which is most anchors during initial mapping. Define exactly when drift can be computed: an existing end anchor, a walk back to the start, or ARWorldMap relocalization. Add a `segment_alignments` table for transforms and residuals.
2. **Levels.** The spec line "B2 means the same height everywhere" is physically false, and street level differs across the cluster too. `UNIQUE(venue_id, ordinal)` forbids mezzanines and split levels.
   - Add `levels.elevation_m`, keep the ordinal as a display band, and make `UNIQUE(venue_id, name)`.
   - Routing must never infer connections from equal ordinals.
   - Store `anchors.level_id`.
   - Map the band onto IMDF's per-building ordinals on export.
3. **Routing correctness.**
   - Nothing stops a route from crossing an MRT paid area or a link locked at night. Add `edges.access` (`public | paid_fare_zone | customers_only`) and `edges.opening_hours` (OSM syntax), evaluated in Asia/Singapore time.
   - Escalators can be marked `step_free`. Add a CHECK and exclude escalators in step-free mode.
   - Document the vertical-connector convention: connector edges between landing nodes; lifts as one node per stop with a boarding penalty; `oneway` means from→to; an optional schedule for reversing escalators.
   - Express cost in seconds, not mixed units.
4. **Versioning concurrency and ID stability.**
   - Change sets have no base version, so two approvals against version N can overwrite each other. Add `change_sets.base_version_id`, a `rev` column on HEAD rows, and a single-row `map_head` table locked during approval; conflicting change sets become `needs_rebase`.
   - Re-scans produce new UUIDs, so the diff shows remove + add instead of a move, which breaks status edits and `anchors.node_id`. Conflate against HEAD to keep IDs.
   - Phone drafts need a `server_id` mapping.
   - Write `docs/diff-format.md` with a schema.
5. **Rollback fidelity.** Public snapshots lack anchors and internal fields, so "restore HEAD from snapshot" loses data. Keep row history (`valid_from_version`/`valid_to_version`) or a private full export per version. Tie the localization index to the published version, so rollback also rolls back localization. Index only after approval: the architecture diagram currently feeds the index before moderation.
6. **Moderation policy is inconsistent.**
   - CLAUDE.md says the owner is the only exception to review; the spec also lets trusted contributors auto-publish status edits.
   - The schema CHECK passes any `auto_published` row, and any row with a NULL reviewer.
   - `CHECK (track = 'status' OR capture_id IS NOT NULL)` forbids structural edits that have no capture (moving a node, moderator fixes), and a mapper batch spans many captures.
   - Fixes: a `publish_path` enum enforced by a trigger on trust tier; a `change_set_captures` join table; a `manual_edit` change set without a capture; automated gates that run even on the owner path (privacy re-check, `restricted_zones` clipping, residual thresholds); passkeys or 2FA for owner and moderator accounts; an append-only `moderation_events` table.
7. **Privacy: the blur pipeline.**
   - Rejecting a whole bundle for any unblurred face will reject most mall bundles, because of posters, ads and mannequins, and the server detector differs from Vision. Instead, quarantine individual frames and send borderline cases to the moderator, failing a bundle only above a threshold.
   - Define blur as irreversible (solid fill or 16 px+ pixelation over a padded box).
   - Blur heads from human rectangles as a second net.
   - Record per-frame blur boxes in the bundle.
   - Test fixtures: a poster face, a small far face, the back of a head, a phone screen.
   - Decide what "screen" means (question 12).
8. **Privacy: the localization path.** See section 5. IP + time + position together count as location personal data.

Medium severity:

9. **OSM import.**
   - A bounding-box import will duplicate indoor links that OSM already maps (`tunnel=yes`, `indoor=*`, negative `level`/`layer`). Filter those out, and drop ways inside venue footprints.
   - `osm_footpaths` stores ways with no topology, so exits cannot join the street network. Build a street graph keyed by OSM node ID and generate exit-to-footpath connector edges in SVY21.
   - Ship the street graph as a separate ODbL snapshot file, so the indoor data can stay a separate database under OSMF's collective-database guideline. Get legal review.
10. **Floor-plan quality.** Useful LiDAR range is about 5 m, so one pass through a wide hall gives a strip, not the hall. Glass and polished floors create holes, and escalators and crowds get meshed. Mark the preview as approximate, drive the coverage overlay from cells never observed, add a "zig-zag through wide halls" capture guideline, and make redraw a first-class part of the draft flow. Server extraction is the authority.
11. **Status edits.** These currently create full structural versions. Publish them as a separate short-TTL overlay file (`valid_from`/`valid_until`, keyed by stable IDs) with a `status_reports` table, so rolling back a structural change doesn't undo unrelated "lift down" reports.
12. **Other image paths.**
    - Landmark crops for directions and status evidence photos are outside the blur-on-phone rule. Re-encode them to strip EXIF, blur people, approve crops one by one, and keep crops in a separate public bucket.
    - Keep evidence private and time-limited.
    - Ask landlords whether permission to scan also covers publishing photos.
    - Contributor trajectories (poses, IMU, timestamps) are personal data. Add a privacy notice and a retention rule for raw bundles.
13. **Capture-bundle gaps.**
    - Missing fields: image resolution and orientation for the intrinsics, depth intrinsics, the time base of `t`, the IMU line format, a per-file sha256, the PLY classification property name.
    - `toilet` is a tag kind but not a `node_kind`; add tag `type: node|poi`.
    - Add `gnss.jsonl` and per-frame blur boxes.
    - Choose the container: uncompressed tar split into 16 MB parts, or zip with STORE if ingest needs range reads.
    - Set `contributor_id` from auth, not from the manifest.
    - Drafts need a table and access rules.
    - Auth must exist before `POST /captures` goes live.
14. **Scope.** "Every public level" literally includes Funan's and Raffles City's upper retail floors. Restrict it to levels on the pedestrian network: basements, street level and link bridges, plus the connectors between them (question 7).

Low severity, one consistency pass:

- The spec says `gate`; the schema says `fare_gate`.
- `MapVersion.changeset_ids` vs `change_sets.map_version_id`.
- The spec's anchor `photo` vs the schema's `photo_uri` (anchor photos may need to stay private).
- No column for residuals.
- `nodes.ordinal` has no trigger keeping it in step with `levels`.
- Edges have no `level_id`.
- The diagram says processing does "blur".
- Three trust tiers in the spec, four in the schema.
- `venues.owner` is easily confused with the project owner; rename it `operator`.
- OneMap has no vector tiles and its maxzoom is about 19–20.
- Define the snapshot format (7-decimal coordinates, brotli, per-cluster files behind a manifest) in `docs/snapshot-format.md`.

## 8. Doc changes once the decisions are made

- **CLAUDE.md:**
  - Layout: `apps/mapper` (Expo) with `modules/capture-native` (Swift); Go `services/*`; `contracts/`; `packages/{routing,map-style,floorplan,api-client}`; `db/migrations`.
  - Environment: EAS, a dev client, macOS CI, the Metro networking note.
  - Rules: no cgo in the API; the localization no-temp-file test; the blur test in CI for module image code.
  - Remove "keep the iOS port in step".
- **spec.md:** the tech stack table and its intro sentence; the capture app section; the Mapper mode map line; processing steps 3–5; the architecture diagram (no "blur" in processing; index only after approval); the level/ordinal sentence; scope; moderation tracks; the localization fallbacks.
- **ADRs:**
  - Amend 0001 (Expo + Swift module, DOM-component map).
  - Amend 0002 (models, licences, Go + ONNX + PoseLib, the privacy path).
  - Amend 0003 (shared TS router, access and opening hours, cost in seconds, connector convention).
  - Amend 0004 (concurrency, rev/base version, history, publish order, status overlay).
  - Amend 0005 (blur definition, frame quarantine, the screen detector and its licence, the localization path, other image paths, trajectories).
  - Add 0006: backend in Go.
  - Optionally add 0007: Expo native boundary and the upload strategy.
- **backlog.md:**
  - Workspaces: go.work + pnpm.
  - Alembic → goose; MinIO → RustFS; FastAPI → Go; the Python validator → Go against the contracts.
  - New Phase 1 tasks: contracts package and codegen; Expo scaffold with `eas.json`; the module skeleton; macOS CI; the spike.
  - Owner tasks: Apple Developer Program and an Expo account instead of "get a Mac".
  - Phase 2: network adjustment, anchor registration, gated COLMAP, multipart upload.
- **capture-bundle.md:** everything in item 13, plus the anchor definition; then bump `schema_version`.
- **db/schema.sql:** the data-model fixes above, as the first goose migrations.
- **.gitignore:** Expo entries (`.expo/`, generated `ios/` and `android/`, `*.ipa`, credentials) and Go entries (`bin/`, `coverage.out`). Drop the Python section unless offline tooling is approved.

## 9. Questions for the owner

Architecture-shaping:

1. Backend language: Go for all server code with TypeScript for clients (recommended), TypeScript API with Go only for compute, or all TypeScript?
2. Python: allowed as offline tooling only (model export, evaluation), never in API, processing or localization runtime?
3. Is "no Mac" absolute, or is an escape hatch OK (a rented cloud Mac for occasional days; a used Mac mini if blind native debugging costs more than about a day a week)?
4. MVP contributors: are you the only mapper through Phase 3, with sign-up, trust tiers and external TestFlight arriving in Phase 4?

Product and ops (defaults in brackets):

5. Public or private GitHub repo? [public: free macOS CI; no secrets go in the repo anyway]. The folder is not a git repo yet.
6. Webapp: Vite SPA or Next.js? [Vite SPA on Cloudflare; moderation UI as an authenticated route]
7. Level scope: pedestrian-network levels only? [yes]
8. Routing: avoid MRT paid areas and respect link closing hours in the MVP? [yes]
9. Auto-publish: should trusted contributors' status edits skip review, or only the owner's mapper-mode work? [both, as separate enforced publish paths, with status as an overlay]
10. Data residency: private data in Singapore, public non-personal files on Cloudflare's global edge? [yes]
11. Budget ceiling per month before Phase 4, and CPU-first localization with a GPU only if p95 exceeds 3 s? [about $80 a month; CPU first]
12. "Screens" to blur: personal devices only, or also ad and signage displays (which are useful localization landmarks)? [personal devices plus any screen showing people]
13. Can capture happen during opening hours (shops open) on quiet weekday mornings? [needed for localization]
14. Hardware and accounts: which LiDAR device and iOS version? Do you have Apple Developer Program and Expo accounts?
15. Does landlord permission cover publishing photos (landmark crops)? If not, drop landmark photos from the MVP.
16. Still open from the spec: side project or agency pitch; data licence (now with the option of OSM as a separate ODbL file); who moderates.
