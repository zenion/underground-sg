# Capture bundle format (v0, draft)

The contract between the iOS mapper app and the ingest API. One bundle = one segment, walked from one anchor to another. Change it here first, then in both the app and `services/processing`; bump `schema_version` on any breaking change.

## Layout

```
capture-<capture_id>/
  manifest.json          required
  anchors.json           required: start and end anchor
  tags.json              required, may be an empty list
  poses.jsonl            required: one line per frame
  imu.jsonl              optional
  keyframes/<frame>.jpg  required: already blurred on the phone
  depth/<frame>.png      required for keyframes: 16-bit, millimetres
  confidence/<frame>.png optional: ARKit depth confidence (0, 1, 2)
  mesh/scene.ply         required: ARKit scene mesh, per-face classification
  preview/floorplan.geojson  optional: the on-device preview, for comparison with the server result
```

Frame names are zero-padded frame indices (`000123`) and match `frame` in `poses.jsonl`.

## Coordinate frame

Everything inside a bundle is in the ARKit world frame for that session: right-handed, metres, y up (gravity-aligned), origin where tracking started. The server, not the phone, transforms into WGS84/SVY21 during georeferencing. The phone's preview may use an approximate transform for display only.

## manifest.json

```json
{
  "schema_version": 0,
  "capture_id": "uuid (generated on the phone; becomes captures.id)",
  "contributor_id": "uuid",
  "app_version": "0.1.0",
  "device_model": "iPhone16,1",
  "os_version": "iOS 26.0",
  "started_at": "2026-10-20T07:12:03+08:00",
  "ended_at": "2026-10-20T07:14:41+08:00",
  "frame_count": 4210,
  "keyframe_count": 312,
  "drift_m": 0.42,
  "privacy": {
    "blur_method": "VNDetectFaceRectanglesRequest + screen detector",
    "faces_blurred": 17,
    "screens_blurred": 3
  }
}
```

`drift_m` is the gap the phone measured between where the end anchor was expected and where the scan put it. `null` when the end anchor is new and has no expected position.

## anchors.json

```json
[
  { "role": "start", "anchor_id": "uuid or null if new", "name": "Funan B2 UPL door",
    "ordinal": -2, "transform": [16 floats, column-major 4x4, ARKit world], "photo": "keyframes/000004.jpg" },
  { "role": "end", "anchor_id": "uuid or null if new", "name": "City Hall exit A gate",
    "ordinal": -2, "transform": [ ... ], "photo": "keyframes/000305.jpg" }
]
```

## tags.json

```json
[ { "kind": "escalator", "name": null, "frame": 1832, "position": [x, y, z], "note": "up only" } ]
```

`kind` uses the `node_kind` values in `db/schema.sql`.

## poses.jsonl

One JSON object per line:

```json
{ "frame": 123, "t": 4.104, "transform": [16 floats], "intrinsics": [fx, fy, cx, cy],
  "tracking": "normal", "keyframe": true }
```

`tracking` is ARKit's tracking state (`normal`, `limited:<reason>`, `notAvailable`). Processing should down-weight or drop `limited` frames.

## Privacy rules (non-negotiable)

- Unblurred images never enter the bundle. Blur happens before the JPEG is written.
- Ingest re-runs detection and rejects the whole bundle (`captures.status = 'failed'`, `failure_reason = 'privacy'`) if it finds an unblurred face.
- Bundles live in private storage only. Nothing in a bundle is served publicly except derived, re-checked landmark crops chosen for directions.
