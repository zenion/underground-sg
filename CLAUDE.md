# Underground SG

A free public map of downtown Singapore's underground pedestrian links and mall interiors: it shows where you are and routes you between two street-level points through the underground. Maps are captured with iPhone LiDAR and published after moderation.

**Read `docs/spec.md` first.** It is the source of truth for product behaviour. The decisions in `docs/decisions/` explain why things are the way they are.

## Status

Pre-code. Nothing is scaffolded yet. Current phase: **1, Groundwork** (see `docs/backlog.md`). The MVP covers only the City Hall cluster (City Hall MRT, Funan, Raffles City, CityLink, Esplanade MRT).

## Planned layout

```
apps/
  mapper-ios/        Swift + ARKit mapper app: capture, on-device preview, draft editing, testing
  web/               Next.js + React + MapLibre GL JS public webapp
services/
  api/               Python, FastAPI: ingest, map snapshots, moderation, localization endpoint
  processing/        Python workers: reconstruct, align, georeference, extract, diff, index
  localization/      image retrieval + feature matching, pose solve
packages/
  map-style/         one MapLibre style shared by web and iOS
  routing/           cost model + router (TypeScript); keep the iOS port in step
db/
  schema.sql         PostGIS schema (draft v0); move to migrations once the API exists
docs/
  spec.md, backlog.md, capture-bundle.md, decisions/
```

Create directories as work starts. Don't scaffold empty ones.

## Rules that must not break

- **Privacy** (`docs/decisions/0005-privacy-by-design.md`): blur faces and screens on the phone before writing any image; never store or log localization query photos; raw bundles are private. Add a test whenever an image path changes.
- **Moderation:** nothing reaches the public map without an approved change set. The only exception is the owner publishing mapper-mode work, recorded as `auto_published`.
- **Public walkways only:** never model or publish back-of-house, service or security areas.
- **Snapshots are immutable:** never edit a published `map_versions` snapshot. Publish a new version instead.

## Conventions

- Geometry is stored in WGS84 (EPSG:4326). Do metric work in SVY21 (EPSG:3414); never measure in degrees.
- `ordinal` is a city-wide height band: 0 = street, -1 = B1, -2 = B2. Venue-signed names ("B2") live in `levels.name`.
- Units are metres and seconds. Times are `timestamptz`, displayed in Asia/Singapore.
- Capture bundles follow `docs/capture-bundle.md`. Change that doc first, then both sides, and bump `schema_version`.
- Routing cost and penalties live in one shared config (`docs/decisions/0003-routing.md`).
- Base data: OneMap for tiles and surveyed coordinates (needs an API account), OSM for footpaths. Keep attribution visible on every map view.

## Environment

- The owner's machine is Windows. Backend and webapp run fine there or in WSL. Use Docker for PostGIS (`postgis/postgis` image).
- The iOS app needs macOS, Xcode and an iPhone Pro or iPad Pro with LiDAR. It can't be built on Windows.
- No secrets in the repo. OneMap credentials and storage keys go in `.env` files, which are git-ignored.

## How to work here

- Pick tasks from `docs/backlog.md` and tick them off when done. Add tasks you discover.
- When a decision changes, update `docs/spec.md` and add or amend a record in `docs/decisions/` in the same change.
- Keep changes small, with tests. Spatial code gets tests with real coordinates from the City Hall cluster.
- Open questions are listed at the end of the spec's "Risks and open questions" section. Ask rather than guess on those.
