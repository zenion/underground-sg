# Capture bundle format (v1)

The contract between the mapper app (`apps/mapper`) and the ingest API. One bundle = one segment, walked from one anchor to another. This is `schema_version` 1.

Change this doc first, then the JSON Schemas in `packages/contracts`, then the Swift capture module (`apps/mapper/modules/capture-native`) and the validator. Bump `schema_version` on any breaking change, including a new enum value or a new file.

The schemas in `packages/contracts` (JSON Schema 2020-12) are the machine-readable form of this doc. TypeScript types are generated from them with json-schema-to-typescript and Swift Codable types with quicktype; CI regenerates both and fails on a diff.

Who writes what ([0007](decisions/0007-expo-mapper-app.md)): the Swift module writes everything that is per frame (keyframes, depth, confidence, poses, refined keyframes, IMU, blur records) plus the mesh, and packs the bundle. The TypeScript app writes `manifest.json`, `anchors.json`, `tags.json` and the floor-plan preview from the compact results the module returns. Nothing per frame crosses into JavaScript. `gnss.jsonl` arrives with the street-prior work in Phase 2; which side writes it is decided then.

## Changes from v0

- Container defined: an uncompressed tar, uploaded as S3 multipart in 16 MiB parts.
- `manifest.json`: `contributor_id` removed; `session_started_at`, `image_size`, `depth_size`, `files` and `privacy.detector_versions` added.
- `anchors.json`: an anchor is now a physical feature, with `kind`, `point`, `facing` and `registration`.
- `tags.json`: `type` added (`node` or `poi`), so `toilet` is a POI.
- New files: `refined_keyframes.jsonl` and `gnss.jsonl` (optional), `privacy/blur.jsonl` (required).
- The time base, the `imu.jsonl` line and the PLY layout are defined.
- Privacy: blur is defined as irreversible, heads of detected people are blurred as a backstop, and the server quarantines frames instead of rejecting the whole bundle for one face.
- The validator is TypeScript, not Python.

## Container and upload

The bundle starts as a directory on the phone, `capture-<capture_id>/`. When the segment is finished:

1. `packBundle(dir, partBytes)` packs the directory as one uncompressed tar and splits it into part files of 16 MiB (16,777,216 bytes, `UPLOAD_PART_BYTES` in `packages/contracts`; the last part may be smaller). It then deletes the raw files, so the bundle is not stored twice.
2. The API creates an S3 multipart upload and returns a presigned URL for each part.
3. While the app is in the foreground, it enqueues every part at once with expo-file-system's `File.createUploadTask` (a background session).
4. The server completes the upload with `ListParts`, then validation runs ([Ingest and validation](#ingest-and-validation)).

The tar holds the bundle directory, so member names start with `capture-<capture_id>/`. Parts are only a transport detail: ingest works on the reassembled tar. Through Phase 3 the phone uploads over home Wi-Fi to the owner's PC, where RustFS serves the S3 API ([0009](decisions/0009-hosting-and-budget.md)). If uploads must be strictly Wi-Fi-only or survive the app being killed, a small native uploader replaces step 3 ([0007](decisions/0007-expo-mapper-app.md)).

## Layout

```
capture-<capture_id>/
  manifest.json              required
  anchors.json               required: start and end anchor
  tags.json                  required, may be an empty list
  poses.jsonl                required: one line per frame
  refined_keyframes.jsonl    optional: keyframe transforms re-read at session end
  imu.jsonl                  optional
  gnss.jsonl                 optional: GNSS fixes at street-facing anchors
  keyframes/<frame>.jpg      required: blurred on the phone before writing
  depth/<frame>.png          required for each keyframe: 16-bit, millimetres
  confidence/<frame>.png     optional: ARKit depth confidence (0, 1, 2)
  privacy/blur.jsonl         required: one line per keyframe
  mesh/scene.ply             required: ARKit scene mesh, per-face classification
  preview/floorplan.geojson  optional: the on-device preview, for comparison with the server result
```

Frame names are zero-padded frame indices (`000123`) and match `frame` in `poses.jsonl`. Files outside this layout are rejected.

## Values

These hold in every JSON and JSONL file, and the schemas check them:

- Objects have exactly the fields this doc lists. Unknown fields are rejected, so adding a field is a breaking change.
- UUIDs (`capture_id`, `anchor_id`) are lowercase. Swift's `uuidString` is uppercase, so lowercase it.
- Date-times are RFC 3339 in Singapore time, with the offset `+08:00`; `Z` (UTC) is accepted too. Any other offset (`-05:00`, `+00:00`, `+0800`), or none, is invalid.
- Frame indices run from 0 to 999999, so frame names always have six digits.
- `t` is never negative: samples from before the session started are not written.
- Text that may be `null` (a tag's `name` and `note`) is `null` rather than an empty string.
- Paths in `manifest.files` and `anchors.json` use `/`.
- Lists and text have upper bounds, far above what a segment needs, so a hostile file can't make validation slow: at most 10,000 tags, 20,000 entries in `manifest.files` and 1,000 boxes per keyframe; an anchor's or tag's `name` and each `privacy` text field up to 200 characters, a tag's `note` up to 2,000, and `app_version`, `device_model` and `os_version` up to 100.

## Coordinate frame and time base

Everything spatial in a bundle is in the ARKit world frame of the session that recorded it: right-handed, metres, y up (gravity-aligned), origin where tracking started. The heading is arbitrary in every session, which is why segments need registration at their anchors (the hinge problem, [0008](decisions/0008-anchors-and-georeferencing.md)). The server, not the phone, transforms into SVY21 and WGS84 in the network adjustment. The phone's preview may use an approximate transform for display only.

- **Transforms** are 16 floats: a column-major 4×4 matrix giving the pose of the camera (or anchor) in the world frame, as ARKit reports it.
- **Camera frame** is ARKit's: x to the right of the sensor image, y up, the camera looking along -z, with the sensor in its native landscape orientation. Image pixel rows run downwards, so flip y and z before projecting with the intrinsics.
- **Time:** `t` in every file is seconds since the ARKit session started, on one monotonic clock (ARKit, Core Motion and Core Location timestamps are converted to it). `manifest.session_started_at` is the wall-clock time at `t` = 0.
- **Shared sessions:** if one ARKit session spans consecutive segments (`registration: continuous_session`), `t` keeps counting across them and `session_started_at` is earlier than the segment's `started_at`.

## Keyframes, depth and confidence

- Keyframe JPEGs are 3-component colour (YCbCr, as JPEG stores RGB), written in the camera sensor's native landscape orientation, not rotated for display: width at least height. Their size is `manifest.image_size`, and the `intrinsics` in `poses.jsonl` are for that size.
- A keyframe JPEG holds one image, the blurred keyframe: SOI, its segments, a frame header, one or more scans and EOI, with nothing after EOI. It carries no thumbnail or second image: no JFIF or JFXX thumbnail, no Exif thumbnail (IFD1) and no MPF segment, since the server's privacy re-check only looks at the main image. Other metadata, such as JFIF, Exif without a thumbnail or an ICC profile, is allowed.
- Depth PNGs are 16-bit greyscale in millimetres, from ARKit's `smoothedSceneDepth`, at `manifest.depth_size`, which is always 256 × 192, in the same orientation.
- Confidence PNGs are 8-bit, with ARKit's levels: 0 low, 1 medium, 2 high.
- Depth and confidence PNGs are complete: the IHDR chunk first, at least one IDAT, the IEND chunk last, and nothing after IEND.
- **Depth intrinsics** are the camera intrinsics scaled by `s = depth_w / image_w`: `[fx·s, fy·s, cx·s, cy·s]`. With the example values below, `s = 256 / 1920`, so `[1445.2, 1445.2, 958.4, 721.9]` becomes `[192.7, 192.7, 127.8, 96.3]`. One scale factor only works if both images have the same aspect ratio; the validator checks this.

## manifest.json

```json
{
  "schema_version": 1,
  "capture_id": "8f9585da-8554-4b8a-ba4e-0f390ccd3802",
  "app_version": "0.1.0",
  "device_model": "iPhone18,2",
  "os_version": "iOS 26.6.1",
  "session_started_at": "2026-10-20T10:32:01+08:00",
  "started_at": "2026-10-20T10:32:03+08:00",
  "ended_at": "2026-10-20T10:34:41+08:00",
  "frame_count": 4210,
  "keyframe_count": 312,
  "image_size": [1920, 1440],
  "depth_size": [256, 192],
  "drift_m": 0.42,
  "privacy": {
    "blur_method": "pixelate, 16 px cells, padded box",
    "detector_versions": {
      "face": "VNDetectFaceRectanglesRequest, with the revision in use",
      "person_head": "VNDetectHumanRectanglesRequest, with the revision in use",
      "screen": "model and version chosen in the Phase 1 spike"
    },
    "faces_blurred": 17,
    "screens_blurred": 3
  },
  "files": [
    { "path": "anchors.json", "bytes": 1184,
      "sha256": "197129aec34bcd1814b9f325984f4fc47efee8a39bafc0f6d2f8e304a0f2699e" },
    { "path": "keyframes/000058.jpg", "bytes": 412377,
      "sha256": "57d87741e18680df32b3ecd630bc33709651bb5fa3811d048879880283db054a" },
    { "path": "poses.jsonl", "bytes": 1893502,
      "sha256": "cc20b39e0fb0a7719594ab29e0cb53bac2e8384e525fbc8768ba968ba30f7fd6" }
  ]
}
```

| Field | Notes |
| --- | --- |
| `capture_id` | UUID generated on the phone; becomes `captures.id` |
| `app_version`, `device_model`, `os_version` | Become the matching `captures` columns. `device_model` and `os_version` are kept with every segment's drift: iOS 26.4 to 26.6.0 had a reported LiDAR world-tracking drift regression, so don't map on those. `device_model` is the hardware identifier; `"iPhone18,2"` is a placeholder, not a checked identifier for the iPhone 17 Pro Max. |
| `session_started_at` | Wall clock at `t` = 0 |
| `started_at`, `ended_at` | Wall clock when the segment started and ended. All times are ISO 8601 with the offset, shown in Asia/Singapore |
| `frame_count`, `keyframe_count` | Lines in `poses.jsonl`, and lines with `"keyframe": true` |
| `image_size` | `[w, h]` of the keyframe JPEGs, in the sensor's native landscape orientation (width at least height), with the same aspect ratio as `depth_size`, and at most 16,777,216 pixels (`maxImagePixels`) |
| `depth_size` | `[w, h]` of the depth and confidence PNGs: always `[256, 192]` |
| `drift_m` | See below; `null` when it can't be computed |
| `privacy.blur_method` | How boxes were obscured: solid fill, or pixelation with the cell size |
| `privacy.detector_versions` | The detector and its revision or model version for each box kind in `privacy/blur.jsonl` |
| `privacy.faces_blurred`, `privacy.screens_blurred` | Number of `face` and `screen` boxes across all keyframes; must match `privacy/blur.jsonl` |
| `files` | Every file in the bundle except `manifest.json`: path relative to the bundle directory, size in bytes, lowercase hex SHA-256 |

There is no `contributor_id`. The server sets `captures.contributor_id` from the upload's authentication, never from the bundle.

`drift_m` is the gap the phone measured between where the end anchor was expected and where the scan put it. It can only be computed when the end anchor already has a position in the current session's frame: an existing anchor reached through registration, or a walk back to the start (loop closure). Otherwise it is `null`, which includes most new end anchors. The drift check's threshold is a tuning value that starts around 1 m, and processing recomputes drift where it can be computed ([0008](decisions/0008-anchors-and-georeferencing.md)). Capture guideline: walk segments out and back, or close loops, where practical.

## anchors.json

```json
[
  {
    "role": "start",
    "anchor_id": "bac5bc30-e4b3-44f0-a134-04168e65db9e",
    "kind": "floor_point",
    "name": "Funan B2 UPL door",
    "ordinal": -2,
    "point": [0.21, -1.43, -0.86],
    "facing": [0.0, 0.0, -1.0],
    "transform": [16 floats: the device pose at the tap],
    "registration": "world_map",
    "photo": "keyframes/000058.jpg"
  },
  {
    "role": "end",
    "anchor_id": "31d751b1-1605-4791-8d33-77e1ccdfcbd8",
    "kind": "image_anchor",
    "name": "City Hall exit A gate sign",
    "ordinal": -2,
    "point": [-41.37, 0.62, -148.95],
    "facing": [0.6, 0.0, 0.8],
    "transform": [16 floats: the ARImageAnchor transform],
    "registration": "image_anchor",
    "photo": "keyframes/004187.jpg"
  }
]
```

An anchor is a physical feature, not the phone's pose at a tap ([0008](decisions/0008-anchors-and-georeferencing.md)).

| Field | Notes |
| --- | --- |
| `role` | `start` or `end`; exactly one of each |
| `anchor_id` | The existing anchor's UUID, or `null` if the anchor is new |
| `kind` | `floor_point`: an ARKit raycast to the floor at a door threshold or fare-gate line, plus the facing direction. `image_anchor`: an `ARImageAnchor` on a permanent planar sign, which gives a repeatable 6-DoF pose |
| `name` | As used on site, e.g. "Funan B2 UPL door" |
| `ordinal` | Display band of the anchor's level (0 street, -1 first basement band, ...): an integer from -32768 to 32767, a `smallint` like `levels.ordinal`. Processing sets `anchors.level_id` |
| `point` | `[x, y, z]` in the ARKit world: the floor point, or the image anchor's origin |
| `facing` | Horizontal unit vector (y = 0) in the ARKit world: the direction the door or sign faces. Processing turns it into `anchors.facing_deg` |
| `transform` | 16 floats: the image anchor's transform for an image anchor, otherwise the device pose at the tap |
| `registration` | How this session's frame was tied to earlier observations of the anchor: `world_map` (ARWorldMap relocalization at the anchor), `continuous_session` (one ARKit session across consecutive segments), `image_anchor` (the sign was recognised) or `none` (a new anchor, or nothing tied it) |
| `photo` | The keyframe used as the anchor's reference photo. It is blurred like every keyframe and becomes the anchor's private `photo_uri`; it is never public |

Which registration approach the app uses is decided in the Phase 1 spike and recorded in [0008](decisions/0008-anchors-and-georeferencing.md). A new `registration` value (for example, a relative pose from the anchor photo plus depth) is a breaking change.

## tags.json

```json
[
  { "type": "node", "kind": "escalator", "name": null, "frame": 1832,
    "position": [-14.62, 0.04, -61.08], "note": "up only, B2 to B1" },
  { "type": "poi", "kind": "toilet", "name": null, "frame": 2675,
    "position": [-27.15, 0.02, -97.33], "note": null }
]
```

- `type` is `node` or `poi`. `kind` uses the `node_kind` values for nodes and the `poi_category` values for POIs, both in `db/schema.sql`. A toilet is a POI.
- Tags of a connector kind (`escalator`, `lift`, `stairs`, `travelator`, `ramp`) mark one landing each: one end of an escalator or stairs, or one lift stop.
- `position` is in the ARKit world, taken from the device pose at `frame`.
- `name` is the name as signed, or `null`. `note` is free text for the moderator.

## poses.jsonl

One JSON object per line, one line per frame:

```json
{ "frame": 123, "t": 4.104, "transform": [16 floats], "intrinsics": [1445.2, 1445.2, 958.4, 721.9],
  "tracking": "normal", "keyframe": true }
```

- `t` is seconds since session start ([time base](#coordinate-frame-and-time-base)).
- `transform` is ARKit's `camera.transform` at that frame. It is a snapshot: it can jump when ARKit closes a loop, and is not corrected afterwards (see `refined_keyframes.jsonl`).
- `intrinsics` are `[fx, fy, cx, cy]` in pixels for an image of `manifest.image_size`.
- `tracking` is ARKit's tracking state (`normal`, `limited:<reason>`, `notAvailable`). Processing drops `limited` frames and splits the trajectory at relocalization jumps.

## refined_keyframes.jsonl

Optional. One line per keyframe:

```json
{ "frame": 123, "transform": [16 floats] }
```

At each keyframe the module adds an ARAnchor at the camera pose. At session end it re-reads every one of those anchors, whose transforms ARKit has refined in the meantime, and writes them here. Same transform convention as `poses.jsonl`. Where a line exists, it is a better estimate of the keyframe pose than the logged one, and it keeps the poses consistent with the mesh.

## imu.jsonl

Optional. One line per IMU sample:

```json
{ "t": 4.104, "accel": [0.12, -9.71, -1.05], "gyro": [0.012, -0.034, 0.005] }
```

- `accel` in m/s², `gyro` in rad/s, both in the device frame (Core Motion axes: x to the right of the screen, y towards the top of the device, z out of the screen). This is not the camera frame.
- `accel` is the raw accelerometer reading, gravity included, converted from g (1 g = 9.80665 m/s²).

## gnss.jsonl

Optional. Phone GNSS fixes recorded at street-facing anchors, used as street priors (`prior_source = 'gnss'`, [0008](decisions/0008-anchors-and-georeferencing.md)). Example from a segment that ends at a City Hall street exit:

```json
{ "t": 171.35, "lat": 1.2934815, "lon": 103.8523107, "h_accuracy_m": 4.8 }
```

`lat` and `lon` are WGS84 degrees. `h_accuracy_m` is Core Location's horizontal accuracy in metres. GNSS fixes are part of the contributor's trajectory, which is personal data.

## privacy/blur.jsonl

Required. One line per keyframe, including keyframes with no boxes:

```json
{ "frame": 58, "boxes": [] }
{ "frame": 812, "boxes": [
    { "x": 1204, "y": 388, "w": 96, "h": 112, "kind": "face" },
    { "x": 1188, "y": 352, "w": 132, "h": 150, "kind": "person_head" },
    { "x": 402, "y": 905, "w": 180, "h": 104, "kind": "screen" } ] }
```

- `kind` is `face`, `person_head` or `screen`.
- Boxes are integers in keyframe pixel coordinates: `image_size`, native landscape orientation, origin top left, y down.
- Each box is the padded region that was actually obscured, not the raw detection.
- The module's `writeBlurredJPEG` writes the line in the same step as the JPEG.

## mesh/scene.ply

Binary little-endian PLY of the ARKit scene mesh:

```
ply
format binary_little_endian 1.0
element vertex 184213
property float x
property float y
property float z
element face 352907
property list uchar uint vertex_indices
property uchar classification
end_header
```

- Vertices are in the ARKit world frame, with each mesh anchor's transform applied as read at session end. Mesh anchors are concatenated; vertices are not merged across anchors.
- Every face is a triangle, as in ARKit's mesh: its `vertex_indices` list has 3 entries, so each face record is 14 bytes (the count, three `uint` indices, the classification) and readers can rely on that.
- `classification` holds the raw `ARMeshClassification` value of each face:

| Value | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Class | none | wall | floor | ceiling | table | seat | window | door |

## Privacy rules (non-negotiable)

The rules are in [0005](decisions/0005-privacy-by-design.md). What they mean for a bundle:

- **Blur before writing.** Unblurred images never enter the bundle. Every keyframe goes through the module's one `writeBlurredJPEG` path, which blurs before the JPEG is encoded, and the JPEG holds only that blurred image: no thumbnail or second image ([Keyframes](#keyframes-depth-and-confidence)).
- **Blur is irreversible:** a solid fill, or pixelation with cells of 16 px or larger, over a padded box.
- **What is blurred:**
  - faces (`VNDetectFaceRectanglesRequest`);
  - the head region of every detected person (`VNDetectHumanRectanglesRequest`), as a backstop for faces the face detector misses, such as a small far face or the back of a head;
  - screens: personal devices plus any display showing people. Apple Vision has no screen detector, so the module uses a permissively licensed Core ML model chosen in the Phase 1 spike with a fixture benchmark. Never Ultralytics YOLO (AGPL-3.0). The model and its licence are recorded in ADR 0005.
- **Every box is recorded** in `privacy/blur.jsonl`, and the detector versions in the manifest.
- **Tested.** Fixture images (a poster face, a small far face, the back of a head, a phone screen) run on the macOS CI runner, and `privacySelfTest()` must pass on the device, because Vision on macOS can differ from iOS. Any change to the module's image code must keep the blur tests passing.
- **Server re-check.** A processing worker re-runs detection on every keyframe and quarantines keyframes that still show a sharp face, on every publish path, the owner's included. [0005](decisions/0005-privacy-by-design.md) has the rule, the threshold at which the whole bundle fails, and what a still-sharp screen does. A quarantined keyframe's files are removed from the stored bundle, and its frame index is recorded in `captures.quarantined_frames`.
- **Private.** Bundles live in private storage in Singapore, never on Cloudflare, and nothing in a bundle is served publicly, anchor photos included. Poses, IMU samples, timestamps and GNSS fixes are the contributor's personal data ([0005](decisions/0005-privacy-by-design.md)).

## Ingest and validation

When the upload completes, ingest enqueues validation on the job queue. Validation and the privacy re-check run in processing workers, never in the API process.

**Hardening:**

- Limits, sized for a 3 to 5 minute segment with plenty of headroom (the example segment above, 2 min 38 s, has 4210 frames and 312 keyframes). They are `DEFAULT_BUNDLE_LIMITS` in `packages/contracts`; raise one if real bundles come close.

  | Limit | Value | Applies to |
  | --- | --- | --- |
  | `maxBundleBytes` | 2 GiB | The tar, or the sum of a directory's files: 128 upload parts of 16 MiB, so a bundle within the limit can always be uploaded |
  | `maxUploadParts` | 128 | Parts of 16 MiB (16,777,216 bytes, `UPLOAD_PART_BYTES`). The API enforces it when it creates the multipart upload; the validator sees only the reassembled tar |
  | `maxEntries` | 20,000 | Tar members or directory entries, directories included |
  | `maxJsonBytes` | 16 MiB | Each JSON file, which is read into memory |
  | `maxJsonlBytes` | 256 MiB | Each JSONL file, which is streamed |
  | `maxJsonlLineBytes` | 64 KiB | One JSONL line |
  | `maxJpegBytes` | 16 MiB | Each keyframe JPEG |
  | `maxImagePixels` | 16,777,216 (4096 × 4096) | Pixels in a keyframe, `image_size` width × height. The JPEGs must have that size and `depth_size` is fixed, so this bounds what processing decodes. Processing still sets its own decoder pixel limit |
  | `maxPngBytes` | 4 MiB | Each depth or confidence PNG |
  | `maxPlyBytes` | 256 MiB | `mesh/scene.ply` |
  | `maxPlyHeaderBytes` | 4 KiB | The PLY header |
  | `maxPlyVertices` | 5,000,000 | PLY vertices, checked before the body is read |
  | `maxPlyFaces` | 10,000,000 | PLY faces, checked before the body is read |

- The tar is read once, as a stream. Its members must be regular files or directories under one `capture-<capture_id>/` directory, whose name matches `manifest.capture_id`. Rejected: absolute paths, `..`, empty or `.` segments, backslashes, control or non-ASCII characters, links, devices and FIFOs, duplicate names, bad header checksums, a cut-short tar, and anything but zero padding after the end-of-archive marker. Only plain ustar is read (POSIX or GNU-style headers, octal sizes): pax and GNU extension headers, such as long names, are rejected. `packBundle` writes plain ustar, and every bundle path fits in the 100-byte name field. A bundle directory is walked without following links.
- Every member is listed in `manifest.files`, and every listed file is present, with matching byte count and SHA-256. When a stored bundle is validated again, the files of the keyframes in `captures.quarantined_frames` (in `keyframes/`, `depth/` and `confidence/`) are expected to be missing but still listed, and their lines in `poses.jsonl` and `privacy/blur.jsonl` stay. A quarantined frame must be a keyframe and not an anchor photo.
- `mesh/scene.ply` is stream-parsed, with the header's element counts checked against limits before anything is allocated.
- Keyframe JPEGs and PNGs are walked to their end marker without decoding pixels. Schema validation stops at the first error in each document or line, and a JSONL file is parsed only up to its 100th invalid line: after that it can't be used for the cross-file checks, so the rest is only hashed. The cost of validating a bundle grows linearly with its size.
- The validator is fuzz-tested: random byte changes and cuts to the tar, the PLY, the PNGs, the JPEGs and the JSONL give a report, never an exception or a hang.

**Checks:**

- `schema_version` is 1, and every JSON and JSONL file validates against its schema in `packages/contracts` (Ajv). JSON is UTF-8 without a byte order mark; a blank JSONL line is invalid.
- `frame_count` and `keyframe_count` match `poses.jsonl`. Each keyframe has a JPEG, a depth PNG and a `privacy/blur.jsonl` line, plus a confidence PNG if any are present. Images and blur lines exist only for keyframes, and each `refined_keyframes.jsonl` line is for a keyframe.
- `frame` and `t` strictly increase within each JSONL file: each value is greater than the one on the line before, so a repeated value fails. This holds for `t` in `imu.jsonl` and `gnss.jsonl` too, so the writer drops a sample whose `t` equals the previous one (Core Location can deliver the same fix twice). Values in different files are not compared.
- `depth_size` is `[256, 192]`. `image_size` and `depth_size` are landscape (width at least height) and have the same aspect ratio, and `image_size` is within `maxImagePixels`. JPEG sizes (from the frame header) equal `image_size`; depth and confidence PNG sizes (from IHDR) equal `depth_size`. Depth PNGs are 16-bit greyscale and confidence PNGs 8-bit greyscale.
- Keyframe JPEGs are complete (SOI, a frame header, at least one scan, EOI, and nothing after EOI), 3-component colour, and carry no JFIF, JFXX or Exif thumbnail and no MPF segment. Depth and confidence PNGs are complete (IHDR first, an IDAT, IEND last, and nothing after IEND).
- Exactly one `start` and one `end` anchor, and each anchor's `photo` is a keyframe in the bundle. `facing` is horizontal and of unit length within 0.001: |y| ≤ 0.001 and |length − 1| ≤ 0.001.
- Each tag's `frame` is in `poses.jsonl`.
- Blur boxes lie inside the image, and the privacy counts match `privacy/blur.jsonl`.
- PLY header exactly as above, with only the two counts varying (no comments or other properties); every face is a triangle, every vertex index is below the vertex count, and `classification` values run from 0 to 7.
- The share of frames with `limited` tracking is reported.

**The validator** is TypeScript: the `packages/contracts` schemas plus a CLI, `validate-bundle <path> [--json] [--quarantined 812,1004]`, where the path is a bundle directory or its tar. It exits 0 for a valid bundle, 1 for an invalid one and 2 when the bundle can't be read. Every problem has a stable code, the file and a message; `--json` prints the report, whose `failure_reason` ingest stores. Messages name files, lines and frames, never pose, time or GNSS values; a wrong `schema_version` is described by its type, and an unknown field's name is escaped and cut short. Checks beyond this doc are warnings, which don't make a bundle invalid: a transform whose last row isn't [0, 0, 0, 1] (written row-major), wall-clock times out of order, non-finite PLY vertices or bytes after the last face, a PNG whose IHDR CRC is wrong, and a preview that isn't a JSON object. Ingest uses the validator, and it runs on Windows against recorded bundles, without a phone. It replaces the planned Python validator.

## Open points

| Open point | Decided |
| --- | --- |
| Which registration approach the app uses | Phase 1 spike ([0008](decisions/0008-anchors-and-georeferencing.md)) |
| Which side of a door `facing` points to, so two segments that mark the same door from opposite sides agree | With the registration approach, Phase 1 spike |
| How two bundles refer to the same new anchor before it has a server ID (both carry `anchor_id: null`) | With the registration approach, Phase 1 spike |
| Where an image anchor's reference image and physical size are kept, so later sessions can detect the sign | With the registration approach, Phase 1 spike |
| With `continuous_session`, when the session-end reads (`refined_keyframes.jsonl`, mesh transforms) happen for each segment's bundle | With the registration approach, Phase 1 spike |
| The screen detector model and its licence | Phase 1 spike ([0005](decisions/0005-privacy-by-design.md)) |
| The server-side screen detector, and what a still-sharp screen does | Phase 2 screen re-check task ([0005](decisions/0005-privacy-by-design.md)) |
| Which side writes `gnss.jsonl` | Phase 2, with the street priors |
| Size and count limits | Set with the validator: see [Hardening](#ingest-and-validation). Raised if real bundles come close |
| The quarantine threshold (starts at 5%); the drift threshold (starts around 1 m) | Tuning values from Phase 2 data |
