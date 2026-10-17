# Session recording format (v1)

The private recording of a capture session that the mapper app's walk build, used only by the owner, can write beside the session's capture bundles. The development build compiles the same recorder but refuses to record. It holds what the bundles leave out, so the session can be replayed on the PC without walking it again. Why, and the rules around it: [ADR 0010](decisions/0010-capture-recording-and-replay.md). This is `recording_version` 1.

Change this doc first, then the JSON Schemas in `packages/contracts` (`schemas/recording/`, `RECORDING_VERSION`, `DEFAULT_RECORDING_LIMITS`; `pnpm gen` also writes Swift types for the lines Swift writes), then the Swift recorder (`apps/mapper/modules/capture-native`) and `validate-recording`. Bump `recording_version` on any breaking change, including a new field, enum value or file. The schemas and the code come in later backlog tasks.

A recording is never part of a bundle, never uploaded to ingest, and no bundle depends on it. The bundle format, [capture-bundle.md](capture-bundle.md) (`schema_version` 1), is the same with or without one.

## Replay sets

- There is one recording per ARKit session: the directory `rec-<recording_id>/`, where `recording_id` is the session's lowercase UUID.
- A **replay set** is a recording plus the session's bundles (`capture-<capture_id>/`). A `lean` recording made before the blur passes `privacySelfTest()` has no bundles: a bundle needs blurred keyframes.
- A recording opens at the session's first start-anchor mark. It closes a set margin after the owner marks an end anchor with **End the session here**, after an idle timeout, when the app goes to the background (a locked screen included), or at its limits; nothing more of that session is recorded. A recording still open when the session closes, or found cut off at the next launch, is cut back to its last end anchor plus the margin, and the tail is deleted. Sessions start and stop at a public anchor. Nothing outside the window is written.

## Profiles

| Stream | `lean` | `standard` | `dense` |
| --- | --- | --- | --- |
| `frames.jsonl` | Every ARFrame (about 60 Hz) | Same | Same |
| `imu.jsonl`, `motion.jsonl` | 100 Hz | Same | Same |
| `altitude.jsonl` | As Core Motion delivers it | Same | Same |
| Mesh history | Every 5 s, and at stop | Every 5 s, and at stop | Every 2 s, and at stop |
| `anchors.jsonl` | With each mesh snapshot, and at stop | Same | Same |
| `telemetry.jsonl` | 1 Hz | Same | Same |
| `location.jsonl` | 1 Hz, in windows | Same | Same |
| Candidates (JPEG, depth, confidence, blur line) | None | About 5 Hz | Up to 10 Hz |
| Session length | At most 30 min | At most 30 min | At most 10 min |
| Estimated size | About 6 MB/min plus the mesh history (10–50 MB/min) | `lean` plus about 80 MB/min | About 300 MB/min |

The rates and sizes are provisional: the spike sets the candidate rate, the gate thresholds, the default profile and the limits from measured heat, drops and sizes. `recording.json` records the rates actually achieved.

## Layout

```
rec-<recording_id>/
  recording.json             required: written at start, rewritten at close
  frames.jsonl               required: one line per ARFrame
  imu.jsonl                  required
  motion.jsonl               required
  altitude.jsonl             optional: when the altimeter is available and allowed
  anchors.jsonl              required, may be empty
  events.jsonl               required
  actions.jsonl              required, may be empty
  telemetry.jsonl            required
  location.jsonl             optional: GNSS windows at street-facing anchors
  boundary.jsonl             required: what JavaScript received
  boundary/<seq>.f32         binary results JavaScript received, such as floor triangles
  mesh/history.bin           required unless the mesh history stopped before its first snapshot
  mesh/history.jsonl         required with history.bin: its index
  candidates/<frame>.jpg     standard and dense: non-keyframe candidates, blurred before writing
  depth/<frame>.png          standard and dense: one per recorded candidate
  confidence/<frame>.png     standard and dense, optional
  privacy/blur.jsonl         standard and dense: one line per recorded candidate
```

Files outside this layout are rejected. Frame names are six-digit session frame indices (`000123`) and match `frame` in `frames.jsonl`.

## Values, frames and time

- Every value rule of [capture-bundle.md](capture-bundle.md#values) holds: exactly the listed fields, lowercase UUIDs, RFC 3339 times with `+08:00` (or `Z`), frame indices 0 to 999999, `t` never negative, `null` rather than empty text, `/` in paths, and bounded lists and text.
- Space is the session's ARKit world frame and time its `t`, seconds since the ARKit session started ([capture-bundle.md](capture-bundle.md#coordinate-frame-and-time-base)). Transforms are 16 floats, column-major.
- Frames are numbered across the whole session. A bundle's frame is the session frame minus its segment's `frame_offset` (`recording.json`).
- In each JSONL file, `t` strictly increases from line to line (and `frame` too, where a line has one). Values in different files are not compared.
- JSON is UTF-8 without a byte order mark; a blank JSONL line is invalid.

## recording.json

| Field | Notes |
| --- | --- |
| `recording_version` | 1 |
| `recording_id` | The session's UUID, generated on the phone |
| `origin` | `device` (recorded on a phone) or `synthetic` (generated by `pnpm rec synth`). Only `synthetic` recordings may be in git |
| `profile` | `lean`, `standard` or `dense`, and `rates`: the frame, candidate, IMU and mesh-snapshot rates actually achieved |
| `build` | `app_version`, `git_commit`, `eas_build_id` and `profile`: always `walk`, the only build that records |
| `device_model`, `os_version` | As in the bundle manifest |
| `session_started_at` | Wall clock at `t` = 0 |
| `clocks` | `system_uptime_s` (`ProcessInfo.systemUptime`), `media_time_s` (`CACurrentMediaTime()`) and `wall_clock` (`Date()`), read together at session start |
| `window` | `start_t` and `end_t` of the recording; `ended`, why it closed: `end_anchor` (End the session here), `stop`, `idle`, `background`, `heat`, `disk`, `limit` or `interrupted`; and `trimmed`, `true` when it was cut back to its last end anchor |
| `arkit` | The configuration: scene reconstruction, frame semantics, video format, world alignment |
| `detector_versions` | As the bundle manifest's `privacy.detector_versions`; `null` in `lean` |
| `venues` | Ids of the seeded venues walked, chosen before the start, so a recording can be found and deleted on request |
| `segments` | One per bundle: `capture_id`, `manifest_sha256` (SHA-256 of that bundle's `manifest.json` bytes), `start_t`, `end_t`, `frame_offset`, and `kept` (`false` for a discarded segment, whose bundle is gone) |
| `closed` | `true` once the recorder closed cleanly; a recording left `false` was cut off |
| `files` | Every other file: path, bytes and lowercase hex SHA-256, as in the bundle manifest |

## Streams

| File | One line per | Fields |
| --- | --- | --- |
| `frames.jsonl` | ARFrame | `frame`, `t`, `transform`, `intrinsics` (`[fx, fy, cx, cy]` for `image_size`), `tracking` (as in `poses.jsonl`), `mapping` (world-mapping status), `exposure` (duration and offset), `light` (ambient intensity and colour temperature), `gap` (frames ARKit skipped since the last line), `candidate` (`null`, `keyframe`, `kept`, or `dropped:<heat\|backpressure\|disk\|blur>`), `sharpness` (the pre-blur score, a number, or `null`), `ms` (stage timings) |
| `imu.jsonl` | IMU sample | Exactly the bundle's `imu.jsonl` line: `t`, `accel` in m/s², `gyro` in rad/s, device frame |
| `motion.jsonl` | Device-motion sample | `t`, `attitude` (quaternion), `gravity`, `user_accel` (m/s²), `rotation` (rad/s), `magnetic` (calibrated field, µT, and its accuracy), `heading` (degrees, or `null`) |
| `altitude.jsonl` | Altimeter sample | `t`, `relative_m`, `pressure_kpa`. Never absolute altitude |
| `anchors.jsonl` | Anchor change | `t`, `anchor` (UUID), `kind` (`keyframe`, `image`, `mesh`, `marked`), `op` (`add`, `update`, `remove`), `transform`, and `frame` for a keyframe anchor. Updates only for anchors that moved more than about 1 mm or 0.05° since their last line |
| `events.jsonl` | Event | `t`, `kind` (configuration, interruption, relocalization, image-anchor detection, thermal, memory, background, foreground, screenshot, altimeter denied, degradation step, ...), `detail` (a short code or number, never a pose or a fix) |
| `actions.jsonl` | Module call | `t`, `call` (`markAnchor`, `addTag`, `stop`, ...), `args` as JavaScript passed them, `result` as native code returned it (for a raycast: the hit, its normal and the frame used) |
| `telemetry.jsonl` | Second | `t`, `thermal`, `memory_mb`, `cpu`, `free_disk_mb`, `queue`, `candidates_blurred`, `candidates_dropped`, and p50 and p95 stage timings |
| `location.jsonl` | GNSS fix in a window | The bundle's `gnss.jsonl` line: `t`, `lat`, `lon`, `h_accuracy_m` |
| `boundary.jsonl` | Event or result JavaScript received | `t`, `seq`, `kind` (the event or call), `value` as JavaScript saw it; binary results point to `boundary/<seq>.f32` |
| `mesh/history.jsonl` | Mesh-history block | `t`, `anchor`, `op` (`add`, `update`, `remove`), `transform` (anchor to world at `t`), `offset` and `bytes` (the block in `history.bin`), `vertices`, `faces`, `final` (`true` for the snapshot at stop) |
| `privacy/blur.jsonl` | Recorded candidate | Exactly the bundle's `privacy/blur.jsonl` line, in candidate pixel coordinates |

**GNSS windows.** Location is held in memory and written only within ±30 s of marking a street-facing anchor, inside the recording's window, and within about 50 m of that anchor's first fix. No fix from before the recording opened is written.

## Encodings

- **Candidates** follow the keyframe rules of [capture-bundle.md](capture-bundle.md#keyframes-depth-and-confidence): 3-component colour JPEG at `image_size`, in the sensor's native landscape orientation, one image with no thumbnail, no second image and no MPF segment, nothing after EOI. Depth is 16-bit greyscale PNG in millimetres at 256 × 192, confidence 8-bit greyscale PNG (0, 1, 2). Every candidate has a blur line, written in the same step as its JPEG. Keyframes are never stored twice: they stay in their bundle.
- **Mesh history.** `history.bin` is a concatenation of blocks, one per changed mesh anchor per snapshot. Each block is raw DEFLATE (RFC 1951: Apple's `COMPRESSION_ZLIB`, read with Node's `inflateRawSync`) of the anchor's float32 vertices (x, y, z in the anchor's frame), uint32 triangle indices (3 per face) and uint8 classifications (one per face, the `ARMeshClassification` values of [capture-bundle.md](capture-bundle.md#meshsceneply)), all little-endian. A `remove` line has no block. The snapshot at stop holds every anchor, with the session-end transforms.
- **Binary boundary results** in `boundary/<seq>.f32` are little-endian float32, exactly as JavaScript received them.

## Limits

`DEFAULT_RECORDING_LIMITS` in `packages/contracts`, provisional until the spike's measurements:

| Limit | Value | Applies to |
| --- | --- | --- |
| `maxRecordingBytes` | 8 GiB | The recording directory, or its export parts: 512 parts of 16 MiB |
| `maxEntries` | 60,000 | Files and directories in the recording |
| `maxSessionSeconds` | 1,800 (600 in `dense`) | `window.end_t − window.start_t` |
| `maxJsonBytes` | 16 MiB | `recording.json` |
| `maxJsonlBytes` | 256 MiB | Each JSONL file |
| `maxJsonlLineBytes` | 64 KiB | One JSONL line |
| `maxMeshHistoryBytes` | 2 GiB | `mesh/history.bin` |
| `maxMeshBlockBytes` | 64 MiB | One block, inflated |
| `maxJpegBytes`, `maxPngBytes`, `maxImagePixels` | As the bundle's | Candidates, depth and confidence |

## Export and import

- **On the phone,** recordings are kept in `Library/Application Support/recordings/rec-<recording_id>/`, `NSFileProtectionCompleteUnlessOpen` while being written and `NSFileProtectionComplete` once closed, excluded from backup. Swift writes every file, the boundary trace included. Only `exports/` lives under Documents, the folder `UIFileSharingEnabled` exposes.
- **Export.** `exportRecording(id)` packs the replay set (the recording and the session's bundles; an unrecorded session exports only its bundles, under the session's id) as one plain ustar tar, read under the bundle's tar rules ([capture-bundle.md](capture-bundle.md#ingest-and-validation)), with members under `rec-<recording_id>/` and `capture-<capture_id>/`. It splits the tar into 16 MiB parts (`UPLOAD_PART_BYTES`) in `Documents/exports/replay-<recording_id>/`: `0000.part`, `0001.part` and so on, plus `parts.json` with each part's name, bytes and SHA-256 and the whole tar's SHA-256. The parts and `parts.json` are `NSFileProtectionComplete` and excluded from backup. The raw files are deleted once the parts are written and hashed, and the parts once a pull has verified them. The development build refuses to export.
- **Pull and import on the PC.** `pnpm rec pull` copies only the files `parts.json` lists, over USB, verifies them and removes them from the phone, into `.data/holding/<recording_id>/`. Until it exists, the Apple Devices app copies the parts straight into `.data/holding/<recording_id>/`, never into a folder that OneDrive or another cloud service syncs. `pnpm rec import` refuses a source folder outside `.data/`, reassembles and validates the set (`validate-recording`, `validate-bundle`), runs the face re-check over every image, and moves it to `.data/fixtures/recordings/<recording_id>/` with an `import.json`: `imported_at`, `reviewed_at`, the re-check's detector and counts, and every file deleted by the re-check or by a quarantine carried over from ingest, by frame.

## Privacy rules

The rules are in [ADR 0010](decisions/0010-capture-recording-and-replay.md) and [0005](decisions/0005-privacy-by-design.md). What they mean for a recording:

- **Personal data.** A recording is at least as private as a raw bundle. It is never in git (except `origin: synthetic`), cloud CI, EAS artefacts, iCloud, OneDrive or any other cloud-synced folder, AirDrop, email, Cloudflare or R2, and never passes through Metro or a TLS-terminating tunnel. On the PC it is kept on the encrypted drive and in the encrypted backups.
- **Blur before writing.** Every candidate goes through `writeBlurredJPEG`, which accepts only a `BlurredImage`: made only after every detector ran on that frame. A frame whose detectors failed is dropped and never written.
- **Never recorded:** raw camera images or video, Vision observations beyond the padded boxes, `ARWorldMap`, `rawFeaturePoints`, absolute altitude, continuous GNSS, Wi-Fi, Bluetooth or audio.
- **Messages and logs** from the recorder, `validate-recording` and `pnpm rec` name files, lines and frames, never poses, times, fixes or boundary values; `pnpm rec ls` shows ids and ages in days, never dates or times. AI agents read only their aggregate output, never the files, and never copy them outside `.data/`.
- **Retention.** Kept while it serves development, reviewed by the owner every 3 months, deleted on request, every copy (`pnpm rec delete`; backup sets are kept at most 30 days).

## Versioning

- Unknown fields are rejected, so adding a field is a breaking change and bumps `recording_version`.
- Old recordings must stay readable. The TypeScript reader keeps an upgrader for every older `recording_version`, tested on a synthetic set of each version.
- Re-derived bundles are always written at the current bundle `schema_version`.

## Open points

| Open point | Decided |
| --- | --- |
| The candidate rate, gate thresholds, default profile and limits | Phase 1 spike, from measured heat, drops and sizes |
| The idle timeout, and the margin after End the session here | Phase 1 spike |
| Whether keyframe anchors move at all, and the sampling threshold | Phase 1 spike ([0008](decisions/0008-anchors-and-georeferencing.md)) |
| Masking depth and confidence inside `person_head` boxes for non-keyframe candidates | Phase 1 spike |
| An ARAnchor per candidate | Optional spike experiment |
| How `t` is derived from Core Motion and Core Location timestamps | Phase 1 spike, from the measured clock offsets |
