# Backlog

Tasks for phases 1 and 2 of the MVP (see "Milestones" in [spec.md](spec.md)). Tick items off as they land; add new ones where they belong. **[Owner]** marks tasks only Josh can do; everything else is code Claude Code can pick up. Each task names the package or service it lives in and should fit in one session; split it if it doesn't.

The stack was decided on 2026-10-12: see ADRs [0006](decisions/0006-typescript-backend.md) to [0009](decisions/0009-hosting-and-budget.md), with background in the [stack review](reviews/2026-10-12-stack-review.md). Through Phase 3 everything runs on the owner's Windows PC (Docker Desktop on WSL2), and the phone uploads over home Wi-Fi on the LAN.

Test fixtures: the repo will be public. Fixtures in git are synthetic, recorded where the owner is happy to publish them (with no images or GNSS fixes), or images used with the subject's consent or under an open licence. Nothing recorded in a venue goes in git (meshes, pose tracks, keyframes, `restricted_zones` outlines): keep it in the git-ignored `.data/fixtures/`, and tests that need it skip when it is absent. Only committed fixtures run in CI.

## Phase 1: Groundwork

Gate: one venue gives written permission to scan. **Met on 2026-10-15: Funan's landlord gave permission.** Nothing inside any other venue is scanned before that venue says yes too.

### Owner tasks

- [ ] [Owner] Site walk of the City Hall cluster: confirm the boundary and list every public level on the pedestrian network (basements, the street-level floor, link bridges and the vertical connectors between them), every exit and every link
  - Also note each link's and exit's opening hours, where MRT paid areas start (fare-gate lines), back-of-house and service areas next to public walkways (for `restricted_zones`), and when shops open
  - Choose the height datum: a reference street-level floor that `levels.elevation_m` is measured from. Record it in [spec.md](spec.md)
- [x] [Owner] Permission request to Funan's landlord for the B2 UPL (granted 2026-10-15). Keep the letter out of the repo; the seed script records only a reference to it in `venues.permission`
- [ ] [Owner] Record the scope of Funan's permission: which areas, any conditions (times, notice, escort), and whether it covers publishing photos; if it doesn't, landmark photos stay out of the MVP
- [ ] [Owner] Permission requests to Raffles City and CityLink, asking the same photo question
- [ ] [Owner] Ask the MRT operator and LTA about scanning the City Hall and Esplanade station concourses
- [ ] [Owner] Register a OneMap API account (needed for the search API; tiles need no token) and check the terms for tiles and attribution. Email SLA about overlaying the map on OneMap tiles and about tile caching or offline packs, which need SLA's written permission first
- [ ] [Owner] Decide the map data licence: ODbL or not, now with the option of shipping the OSM-derived street graph as a separate ODbL file, `street.json` (see [0003](decisions/0003-routing.md)). The separate-file approach needs legal review
- [ ] [Owner] Create the public GitHub repo, or approve Claude Code creating it. Check that `.env` files are git-ignored before the first push
- [ ] [Owner] When the Swift spike starts: join the Apple Developer Program (US$99/yr) and create an Expo account
- [ ] [Owner] Before the first recorded bundle reaches the PC: turn on disk encryption (BitLocker, for example) for the drive that holds the Docker data (PostGIS, RustFS) and for the backup drive ([0009](decisions/0009-hosting-and-budget.md))
- [ ] [Owner] Register the iPhone 17 Pro Max for development builds (`eas device:create`) and turn on Developer Mode on the phone
- [ ] [Owner] Keep the iPhone on current iOS, avoiding iOS 26.4–26.6.0 (reported LiDAR world-tracking drift regression). Check before the spike and before each capture day

### Repo and data

- [x] Monorepo scaffold per `CLAUDE.md` (repo root): pnpm workspaces + Turborepo, TypeScript strict, Vitest, lint and format (Biome), `.editorconfig`, `.gitattributes`, GitHub Actions CI running lint, typecheck and tests on Ubuntu and Windows
  - Done when: a fresh clone installs and passes lint, typecheck and tests on Windows-native Node, and in CI once the GitHub repo exists
  - Checked with throwaway packages (TypeScript 7, `.ts` imports across packages, Vitest 5, Node running `.ts` directly); CI first runs when the repo is pushed
- [ ] `docker-compose.yml` with `postgis/postgis:18-3.6` and RustFS (SeaweedFS as the fallback; MinIO community edition is archived), plus a migrate script that runs dbmate
  - Done when: `docker compose up` followed by the migrate script gives an empty, valid database on Docker Desktop (WSL2 backend), and the local buckets exist
- [ ] Turn `db/schema.sql` (draft v1) into the first dbmate migration in `db/migrations/`. From then on, schema changes are new migrations
- [ ] Seed script (`db/`): the five core venues (`operator`, `permission`, footprint) and their pedestrian-network levels (`name` as the venue signs it, `ordinal` band, `sort_key`; `elevation_m` stays NULL until measured). Names come from the site walk. It writes HEAD directly, so its rows reach the public files only inside a version that publishes a change set (see the moderation rule in `CLAUDE.md`)
  - Done when: it loads into an empty database and running it twice changes nothing
- [ ] OSM import (`services/processing`): fetch footways, pedestrian ways and crossings for the cluster's bounding box (Overpass API) into `street_nodes` and `street_edges`. Filter out ways with `tunnel=yes`, `indoor=*`, a negative `level` or `layer`, and ways inside venue footprints (OSM already maps some underground links). Set `covered` from `covered=yes` plus tunnel, building and roof heuristics; compute `length_m` in SVY21
  - Done when: the import is re-runnable, idempotent, and tested with a small saved Overpass response from the cluster that includes an underground link OSM already maps
- [ ] LTA MRT exit import (`services/processing`): load the City Hall and Esplanade exits from LTA's MRT Station Exit GeoJSON (data.gov.sg, Singapore Open Data Licence) as street-prior candidates (`prior_source = 'lta_exit'`). How they are held before they belong to an anchor is decided in this task
  - Done when: it is re-runnable (LTA refreshes the data every 6 months) and tested with a saved copy of the two stations' exits

### API skeleton (`services/api`)

- [ ] Fastify 5 app on Node 26: health check, config from `.env` (git-ignored; commit an example file), Kysely with raw SQL for geometry (`ST_AsGeoJSON` out, `ST_GeomFromGeoJSON` in), route schemas that reference `packages/contracts`, OpenAPI emitted by @fastify/swagger
  - Done when: the health check reaches PostGIS and RustFS, and the tests run against the compose stack
- [ ] Database rule tests (run against the compose PostGIS, with synthetic fixtures at real City Hall coordinates). Each rule gets a passing and a refused case:
  - `nodes.ordinal` and `anchors.ordinal` stay in step with `levels.ordinal`; `UNIQUE (venue_id, name)` allows two levels in one band; stairs and escalators are never `step_free`
  - publish paths: `owner_mapper` needs tier `owner` and track `structural`; `trusted_status_auto` needs track `status`, tier `trusted`, `moderator` or `owner`, and `valid_until` on every report; `moderator_review` needs a `moderator` or `owner` reviewer who is not the contributor; `decision` and `publish_path` agree
  - no publish path without a `gates_passed` event, or with a failed or privacy-flagged capture, on every path
  - a published change set, its captures and its status reports are frozen; `rejected` and `rolled_back` are final; status change sets have no diff and no version, and only they carry status reports; a structural change set has a version exactly when it is published; every version except a rollback publishes a change set
  - `map_versions` and `moderation_events` refuse UPDATE, DELETE and TRUNCATE; `map_head` cannot be deleted and only moves forward
  - restricted zones: a feature overlapping a zone's interior is refused and one sharing its edge is accepted; a level or venue with zones cannot be deleted; an invalid outline is refused
- [ ] Choose the job queue: pg-boss or graphile-worker (Postgres-backed, no Redis). Record the choice in [0006](decisions/0006-typescript-backend.md), enqueue from `services/api` and run jobs in `services/processing`
  - Done when: a job enqueued in the same transaction as a row insert runs in a separate worker process, never in the API process
- [ ] `GET /map/latest`: metadata for the current version (from `map_head`) and the URLs of its files, for the owner's tools on the LAN (the mapper app and the change-set preview). Public clients read `latest.json`, which can lag `map_head` until the reconcile job runs
- [ ] Snapshot builder: HEAD → `indoor.json` (venues, levels, spaces, nodes, edges, pois, street_connectors) and `street.json` (the OSM-derived street graph), as set out in `docs/snapshot-format.md`; 7-decimal coordinates; validated against the `packages/contracts` schemas
  - Done when: a golden-file test with real City Hall coordinates passes, and the golden files are fixtures that the `packages/routing` tests read too
- [ ] Publish transaction: publishes the change sets it is given (in Phase 1, `owner_mapper` ones with their gate results recorded) and refuses to run with none, except for a rollback. Lock `map_head` (`SELECT ... FOR UPDATE`), build the snapshot inside the transaction, upload it brotli-compressed to an immutable content-addressed path before commit, write the private full export (`private_export_uri`), insert `map_versions` with `snapshot_sha256`, commit, then update the short-TTL `latest.json`. A reconcile job repairs `latest.json` if that last update fails. Writes go through the S3 API (RustFS locally)
  - Done when: tests show two concurrent publishes serialise, and a failed pointer update is repaired by the reconcile job

### Webapp skeleton (`apps/web`)

- [ ] Vite + React SPA with MapLibre GL JS v6, showing OneMap raster tiles centred on City Hall with the exact OneMap logo and attribution
  - Done when: tiles render despite OneMap's `Content-Type: image/undefined` (with a test), and indoor zooms overzoom past the TileJSON maxzoom of 19
- [ ] `packages/map-style`: one MapLibre style for the webapp and the mapper app, with its own glyphs (the official OneMap style's `mapbox://` glyph URLs break MapLibre text) and attribution for OneMap, OSM and the LTA exit data
  - Done when: text layers render with the package's glyphs
- [ ] Load the current version through `latest.json` and draw spaces, nodes and edges for one level
- [ ] Level switcher: the current level in full, other levels faded. Levels are grouped by `ordinal` band and ordered by `sort_key`; connector edges are drawn on both end levels

### Mapper app (`apps/mapper`)

No Mac ([0007](decisions/0007-expo-mapper-app.md)). TypeScript changes reach the phone by Fast Refresh through the dev client, with Metro on Windows-native Node. Swift changes need a cloud build: EAS Build on the Free plan, or `eas build --local` on a GitHub macOS runner. For an occasional Xcode, Simulator or Instruments day, rent a cloud Mac.

The Swift spike (1–2 weeks) runs from the module skeleton to the spike write-up. Its exit criteria:

1. Native build-to-device loop time measured.
2. ARKit + Vision + JPEG throughput holds the target keyframe rate (set in the spike) over a 3-minute walk, without dropped frames or thermal throttling.
3. Memory measured going from capture to the draft map and back to capture.
4. Floor-plan preview latency in Hermes measured.
5. The on-device privacy self-test passes.
6. The anchor-registration approach works on a real door.

Tasks:

- [ ] Expo scaffold: SDK 57 (move to 58 once it is stable), TypeScript, New Architecture, expo-dev-client, Expo Router, `eas.json` with a development profile
  - Needs the [Owner] Apple Developer Program membership, Expo account and device registration
  - Done when: the dev client is installed on the iPhone and a TypeScript change reaches it by Fast Refresh from Metro on Windows
- [ ] `capture-native` module skeleton (`apps/mapper/modules/capture-native`): a local Expo module in Swift on the stable Expo Modules API, with `getCapabilities()` and a `<CaptureView>` showing the camera. Scene-aware from the start (no `keyWindow` or AppDelegate assumptions), no third-party pods, pure-maths Swift in SwiftPM targets without ARKit, UIKit or `import simd`, and `os.Logger` rather than `print`
  - Done when: `getCapabilities()` reports LiDAR on the iPhone 17 Pro Max, and the build-to-device loop time is measured (criterion 1)
- [ ] macOS CI job (GitHub Actions, for `capture-native`): `expo prebuild`, an unsigned `xcodebuild build`, then `swift test` for the SwiftPM targets with fixture images
  - Done when: a Swift compile error or a failing `swift test` fails CI
  - Also compile `packages/contracts/generated/swift/CaptureBundle.swift`: nothing compiles the generated Swift before this job exists
- [ ] Debug screen (`apps/mapper` and the module): an in-app log ring buffer, plus tracking state, keyframe processing time, memory, thermal state, dropped frames and free disk. Write down how to pull the syslog and crash logs with `pymobiledevice3` on Windows
- [ ] Native crash reporting: EAS Observe or Sentry (chosen in this task)
  - Done when: a deliberate native crash shows up symbolicated (dSYMs work)
- [ ] ARKit session and live mesh (module): `CaptureSession` with `start`, `stop` and `discard`; ARSession with `sceneReconstruction = .meshWithClassification` and `frameSemantics = .smoothedSceneDepth`; live mesh overlay in `<CaptureView>`; `onStatus` at about 5 Hz, `onTrackingChange` and `onWarning`. Nothing per frame crosses into JavaScript
- [ ] Keyframes (module): selection that copies the pixel buffer and releases the ARFrame at once, skipping keyframes under backpressure; 16-bit depth PNG, confidence PNG, `poses.jsonl` and `imu.jsonl` writers; an ARAnchor per keyframe, re-read at session end into `refined_keyframes.jsonl`. Keyframe JPEGs are written only through `writeBlurredJPEG` (next task)
- [ ] Face and head blur (module): one `writeBlurredJPEG` choke point, writing a 3-component colour JPEG with no thumbnail or second image ([capture-bundle.md](capture-bundle.md#keyframes-depth-and-confidence)); Vision faces plus the head region of every detected person (`VNDetectHumanRectanglesRequest`); irreversible blur (solid fill, or pixelation with cells of 16 px or larger, over a padded box); boxes per keyframe in `privacy/blur.jsonl`; `blurPhoto(src, dst)` and `privacySelfTest()`
  - Done when: `swift test` passes on the macOS runner with fixtures (a poster face, a small far face, the back of a head; images used with consent or under an open licence, see the fixture rule above), and `privacySelfTest()` passes on the iPhone (criterion 5)
- [ ] Screen detector (module): choose a permissively licensed Core ML model by a fixture benchmark (candidates: Apple's MIT YOLOv3, RF-DETR N/S/M/L Apache-2.0, D-FINE Apache-2.0; never Ultralytics YOLO, which is AGPL-3.0). Blur personal devices plus any display showing people. Record the model and its licence in [0005](decisions/0005-privacy-by-design.md); converting the model is offline tooling
  - Done when: a phone-screen fixture is blurred in `swift test` and in `privacySelfTest()`
- [ ] Anchor registration experiment (module and app) on a real door the owner may scan (venues need permission first): `markAnchor` for `floor_point` (ARKit raycast to the floor at the threshold, plus the facing direction) and `image_anchor` (`ARImageAnchor` on a permanent sign), each with a reference keyframe. Try `ARWorldMap` relocalization at the start anchor first, then the other candidates in [0008](decisions/0008-anchors-and-georeferencing.md)
  - Done when: the spread of the same anchor marked in separate sessions is measured, and one approach works (criterion 6)
- [ ] Tags (app and module): tag buttons while walking, for nodes (exit, entrance, escalator, lift, stairs, travelator, ramp, fare gate, door) and POIs (toilet, shop and the other `poi_category` values), positioned from the current pose by `addTag`. `type` is `node` or `poi`, so a toilet is a POI. Escalators, stairs, lifts, travelators and ramps are tagged at each landing: each end, or each lift stop
- [ ] Bundle JSON (`apps/mapper`): `manifest.json` (with the `files` list the module reports), `anchors.json` and `tags.json`, written from the `packages/contracts` types to [capture-bundle.md](capture-bundle.md) (`schema_version` 1)
- [ ] Bundle writer and `packBundle` (module): `mesh/scene.ply` (binary little-endian, vertices in the ARKit world frame read at session end, per-face `uchar classification`); bytes and sha256 for every file; `packBundle(dir, partBytes)` packs an uncompressed tar in 16 MiB parts (`UPLOAD_PART_BYTES` in `packages/contracts`) and deletes the raw files after packing
  - Done when: a bundle recorded on the phone and copied to the PC passes the validator CLI on Windows
- [ ] Floor-triangle export (module): `floorTriangles` returns floor-classified mesh triangles as a zero-copy `ArrayBuffer` (a `Float32Array` in JS). Save a few recorded meshes as fixtures for `packages/floorplan`, following the fixture rule above: meshes recorded in a venue go in `.data/fixtures/`, never in git
- [ ] Floor-plan benchmark on the phone (`packages/floorplan` in Hermes): time the preview on a recorded mesh (criterion 4). If it takes more than about 2 s, move only the rasterise step into Swift behind the same signature
- [ ] Map in an Expo DOM component (`apps/mapper`): maplibre-gl-js and terra-draw with `packages/map-style`, drawing the floor-plan preview over OneMap tiles with attribution. The map is unmounted on the capture screen. `@maplibre/maplibre-react-native` v11 is the fallback for read-only views
  - Done when: a polygon can be drawn and edited on the phone and in desktop Chrome
- [ ] Spike write-up (`docs/`): run the 3-minute throughput walk (criterion 2) and the capture → map → capture memory check (criterion 3), then write up all six criteria, the chosen keyframe rate, the chosen registration approach, and how much time blind native debugging cost (more than about a day a week means reconsidering a used Mac mini)

### Shared

- [x] `packages/contracts` skeleton and codegen: JSON Schema 2020-12 files are the source of truth; TypeScript types from json-schema-to-typescript, runtime validation with Ajv, Swift Codable types from quicktype
  - Done when: CI regenerates the types and fails on a diff
  - `pnpm gen` writes both, and the CI step runs it on Ubuntu and Windows (first run when the repo is pushed). The schema rules that keep the three tools in step are in `packages/contracts/README.md`
- [x] Capture bundle v1 schemas (`packages/contracts`) from [capture-bundle.md](capture-bundle.md): `manifest.json`, `anchors.json`, `tags.json`, and the lines of `poses.jsonl`, `refined_keyframes.jsonl`, `imu.jsonl`, `gnss.jsonl` and `privacy/blur.jsonl`
- [ ] Snapshot format: write `docs/snapshot-format.md` and schemas in `packages/contracts` for `indoor.json`, `street.json`, `latest.json` and `status.json` (IMDF-like GeoJSON features, 7-decimal coordinates, brotli; versioned files under an immutable content-addressed path; `latest.json` and `status.json` short-TTL, outside versions)
- [ ] Diff format: write `docs/diff-format.md` and its schema in `packages/contracts`, with entries `{op, feature_type, id, base_rev, before, after}`
- [x] Bundle validator CLI (`packages/contracts`): checks a bundle against the schemas and across files (required files present, every file listed in `files` with matching bytes and sha256). Runs on Windows against recorded bundles and is used by ingest. It replaces the planned Python validator
  - Done when: it passes a hand-made minimal bundle and fails each missing required file with a clear message
  - `@usg/contracts/bundle-validator` and `validate-bundle` (see `packages/contracts/README.md`). The minimal bundle is generated in the tests; no recorded bundle exists yet, so the first real run is the `packBundle` task's Done-when
- [x] Validator hardening (`packages/contracts`): size and count limits, reject absolute or `..` paths, stream-parse the PLY with limits, fuzz tests
  - Limits are in [capture-bundle.md](capture-bundle.md#ingest-and-validation); the fuzz tests use fast-check with a fixed seed
- [ ] `packages/floorplan`: floor triangles → walkable polygon (occupancy grid of about 10 cm, morphological close, marching squares, simplify, GeoJSON). Pure JS, because Hermes has no WebAssembly
  - Done when: tests pass on Windows against synthetic meshes in git, and against the recorded meshes when they are present
- [ ] `packages/routing` skeleton: `routing-config.json` with its schema in `packages/contracts` (values are tuned in Phase 3), and a graph built from `indoor.json` and `street.json`. Vertical connectors are edges between landing nodes, never inferred from equal ordinals. The router itself comes in Phase 3
  - Done when: tests build the graph from the snapshot builder's golden files

## Phase 2: Capture pilot (Funan UPL)

Gate: captured segments align end to end on the street map.

### Mapper app (`apps/mapper`)

- [ ] Build out anchor registration (module and app): take the approach the spike chose across consecutive pilot segments, record `registration` in `anchors.json`, and update [0008](decisions/0008-anchors-and-georeferencing.md) with the result
- [ ] On-device drift check: compute `drift_m` only when the end anchor already has a position in the current session's frame (an existing anchor reached through registration, or a walk back to the start); otherwise it is null. Show it with a pass/re-walk prompt. The threshold is a tuning value; start around 1 m and adjust from pilot data
  - Done when: tests cover both the computable and the null case, on synthetic pose tracks in git (recorded tracks follow the fixture rule above)
- [ ] GNSS at street-facing anchors: record fixes with their accuracy into `gnss.jsonl` (`t`, `lat`, `lon`, `h_accuracy_m`)
- [ ] Coverage overlay (`apps/mapper`, `packages/floorplan`): show never-observed cells as gaps to re-walk, and label the preview as approximate
- [ ] Draft store (expo-sqlite): accepted segments and draft features with their own client UUIDs, plus a `server_id` mapping filled in on sync
- [ ] Draft editing (DOM-component map): stitch accepted segments, move nodes, retag, redraw outlines. Redraw is a first-class tool; the server extraction stays the authority
- [ ] Sync refined results into the draft (`services/api`, `apps/mapper`): fetch the aligned segments and extracted features for the owner's captures, fill each draft feature's `server_id`, and show the refined version beside the field version
- [ ] Route test on the draft (`apps/mapper`, `packages/routing`): a walking-time shortest path over the draft graph, so connectivity can be checked on site. The full cost model, access rules and opening hours come in Phase 3

### Upload and ingest

- [ ] Owner device token (`services/api`, `apps/mapper`): one owner contributor (tier `owner`) and per-device tokens, stored hashed; the phone keeps its token in the iOS Keychain. `captures.contributor_id` comes from the token, never from the manifest, and owner-only routes such as the change-set preview need a token too. Real sign-in comes in Phase 4
  - Done when: an upload or an owner-only request without a valid token is refused
- [ ] Multipart upload API (`services/api`, `POST /captures`): insert the `captures` row (`device_model`, `os_version`, `app_version`), create an S3 multipart upload on RustFS and return presigned part URLs that the phone can reach on the LAN (not `localhost`); complete with ListParts, then set `status = 'uploaded'` and enqueue validation in one transaction. Bundle bytes go straight to storage and never pass through the API process
- [ ] Upload from the phone (`apps/mapper`): after `packBundle`, enqueue every part at once with expo-file-system `File.createUploadTask` (background session) while the app is in the foreground. Add the small native uploader (`allowsCellularAccess = false`) only if strict Wi-Fi-only or surviving a killed app turns out to be needed
  - Done when: a pilot-sized bundle uploads over home Wi-Fi, carries on with the app in the background, and completes on the server
- [ ] Validation job (`services/processing`): fetch the bundle from private storage, run the validator, set `captures.status` and `failure_reason`
- [ ] Privacy re-check (`services/processing`, worker process): YuNet faces through onnxruntime-node, run on tiles or at several scales. A frame with a still-sharp face (variance-of-Laplacian test inside the detection) is quarantined: removed from the stored bundle and excluded from processing; its frame index goes into `captures.quarantined_frames` and `captures.privacy_flagged` is set, which blocks publishing until the owner or a moderator clears it. The bundle fails (`captures.status = 'failed'`, `failure_reason = 'privacy'`) and is deleted only if the quarantined share exceeds the threshold (a tuning value, starting at 5%) or an anchor photo is affected
  - Decode keyframes with a pixel limit (for example sharp's `limitInputPixels` at the validator's `maxImagePixels`), and treat a keyframe that can't be decoded as a failed check, never as a pass
  - Done when: fixture tests cover a quarantined frame, a failed bundle and an affected anchor photo, and a stored bundle with quarantined frames still validates
- [ ] Screen re-check (`services/processing`): add a permissively licensed screen detector to the re-check (chosen in this task; the stack review suggests RT-DETR, Apache-2.0), and decide what a still-sharp screen does: quarantine like a face, or flag for review, since the server model also finds displays the phone rightly left sharp. Record both in [0005](decisions/0005-privacy-by-design.md); the ONNX export is offline tooling
  - Done when: a still-sharp screen fixture gets the chosen outcome
- [ ] Trajectory clean-up (`services/processing`): drop frames with `limited` tracking, split at relocalization jumps, and use `refined_keyframes.jsonl` transforms where present
- [ ] Backups (a script beside `docker-compose.yml`): raw bundles, the private full exports (`private_export_uri`) and a database dump to an external drive or a cheap S3 bucket in ap-southeast-1 (the owner picks which). Encrypted at rest either way, for example BitLocker on the drive and server-side encryption on S3

### Alignment (`services/processing`)

- [ ] Street priors: propose priors for street-facing anchors from LTA exits (`lta_exit`) and GNSS fixes (`gnss`), as anchor diff entries in the change set (`surveyed_geom`, `prior_source`, `prior_sigma_m`); they reach `anchors` only on approval ([0008](decisions/0008-anchors-and-georeferencing.md)). Placement on imagery (`imagery`) by the owner is the fallback. A connected group needs at least two widely spaced street priors before it can be published
- [ ] Network adjustment solver (worker process): unknowns x, y, z and yaw per anchor; one relative constraint per segment between its anchors (sigma about 1% of the distance walked); street priors as absolute priors with metre-level sigma; level elevations as soft height priors; Gauss-Newton on a small dense system, in SVY21
  - Done when: it recovers a known transform for a chain of 4 synthetic segments where only the two ends have street priors, using real City Hall coordinates
- [ ] Apply the solution: write `segment_alignments` (each segment's transform and the residuals at its start and end anchors), and store each anchor's solved position and yaw and its residual against its street prior (where is decided in this task; record it in [0008](decisions/0008-anchors-and-georeferencing.md) with a migration). Spread each segment's end correction along the walk by cumulative distance, and apply it to the ARKit mesh (no re-meshing). Convert to WGS84 with `ST_Transform`

### Extraction and diff (`services/processing`)

- [ ] Restricted zones for the pilot venues (`db/`): load the outlines noted on the site walk into `restricted_zones`, from a file kept out of the public repo (the git-ignored `db/private/`, or private storage). Tests use synthetic zones
- [ ] Extraction v0: floor polygons from the corrected floor faces; centreline edges from the corrected walk path, with tag nodes snapped onto it; level floor heights into `levels.elevation_m`, relative to the datum floor. Everything is clipped against `restricted_zones`
- [ ] Conflation against HEAD: match extracted features by kind, level and proximity or topology (in SVY21) and keep existing IDs. New UUIDs only for genuinely new features
  - Done when: re-extracting a segment with one moved node gives a move in the diff, not a remove and an add
- [ ] Diff to `change_sets`: a diff in the `docs/diff-format.md` format, validated against its schema, with `base_version_id` set and `change_set_captures` rows. A feature that overlaps the interior of a `restricted_zones` polygon fails the restricted-zone gate and blocks publishing until it is fixed (the database also refuses it in HEAD)
- [ ] Change-set preview (`apps/web`): an owner-only route that draws a pending change set, the aligned segments and their residuals over OneMap tiles, from the local API. It grows into the moderation UI in Phase 4

### Field test

- [ ] [Owner] Walk the Funan B2 → City Hall UPL in both directions, during opening hours on a quiet weekday morning (shops open, few people). Walk segments out and back or close loops, zig-zag through wide halls, and take a GNSS fix at each street exit
- [ ] Field-test write-up (`docs/`): drift and residuals per segment and per anchor, with `os_version` and `device_model` for each segment. Propose starting values for the drift threshold, "widely spaced" street priors and the residual thresholds that gate publishing
- [ ] Decide on COLMAP from that data and record it in [0008](decisions/0008-anchors-and-georeferencing.md): switch it on only if more than about 20% of segments drift over 1 m, network residuals exceed 1–2 m, or overlays cross walls. If it is needed, add a task here for the containerised COLMAP 4.x / pycolmap step (driven by the job queue, ARKit poses as priors)

## Later phases

Phases 3 and 4 get broken down into tasks once the Phase 2 gate passes. Outlines for now.

### Phase 3: Map and routing

Gate: routes verified on foot.

- [Owner] Capture the rest of the core cluster (Raffles City, CityLink, City Hall and Esplanade MRT) as permissions arrive, with the same capture rules
- `street_connectors`: join each exit and entrance to the nearest street vertex, computed in SVY21 and rebuilt inside each publish transaction
- `access` and `opening_hours` on edges, from the site-walk notes
- Router in `packages/routing`, used by `apps/web` and `apps/mapper`: cost in seconds from `routing-config.json`; excludes features closed in the status overlay, `paid_fare_zone` and `customers_only` edges by default, and edges whose `opening_hours` say closed at the time of travel (Asia/Singapore); step-free mode excludes stairs and escalators; a one-time lift boarding penalty; outdoor edges heavily penalised when "stay underground" is on
- Route search in `apps/web` between two street-level points
- Approval: run the automated gates and record the result in `moderation_events`; check each touched feature's `rev` and that the base version was not undone by a rollback (`needs_rebase` otherwise); apply the diff, bump revs, publish through the `owner_mapper` path. DB rule tests cover an `owner_mapper` publish with a failed gate. Public files go to Cloudflare Pages and R2 on free tiers
- [Owner] Walk the routes; tune `routing-config.json` from what the walks show
- [Owner] Set the retention periods for raw bundles and status evidence photos, before Phase 4

### Phase 4: Locate and launch

Gate: public beta goes live.

- Localization (`services/localization`, Go): onnxruntime_go on CPU, MegaLoc retrieval, (RaCo-)ALIKED + LightGlue (LightGlue-ONNX exports), PoseLib through a cgo shim, built in a Linux container. A model allow-list in CI. The index is built per published version from approved captures only
- Models over about 50 MB are fetched at build time with a pinned checksum, never committed (GitHub rejects files over 100 MB)
- `POST /locate` with the privacy-path checklist and its no-temp-file, no-body-logging test; rate limits and a bounded queue. CPU benchmark on Funan data: 3 s is measured and reported, not a gate; a GPU only with the owner's approval
- An owner-only draft index on the server for testing a photo locate against the draft in mapper mode
- Contributor sign-up: email one-time codes plus passkeys (Better Auth is the likely library; confirm then), trust tiers, shared drafts (a server-side `drafts` table) and external TestFlight
- Status overlay: `status_reports`, `status.json` and the `trusted_status_auto` publish path (its reports need `valid_until`; set the maximum duration). Evidence photos stay private, blurred server-side and time-limited
- Moderation UI as an authenticated route in `apps/web`, with `moderation_events`. Who moderates at launch is still open
- Hosting: the smallest x86 Singapore server for the Node API and PostGIS, private bundles in S3 ap-southeast-1, WAL archiving to S3 and a restore drill ([0009](decisions/0009-hosting-and-budget.md)). The privacy notice and the retention rules go live
