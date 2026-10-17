# 0008: Anchors, alignment and georeferencing

Status: accepted · 2026-10-12 · amended 2026-10-15, 2026-10-17

## Decision

### Anchors are physical features

An anchor is a physical feature, not the phone's pose when the mapper tapped.

| `anchor_kind` | What it is |
| --- | --- |
| `floor_point` | An ARKit raycast to the floor at a door threshold or fare-gate line, plus the direction the door faces |
| `image_anchor` | An `ARImageAnchor` on a permanent planar sign, which gives a repeatable 6-DoF pose |

- Each anchor keeps a private reference photo (`anchors.photo_uri`) so it can be found again.
- `anchors` also stores `level_id` (NULL for street anchors), `facing_deg` (the direction the door or sign faces, in degrees clockwise from grid north in SVY21) and `ordinal`, which a trigger keeps in step with `levels.ordinal` like `nodes.ordinal` (0 without a level).
- In the bundle, `anchors.json` records each anchor's `kind`, `point`, `facing`, `transform` and `registration` ([capture-bundle.md](../capture-bundle.md)).

### Cross-session registration (the hinge problem)

Every ARKit session starts with an arbitrary heading. Segments joined only at anchor points can rotate freely around them, like a hinge. Candidate fixes:

1. `ARWorldMap` relocalization at the start anchor (try this first);
2. one continuous session across consecutive segments;
3. image anchors on signs;
4. a relative pose from the anchor photo plus depth.

The approach is chosen in the Phase 1 spike, whose exit criterion is that it works on a real door, and built out on the Phase 2 pilot. The on-device drift check depends on the same fix. Each anchor in the bundle records how it was registered: `world_map`, `continuous_session`, `image_anchor` or `none`.

### When drift can be computed

`drift_m` can only be computed when the end anchor already has a position in the current session's frame:

- an existing anchor, reached through registration; or
- a walk back to the start (loop closure).

Otherwise it is null. Capture guideline: walk segments out and back, or close loops, where practical. The drift threshold is a tuning value, starting around 1 m. Every segment records `os_version` and `device_model` with its drift.

### Refined keyframes

The `camera.transform` values logged in `poses.jsonl` are snapshots that jump at ARKit loop closures, while ARAnchors and mesh anchors are refined later. The module adds an ARAnchor at each keyframe and re-reads its transform at session end, into `refined_keyframes.jsonl` (`{frame, transform}`). Mesh vertices are written with the mesh anchor transforms read at session end.

Whether ARKit refines keyframe anchors at all is measured in the spike (amended 2026-10-17). An Apple engineer said in August 2026 that the world map is optimised without anchor update notifications, so the session recorder samples anchor transforms on its own timer rather than waiting for updates ([0010](0010-capture-recording-and-replay.md)). The result decides whether an ARAnchor per keyframe is worth its cost; the recorded anchor history and actions also feed the choice of registration approach.

### One network adjustment

Alignment and georeferencing are one network adjustment per connected group of segments. It replaces the per-segment 2D similarity fit.

- Unknowns: x, y, z and yaw per anchor. ARKit is gravity-aligned and metric, so there is no roll, pitch or scale to solve.
- Each segment adds one relative constraint between its anchors, with a sigma of about 1% of the distance walked.
- Street-facing anchors are absolute priors with metre-level sigma (`anchors.prior_sigma_m`).
- Level elevations (`levels.elevation_m`, where measured) are soft height priors.
- Solve with Gauss-Newton on a small dense system. A cluster has well under 800 unknowns.
- Spread each segment's end correction along its walk by cumulative distance.
- Work in SVY21 (EPSG:3414) and convert to WGS84 for storage with `ST_Transform`.
- Store each segment's transform and the residuals at its start and end anchors in `segment_alignments` (`solve_id`, `tx_m`, `ty_m`, `tz_m`, `yaw_rad` in the SVY21 frame, `start_residual_m`, `end_residual_m`).
- Open: where each anchor's solved position and yaw, and its residual against its street prior, are stored (columns, or a per-solve anchor table). Decided in the Phase 2 network-adjustment task and recorded here, with a migration.
- The solve runs in a processing worker, never in the API process.

### Street priors

OneMap search returns address and building points, not door positions. Prior sources (`anchors.prior_source`, a `street_prior_source`):

| Value | Source |
| --- | --- |
| `lta_exit` | LTA's MRT Station Exit GeoJSON on data.gov.sg (Singapore Open Data Licence), for the City Hall and Esplanade exits |
| `gnss` | Phone GNSS fixes at street exits, recorded in the bundle's `gnss.jsonl` with their accuracy |
| `imagery` | Careful placement on imagery |
| `onemap` | A OneMap search result: an address or building point, not a door |

`prior_source` and `prior_sigma_m` are NULL unless `surveyed_geom` is set. Every connected group needs at least two widely spaced street priors before it can be published.

`anchors` is a HEAD table ([0004](0004-storage-and-versioning.md)). New anchors and street priors enter it only through an approved change set, as diff entries with `feature_type` `anchor`. Before approval the adjustment works from the bundles' anchor observations and the prior candidates (LTA exits, GNSS fixes); it never writes to `anchors` directly.

An anchor that a capture starts or ends on (`captures.start_anchor_id`, `captures.end_anchor_id`) is never removed from HEAD: every later network adjustment needs it, and removing it would drop that segment's constraint. Diffs never remove one, approval sends a change set that does to `needs_rebase` ([diff-format.md](../diff-format.md#approval)), and the foreign keys have no `ON DELETE` action, so the database refuses it too. Anchors are private, so one whose door or sign is gone does no harm on the public map; how to retire such an anchor (a flag, or leaving it out of the solve) is decided when it first happens.

### Structure-from-motion deferred

ARKit poses, registration and the network adjustment come first. COLMAP 4.x (the C++ command-line tool, or pycolmap, in a container driven by the job queue, with ARKit poses as priors) is switched on only if Phase 2 shows any of:

- more than about 20% of segments with drift over 1 m;
- network residuals over 1-2 m;
- overlays crossing walls.

No Open3D or TSDF re-meshing: apply each segment's correction to the ARKit mesh.

## Why

- With anchors as tap poses, the adjustment is under-determined: segments hinge at shared anchors. The same anchor tapped twice also differs by roughly 0.5-1 m and several degrees, which is as large as the drift being measured.
- Most segments have zero or one street-facing anchor, so a per-segment fit is under-determined. A similarity fit also adds a free scale term that LiDAR does not need. A joint adjustment shares the street priors across the whole group.
- One street prior fixes a group's position but leaves it free to rotate around that point. Two widely spaced priors fix the rotation too.
- Logged poses and the mesh can disagree after ARKit's later corrections. Refined keyframe poses keep them consistent, and localization needs them (0002).
- Published ARKit LiDAR drift is about 0.1-1% of the distance walked, but that evidence comes from closed loops and motion-capture rooms. "Sub-metre after anchor correction" is a hypothesis for Phase 2 to test before adding a heavy SfM step.

Background and sources: [stack review](../reviews/2026-10-12-stack-review.md), sections 4 and 7 (item 1).

## Consequences

- Backlog test: recover a known transform for a chain of 4 synthetic segments where only the two ends have street priors, using real coordinates on the MVP corridor (Esplanade Exits F and C and the Raffles City door; amended 2026-10-17).
- Capture bundle v1 carries the anchor `kind`, `point`, `facing` and `registration`, plus `refined_keyframes.jsonl` and `gnss.jsonl` (`schema_version` 1).
- Mapping practice: anchors at door thresholds, fare-gate lines or permanent signs; out-and-back walks or loops; a GNSS fix at each street exit.
- What counts as "widely spaced", and the residual thresholds that gate publishing, are tuning values set from the Phase 2 data.
- If the photo-plus-depth fix is chosen, a small ALIKED/LightGlue matching step moves forward from Phase 4 into Phase 2, and `registration` needs a new value: change [capture-bundle.md](../capture-bundle.md) first and bump `schema_version`.
- If COLMAP is switched on, it runs as a containerised batch worker driven by the job queue; Python, if used there, follows the rules in [0006](0006-typescript-backend.md). Nothing in the MVP pipeline needs a GPU; a GPU needs the owner's approval.
- GNSS fixes are part of the contributor's trajectory, which is personal data ([0005](0005-privacy-by-design.md)).
- LTA exit data needs its attribution alongside OneMap and OSM. LTA refreshes it every 6 months, so re-check the priors on each refresh.
