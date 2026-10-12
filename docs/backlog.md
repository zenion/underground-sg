# Backlog

Tasks for phases 1 and 2 of the MVP (see "Milestones" in `spec.md`). Tick items off as they land; add new ones where they belong. **[Owner]** marks tasks only Josh can do; everything else is code Claude Code can pick up.

## Phase 1: Groundwork

Gate: one venue gives written permission to scan.

### Owner tasks

- [ ] [Owner] Site walk of the City Hall cluster: confirm the boundary and list every public level, exit and link
- [ ] [Owner] Permission request to Funan's landlord for the B2 UPL (first ask), then Raffles City and CityLink
- [ ] [Owner] Ask the MRT operator and LTA about scanning station concourses
- [ ] [Owner] Register a OneMap API account; check the terms for tiles and attribution
- [ ] [Owner] Decide the map data licence (ODbL or not; see 0003)
- [ ] [Owner] Get a Mac with Xcode, plus an iPhone Pro or iPad Pro with LiDAR, for the mapper app

### Repo and data

- [ ] Monorepo scaffold per `CLAUDE.md`: `.editorconfig`, Python (uv) and Node (pnpm) workspaces, lint and format, CI running tests
- [ ] `docker-compose.yml` with PostGIS and MinIO (S3-compatible); a script that applies `db/schema.sql`
  - Done when: `docker compose up` followed by the script gives an empty, valid database
- [ ] Move `db/schema.sql` into a migration tool (Alembic) once `services/api` exists
- [ ] OSM import: fetch footways, pedestrian ways and crossings for the cluster's bounding box (Overpass API) into `osm_footpaths`, setting `covered` from tags
  - Done when: the import is re-runnable, idempotent, and has a test with a small saved Overpass response
- [ ] Seed script: venues and levels for the five core venues, with ordinals (names from the site walk)

### API skeleton (`services/api`)

- [ ] FastAPI app with health check, settings from `.env`, tests
- [ ] `GET /map/latest`: metadata for the latest `map_versions` row and the snapshot URL
- [ ] Snapshot writer: dump HEAD (venues, levels, spaces, nodes, edges, pois) to one JSON file, plus a test that round-trips it
- [ ] Snapshot format doc in `docs/` (aim close to IMDF GeoJSON features)

### Webapp skeleton (`apps/web`)

- [ ] Next.js + MapLibre GL JS page showing OneMap base tiles centred on City Hall, with attribution
- [ ] Load the latest snapshot and draw spaces, nodes and edges for one level
- [ ] Level switcher: the current level in full, other levels faded
- [ ] Shared style in `packages/map-style`

### Mapper app prototype (`apps/mapper-ios`, needs a Mac)

- [ ] ARKit session with `sceneReconstruction = .meshWithClassification` and scene depth; live mesh overlay
- [ ] Anchor flow: start anchor (pick existing or new, take a photo) → walk → end anchor
- [ ] Tag buttons while walking (exit, escalator, lift, stairs, toilet, door), positioned from the current camera pose
- [ ] Face and screen blur with Vision before any JPEG is written, plus a unit test with a sample image
- [ ] Write a bundle matching `docs/capture-bundle.md` to local storage

### Shared

- [ ] Bundle validator (Python, `services/processing`): checks a bundle against `capture-bundle.md`, usable as a CLI and by ingest
  - Done when: it passes a hand-made minimal bundle and fails each missing required file with a clear message

## Phase 2: Capture pilot (Funan UPL)

Gate: captured segments align end to end on the street map.

- [ ] On-device floor-plan preview: take floor-classified mesh faces, flatten to 2D, union, simplify to a walkable polygon; draw over OneMap tiles
- [ ] On-device drift check at the end anchor; show `drift_m` and a pass/re-walk prompt. The threshold is a tuning value; start around 1 m and adjust from pilot data
- [ ] Coverage overlay: mark gaps and low-confidence areas to re-walk
- [ ] Private draft map on the phone: stitch accepted segments, move nodes, retag, redraw outlines
- [ ] Resumable upload to `POST /captures` (bundle → MinIO), Wi-Fi only by default
- [ ] Ingest job: validate, re-run the privacy check (reject on failure), set `captures.status`
- [ ] Georeference: fit a 2D similarity transform per segment from anchors with `surveyed_geom` (in SVY21), report residuals per anchor
  - Done when: a test with synthetic anchors recovers a known transform, and residuals are stored on the capture
- [ ] Pose refinement and meshing (COLMAP + Open3D) as a background job; sync the refined result back to the phone's draft
- [ ] Extraction v0: floor polygons, centreline edges, tag nodes → a `change_sets.diff`
- [ ] Field test: walk the Funan B2 → City Hall UPL in both directions, record drift and residuals, write up results in `docs/`

## Later phases

Phase 3 (map and routing) and phase 4 (locate and launch) get broken down once the phase 2 gate passes.
