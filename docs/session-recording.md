# Session recording format (v1)

The private recording of a capture session that the mapper app's walk build, used only by the owner, can write beside the session's capture bundles. The development build compiles the same recorder but refuses to record. It holds what the bundles leave out, so the session can be replayed on the PC without walking it again. Why, and the rules around it: [ADR 0010](decisions/0010-capture-recording-and-replay.md). This is `recording_version` 1.

Change this doc first, then the JSON Schemas in `packages/contracts` (`schemas/recording/`, `RECORDING_VERSION`, `DEFAULT_RECORDING_LIMITS`; `pnpm gen` also writes Swift types for the lines Swift writes), then the Swift recorder (`apps/mapper/modules/capture-native`) and `validate-recording`. Bump `recording_version` on any breaking change, including a new field, enum value or file. The schemas are in `packages/contracts/schemas/recording/`; the code comes in later backlog tasks.

A recording is never part of a bundle, never uploaded to ingest, and no bundle depends on it. The bundle format, [capture-bundle.md](capture-bundle.md) (`schema_version` 1), is the same with or without one.

## Replay sets

- There is one recording per ARKit session: the directory `rec-<recording_id>/`, where `recording_id` is the session's lowercase UUID.
- A **replay set** is a recording plus the session's bundles (`capture-<capture_id>/`). A bundle (a segment) runs from a start-anchor mark to an end-anchor mark ([capture-bundle.md](capture-bundle.md#anchorsjson)), so the session's first segment starts when the recording opens, and frames before that mark belong to no bundle. A `lean` recording made before the blur passes `privacySelfTest()` has no bundles: a bundle needs blurred keyframes.
- A recording opens at the session's first start-anchor mark. It closes a set margin after the owner marks an end anchor with **End the session here** (when the margin ends, the recorder takes the final sample, closes the recording with `ended: end_anchor` and then stops the session, so the cut-back rule below doesn't apply to it), after an idle timeout, when the app goes to the background (a locked screen included), or at its limits; nothing more of that session is recorded. A recording still open when the session closes, or found cut off at the next launch, is cut back to its last end anchor plus the margin, and the tail is deleted. Sessions start and stop at a public anchor. Nothing outside the window is written.

## Profiles

| Stream | `lean` | `standard` | `dense` |
| --- | --- | --- | --- |
| `frames.jsonl` | Every ARFrame (about 60 Hz) | Same | Same |
| `imu.jsonl`, `motion.jsonl` | 100 Hz | Same | Same |
| `altitude.jsonl` | As Core Motion delivers it | Same | Same |
| Mesh history | At open, every 5 s and at close | At open, every 5 s and at close | At open, every 2 s and at close |
| `anchors.jsonl` | With each mesh snapshot, at open and at close | Same | Same |
| `telemetry.jsonl` | 1 Hz | Same | Same |
| `location.jsonl` | 1 Hz, in windows | Same | Same |
| Candidates (JPEG, depth, confidence, blur line) | None | About 5 Hz | Up to 10 Hz |
| Session length | At most 30 min | At most 30 min | At most 10 min |
| Estimated size | About 6 MB/min plus the mesh history (10–50 MB/min) | `lean` plus about 80 MB/min | About 300 MB/min |

The rates and sizes are provisional: the spike sets the candidate rate, the gate thresholds, the default profile and the limits from measured heat, drops and sizes. `recording.json` records the rates actually achieved.

## Layout

```
rec-<recording_id>/
  recording.json             required: written at open, rewritten as segments start and end, and at close
  frames.jsonl               required: one line per ARFrame
  imu.jsonl                  required
  motion.jsonl               required, empty exactly when recording.json's motion is null
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
- Space is the session's ARKit world frame and time its `t`, seconds since the ARKit session started ([capture-bundle.md](capture-bundle.md#coordinate-frame-and-time-base)). Transforms are 16 floats, column-major. Device-frame vectors (IMU and device motion) use Core Motion's axes, as the bundle's `imu.jsonl` does.
- Frames are numbered across the whole session. A bundle's frame is the session frame minus its segment's `frame_offset` (`recording.json`).
- In each JSONL file `t` never decreases from line to line, and in the sample streams (`frames.jsonl`, `imu.jsonl`, `motion.jsonl`, `altitude.jsonl`, `telemetry.jsonl`, `location.jsonl`) it strictly increases. `frame` (where a line has one, except `anchors.jsonl`) and `seq` strictly increase. Values in different files are not compared.
- **JSON text.** Some fields carry what JavaScript passed or received, whose shape the module doesn't fix (`args` and `result` in `actions.jsonl`, `value` in `boundary.jsonl`). They hold it as JSON text: a string that parses as one JSON value, at most 16,384 characters (Unicode code points, as JSON Schema's `maxLength` counts). Readers parse it; the schemas only bound its length. A value that would pass that bound, or make its line pass `maxJsonlLineBytes`, is never truncated: the writer puts the marker `{"omitted":"too_large","bytes":<its UTF-8 size>}` in its place, which `validate-recording` reports as a warning.
- JSON is UTF-8 without a byte order mark; a blank JSONL line is invalid.

## recording.json

Written when the recording opens; rewritten (atomically, through a temporary file) when a segment starts, finishes or is discarded, and when the recording closes; and rewritten again when a segment listed in it finishes or is discarded after the close (that changes only `segments`). Until it closes, `window.end_t`, `window.ended` and `rates` are `null`, `closed` is `false` and `files` is empty. `recording.json` isn't in `files`, so rewriting it breaks no hash.

| Field | Notes |
| --- | --- |
| `recording_version` | 1 |
| `recording_id` | The session's UUID, generated on the phone |
| `origin` | `device` (recorded on a phone) or `synthetic` (generated by `pnpm rec synth`). Only `synthetic` recordings may be in git |
| `profile` | `lean`, `standard` or `dense` |
| `rates` | What the recording achieved over its window, or `null` until it closes: `frames_hz`, `candidates_hz`, `imu_hz`, `motion_hz`, and `mesh_interval_s`, the mean seconds between mesh snapshots (`null` without two of them) |
| `build` | `app_version`; `git_commit`, the commit built (40 lowercase hex digits), or `null` when unknown; `eas_build_id`, the EAS build's UUID, or `null` for a local build; `profile`: `walk`, the only build that records, or `synthetic` for a set `pnpm rec synth` generated |
| `device_model`, `os_version` | As in the bundle manifest |
| `session_started_at` | Wall clock at `t` = 0 |
| `clocks` | `system_uptime_s` (`ProcessInfo.systemUptime`), `media_time_s` (`CACurrentMediaTime()`) and `wall_clock` (`Date()`), read together at session start |
| `window` | `start_t` and `end_t` of the recording; `ended`, why it closed: `end_anchor` (End the session here), `stop`, `idle`, `background`, `heat`, `disk`, `limit` or `interrupted`; and `trimmed`, `true` when it was cut back to its last end anchor |
| `arkit` | The configuration: `scene_reconstruction` (`meshWithClassification`, `mesh` or `none`), `frame_semantics` (a list of `sceneDepth` and `smoothedSceneDepth`), `video_format` (`width`, `height` and `fps`; the image size `intrinsics` refer to, landscape) and `world_alignment` (`gravity`, `gravityAndHeading` or `camera`) |
| `motion` | Device motion's configuration: `reference_frame`, the Core Motion reference frame `motion.jsonl`'s attitude and heading use (`xArbitraryZVertical`, `xArbitraryCorrectedZVertical`, `xMagneticNorthZVertical` or `xTrueNorthZVertical`), or `null` when device motion is unavailable. The spike chooses the frame |
| `detector_versions` | As the bundle manifest's `privacy.detector_versions`; `null` in `lean` |
| `venues` | Ids of the seeded venues walked (at most 50), chosen before the start, so a recording can be found and deleted on request |
| `segments` | One per bundle the session started while the recording was open, in order, listed when it starts (at most 200): `capture_id`; `manifest_sha256`, the SHA-256 of that bundle's `manifest.json` bytes, or `null` while it has none (still open, or discarded before it got one); `start_t`; `end_t`, or `null` until the segment ends; `frame_offset`; and `kept` (`false` for a discarded segment, whose bundle is gone). A kept segment has a non-null `end_t` and `manifest_sha256` once the session has stopped. A segment's frames are in the recording only within the window, so `deriveBundle` refuses a segment that isn't wholly inside it. Recovery at the next launch rebuilds `segments` from the bundles on disk before it trims. It also runs for a closed recording that still has a kept segment without `end_t` or `manifest_sha256` (the session ended abnormally after the close): that segment's bundle never finished, so it becomes `kept: false` and its files are deleted. An exported set has no such segment: every kept segment has both |
| `closed` | `true` once the recorder closed cleanly; a recording left `false` was cut off |
| `files` | Every other file (at most 60,000): path, bytes and lowercase hex SHA-256, as in the bundle manifest |

## Streams

**`frames.jsonl`**, one line per ARFrame:

| Field | Notes |
| --- | --- |
| `frame`, `t`, `transform`, `tracking` | As in the bundle's `poses.jsonl` |
| `intrinsics` | `[fx, fy, cx, cy]` in pixels, for `arkit.video_format`'s image size |
| `mapping` | ARKit's world-mapping status: `notAvailable`, `limited`, `extending` or `mapped` |
| `exposure` | `duration_s` and `offset_ev`, as the camera reports them |
| `light` | ARKit's light estimate, `intensity_lm` and `temperature_k`, or `null` when it has none |
| `gap` | Frames ARKit skipped since the last line, from the time between them at the video format's rate; 0 for the first |
| `candidate` | `null` (not a candidate), `keyframe`, `kept` (written to `candidates/`), or `dropped:<reason>`: `profile` (the profile keeps no candidates, as in `lean`), `heat`, `backpressure`, `disk` or `blur` (a detector failed, so it was never written) |
| `sharpness` | The pre-blur sharpness score of a candidate, a number, or `null` (not a candidate, or not measured, as in `lean`) |
| `ms` | Stage timings for this frame in milliseconds, each optional: `gate`, `copy`, `sharpness`, `detect`, `blur`, `encode`, `depth`, `write` |

**`imu.jsonl`**, one line per IMU sample at about 100 Hz: exactly the bundle's `imu.jsonl` line (`t`, `accel` in m/s², `gyro` in rad/s).

**`motion.jsonl`**, one line per device-motion sample at about 100 Hz:

| Field | Notes |
| --- | --- |
| `t` | |
| `attitude` | The attitude quaternion `[x, y, z, w]` in `motion.reference_frame`, as Core Motion reports it: not renormalised, so a component can round just past 1. `validate-recording` checks its norm within 1e-3 |
| `gravity`, `user_accel` | Gravity and the user's acceleration in m/s² (converted from g, 1 g = 9.80665 m/s²) |
| `rotation` | Rotation rate in rad/s |
| `magnetic` | `field`, the calibrated magnetic field in µT, and `accuracy`: `uncalibrated`, `low`, `medium` or `high` |
| `heading` | Degrees clockwise from the north of `motion.reference_frame` (magnetic or true), from 0 up to 360; always `null` in the two arbitrary frames, and `null` when Core Motion gives none |

**`altitude.jsonl`**, as Core Motion delivers it: `t`, `relative_m` (metres since the first sample) and `pressure_kpa`. Never absolute altitude.

**`anchors.jsonl`**, one line per anchor change, sampled with each mesh snapshot. The first sample, when the recording opens, writes every anchor the session already has as `add` (a baseline: the session started before the recording opened), and an anchor's first line in this file is always an `add`. Mesh anchors are here too: `add` when ARKit adds them (or in the baseline), `update` when they move past the threshold, `remove` when ARKit removes them. The final sample, when the recording closes (below), writes every keyframe, image and marked anchor that exists, whether or not it moved:

| Field | Notes |
| --- | --- |
| `t` | When it was sampled |
| `anchor` | ARKit's anchor UUID |
| `kind` | `keyframe`, `image`, `mesh` or `marked` (an anchor `markAnchor` placed) |
| `op` | `add`, `update` (moved more than about 1 mm or 0.05° since its last line; in a final sample, any anchor already seen) or `remove` |
| `transform` | Anchor to world, or `null` for `remove` |
| `frame` | The keyframe's frame for a `keyframe` anchor, else `null` |
| `final` | `true` for the lines of a final sample, with no movement threshold |
| `capture_id` | On a final sample, the segment whose session-end reads it is (the segment open when it was taken), else `null` (no segment was open). On other lines, `null` |

A mesh anchor's transform at `t` is its latest line at or before `t` in either `anchors.jsonl` (kind `mesh`) or `mesh/history.jsonl`: ARKit moves mesh anchors without changing their geometry, and `history.bin` gets a block only when the geometry changed.

**The final sample.** When the recording closes with `end_anchor` or `idle`, at `window.end_t`, the recorder takes a final sample, all lines `final: true` at that `t`: in `anchors.jsonl`, first a `remove` for each keyframe, image or marked anchor removed since the last sample, then every keyframe, image and marked anchor that exists (`update` for one already seen, `add` for a new one), with the transform read at that moment; and in the mesh history, every mesh anchor. Its `capture_id` is the segment open at that moment. **End the session here** then stops the session, so that segment's session-end reads (`refined_keyframes.jsonl`, `mesh/scene.ply`) are this sample, and `deriveBundle`'s `recorded` policy rebuilds them from the final lines with that segment's `capture_id`, not from earlier lines. An `idle` close also takes one, but if the session goes on, that segment's later session-end reads don't match it, so `recorded` doesn't apply to it. There is no final sample after a close for `background` (the app has seconds), `heat`, `disk` or `limit` (the recorder is already short of heat, space or budget, and a full mesh snapshot could pass the very limit that closed it), nor after a cut back (`stop` without End the session here, or `interrupted`: its end is in the past); after the `no_mesh_history` degradation step, a final sample has no mesh part. `recorded` doesn't apply to a segment without its final sample. With `continuous_session`, the session-end reads at each segment's end inside the window take a final sample too, with that segment's `capture_id` (an open point of the bundle format).

**`events.jsonl`**, one line per event: `t`, `kind` and `detail`, a short code (a number as its decimal text) or `null`, never a pose, a time or a fix. Each kind's `detail` is fixed by this table, which `RECORDING_EVENT_DETAILS` in `packages/contracts` carries and `validate-recording` checks; the Swift recorder writes events from a typed enum, so it can't put anything else there.

| `kind` | `detail` |
| --- | --- |
| `recording_opened` | `null` |
| `recording_closed` | Why: as `window.ended` |
| `configuration` | What the session ran with, a short lowercase code |
| `session_failed` | The error's code, as decimal digits with an optional minus |
| `interruption_began`, `interruption_ended` | `null` |
| `relocalization_began`, `relocalization_ended` | `null` |
| `image_anchor_detected` | The anchor's UUID |
| `thermal` | The new state: `nominal`, `fair`, `serious` or `critical` |
| `memory_warning` | `null` |
| `background`, `foreground` | `null` |
| `screenshot` | `null` |
| `screen_capture_began`, `screen_capture_ended` | `null` |
| `altimeter_unavailable`, `altimeter_denied`, `motion_unavailable` | `null` |
| `degradation` | The step: `fewer_candidates`, `no_mesh_history` or `no_recording` |

**`actions.jsonl`**, one line per module call during the session: `t`; `call`, the method's name (`start`, `markAnchor`, `addTag`, `stop`, `discard` and so on); `args`, the arguments as JavaScript passed them, as JSON text; `result`, what native code returned, as JSON text (for a raycast: the hit, its normal and the frame used), or `null` for nothing or for a binary result (floor triangles, which only `boundary/<seq>.f32` holds); and `error`, the error's code when the call failed, else `null`. The recorder's own plumbing isn't logged here and gets no boundary line: `appendBoundary` (its lines are already in `boundary.jsonl`) and `listRecordings`, `exportRecording` and `deleteRecording`, which run outside a session.

**`telemetry.jsonl`**, one line a second:

| Field | Notes |
| --- | --- |
| `t` | |
| `thermal` | `nominal`, `fair`, `serious` or `critical` |
| `memory_mb` | The app's memory footprint |
| `cpu` | The app's CPU use, in percent of one core (it can pass 100) |
| `free_disk_mb` | Free space on the phone |
| `queue` | Frames waiting for the keyframe and candidate stages |
| `candidates_blurred`, `candidates_dropped` | Counts since the recording opened |
| `stage_ms` | For each stage of `frames.jsonl`'s `ms` that ran in the last second, `p50` and `p95` in milliseconds |

**`location.jsonl`**, one line per GNSS fix in a window: exactly the bundle's `gnss.jsonl` line (`t`, `lat`, `lon`, `h_accuracy_m`).

**`boundary.jsonl`**, one line per event or result JavaScript received: `t`, the session time the module stamped on it; `seq`, from 0; `kind`, the event or call's name; `value`, what JavaScript received, as JSON text, or `null` when it was binary; and `binary`, `boundary/<seq>.f32` for a binary result (such as floor triangles, `seq` zero-padded to six digits), else `null`. Exactly one of `value` and `binary` is non-null, which `validate-recording` checks. TypeScript writes these lines and hands them to the module (`appendBoundary`).

**`mesh/history.jsonl`**, one line per mesh-history block:

| Field | Notes |
| --- | --- |
| `t` | The snapshot's time |
| `anchor` | The mesh anchor's UUID |
| `op` | `add`, `update` or `remove` |
| `transform` | Anchor to world at `t`, or `null` for `remove` |
| `offset`, `bytes` | Where the block is in `history.bin`, or `null` for `remove` |
| `vertices`, `faces` | Counts in the block, or `null` for `remove` |
| `final` | `true` for a final snapshot (above), which holds every mesh anchor with the transforms read at that moment |
| `capture_id` | On a final snapshot taken at a segment's session-end reads, that segment's `capture_id`; else `null` |

The first snapshot is taken when the recording opens and writes every mesh anchor the session already has as `add`; later snapshots write the anchors whose geometry changed. An anchor's first line is always an `add`.

**`privacy/blur.jsonl`**, one line per recorded candidate: exactly the bundle's `privacy/blur.jsonl` line, in candidate pixel coordinates.

**GNSS windows.** Location is held in memory and written only within ±30 s of marking a street-facing anchor, inside the recording's window, and within about 50 m of that anchor's first fix. No fix from before the recording opened is written.

## Encodings

- **Candidates** follow the keyframe rules of [capture-bundle.md](capture-bundle.md#keyframes-depth-and-confidence): 3-component colour JPEG at `image_size`, in the sensor's native landscape orientation, one image with no thumbnail, no second image and no MPF segment, nothing after EOI. Depth is 16-bit greyscale PNG in millimetres at 256 × 192, confidence 8-bit greyscale PNG (0, 1, 2). Every candidate has a blur line, written in the same step as its JPEG. Keyframes are never stored twice: they stay in their bundle.
- **Mesh history.** `history.bin` is a concatenation of blocks, one per changed mesh anchor per snapshot. Each block is raw DEFLATE (RFC 1951: Apple's `COMPRESSION_ZLIB`, read with Node's `inflateRawSync`) of the anchor's float32 vertices (x, y, z in the anchor's frame), uint32 triangle indices (3 per face) and uint8 classifications (one per face, the `ARMeshClassification` values of [capture-bundle.md](capture-bundle.md#meshsceneply)), all little-endian. A `remove` line has no block. The first snapshot and the final snapshot hold every anchor.
- **Binary boundary results** in `boundary/<seq>.f32` are little-endian float32, exactly as JavaScript received them.

## Limits

`DEFAULT_RECORDING_LIMITS` in `packages/contracts`, provisional until the spike's measurements:

| Limit | Value | Applies to |
| --- | --- | --- |
| `maxRecordingBytes` | 8 GiB | The recording directory |
| `maxExportParts` | 4,096 | Parts of a replay set's export tar, 16 MiB each (64 GiB): the recording, the session's bundles and the tar's headers. `exportRecording` works out the tar's size before writing anything, and refuses, keeping the raw files, when it would need more |
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
- **Export.** `exportRecording(id)` packs the replay set (the recording and the session's bundles; an unrecorded session exports only its bundles, under the session's id) as one plain ustar tar, read under the bundle's tar rules ([capture-bundle.md](capture-bundle.md#ingest-and-validation)), with members under `rec-<recording_id>/` and `capture-<capture_id>/`. It splits the tar into 16 MiB parts (`UPLOAD_PART_BYTES`) in `Documents/exports/replay-<recording_id>/`: `0000.part`, `0001.part` and so on, plus `parts.json`: `recording_version` (1), `recording_id`, `tar_bytes` and `tar_sha256` for the whole tar, and `parts` (at most `maxExportParts`), each part's `name`, `bytes` and `sha256`. The parts and `parts.json` are `NSFileProtectionComplete` and excluded from backup. The raw files are deleted once the parts are written and hashed, and the parts once a pull has verified them. The development build refuses to export.
- **Pull and import on the PC.** `pnpm rec pull` copies only the files `parts.json` lists, over USB, verifies them and removes them from the phone, into `.data/holding/<recording_id>/`. Until it exists, the Apple Devices app copies the parts straight into `.data/holding/<recording_id>/`, never into a folder that OneDrive or another cloud service syncs. `pnpm rec import` refuses a source folder outside `.data/`, reassembles and validates the set (`validate-recording`, `validate-bundle`), runs the face re-check over every image, and moves it to `.data/fixtures/recordings/<recording_id>/` with an `import.json`: `recording_version` (1), `recording_id`, `imported_at`, `reviewed_at` (`null` until `pnpm rec review`), `recheck` (the re-check's `detector`, `images_checked` and `images_deleted`, or `null` for a set with no images), and `deleted` (at most 60,000): every file deleted by the re-check or by a quarantine carried over from ingest, with its `path` (a recording's candidate, depth or confidence image, or a bundle's keyframe, depth or confidence image), `frame` and `reason` (`recheck` or `quarantine`). `pnpm rec import` checks that each path's id is the recording's or one of the session's capture ids, that `frame` is the file's frame, and that the file is gone.

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
