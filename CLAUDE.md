# Underground SG

A free public map of downtown Singapore's underground pedestrian links and mall interiors: it shows where you are and routes you between two street-level points through the underground. Maps are captured with iPhone LiDAR and published after moderation.

**Read `docs/spec.md` first.** It is the source of truth for product behaviour. The decisions in `docs/decisions/` explain why things are the way they are.

## Status

Root tooling is scaffolded (pnpm 12 workspaces, Turborepo, TypeScript 7, Vitest 5, Biome, CI on Ubuntu and Windows), `packages/contracts` has the capture bundle v1 schemas, codegen and the bundle validator (`validate-bundle`), `db/` has the first dbmate migration, the local Docker stack (PostGIS and RustFS) and the database rule tests, `packages/floorplan` turns floor triangles into the approximate walkable outline and coverage grid, and `apps/mapper` is an Expo SDK 57 app (map drawing, the floor-plan benchmark, device checks) with a development build, and the Swift spike has started: `apps/mapper/modules/capture-native` has `getCapabilities()`, `<CaptureView>` with its privacy shield and `CaptureCore`'s candidate gate, built and encoder-checked by the macOS CI job. Current phase: **1, Groundwork** (see `docs/backlog.md`). The stack was decided on 2026-10-12: see `docs/reviews/2026-10-12-stack-review.md` and ADRs 0006-0009; capture recording and replay on 2026-10-17 (ADR 0010, `docs/session-recording.md`). The MVP covers only the Esplanade corridor (ADR 0011), and only levels on the pedestrian network: South Beach to Raffles City through the unpaid B1 level of Esplanade MRT (the Exit F link to South Beach, the Exit G passage to Raffles City's basement), Raffles City's link to City Hall MRT's unpaid concourse at its west end, and Marina Link from Exit B to Marina Square's door (the mall closes on 31 Mar 2027, so its interior is optional). The former City Hall cluster (Funan, the rest of City Hall MRT, CityLink) is the first expansion after the MVP. Scanning needs no venue permission (decided 2026-10-17); the privacy and public-walkways rules below still hold. The owner is the only mapper through Phase 3; contributor sign-up arrives in Phase 4.

## Planned layout

```
apps/
  mapper/                    Expo (React Native, TS) mapper app: capture UI, preview, drafts, route tests, upload
    modules/capture-native/  local Expo module in Swift: ARKit, keyframes, Vision blur, bundle writer, packBundle;
                             the session recorder (development and walk builds only)
  web/                       Vite + React + MapLibre GL JS v6 public webapp; moderation UI as an authenticated route
services/
  api/                       Node, Fastify 5, Kysely: ingest, map snapshots, moderation; publish CLI (`pnpm map`), local demo (`pnpm demo`)
  processing/                TS workers in separate processes: validate, privacy re-check, align, extract, diff
  localization/              Go service, Phase 4 (own go.mod): retrieval, feature matching, pose solve
packages/
  contracts/                 JSON Schema 2020-12 for every file format and API; TS and Swift types generated
  routing/                   cost model + router, used by web and mapper (no port)
  map-style/                 one MapLibre style shared by web and mapper
  floorplan/                 floor triangles to walkable polygon; runs in Hermes and in processing
  recording/                 session recordings on the PC: reader, meshAt(t), deriveBundle, synthetic sets, `pnpm rec`
db/                          @usg/db: migrations, schema snapshot, dbmate wrapper, seed script, database rule tests
  migrations/                dbmate, plain SQL: the schema is defined here
  seed/                      the seed script's dataset (`pnpm db seed`): core venues; levels after the site walk
  schema.sql                 generated snapshot of the migrated schema (`pnpm db dump`); never edit by hand
scripts/                     @usg/scripts: scripts for the local stack (`pnpm buckets`)
docker-compose.yml           local stack: PostGIS and RustFS; settings in .env (copy .env.example)
docs/
  spec.md, backlog.md, capture-bundle.md, session-recording.md, decisions/, reviews/
  snapshot-format.md, diff-format.md, head-export-format.md, phone-testing.md
```

Create directories as work starts. Don't scaffold empty ones.

## Rules that must not break

- **Privacy** (`docs/decisions/0005-privacy-by-design.md`):
  - Blur faces, the heads of detected people and screens on the phone: every keyframe and recorded candidate through the one `writeBlurredJPEG` path before it is written, and photos taken outside a capture through `blurPhoto(src, dst)` before they are stored or uploaded, deleting the unblurred source at once. The blur fails closed: a frame is written only after every detector ran on it. The camera view is covered before iOS takes its app-switcher snapshot, and kept out of screenshots and screen recordings. Every other image path (anchor photos, status evidence, landmark crops) follows ADR 0005.
  - Never store or log localization query photos or feature payloads. Raw bundles, session recordings, anchor photos and contributor trajectories are private. Logs name files, lines and frames, never poses, times, GNSS fixes or boundary values.
  - Recordings and anything pose-bearing (poses, transforms, floor triangles, GNSS fixes, boundary traces) never pass through Metro or any TLS-terminating tunnel. Every capture in a venue uses the walk build, whose JavaScript is embedded; `pnpm dev:phone` is for desk testing only. The recorder is compiled only into the development and walk builds, never contributor builds, and only the walk build records; the development build's desk checks write no GNSS and never leave the phone (ADR 0010).
  - AI agents, Claude Code included, may run the replay and venue-test tools on anything the phone recorded (`origin: device`, from any build, desk checks included: recordings, bundles, meshes in `.data/`), on what is derived from it in `.data/replays/`, and on the outlines in `db/private/`, but never read its raw contents into a conversation: no poses, timestamps, GNSS fixes, images, boundary traces, mesh vertices or derived geometry, and no screenshots or page reads of the app or the web export while it shows a venue trace or a replay. Never copy such data outside `.data/` (no temp or scratchpad copies). Use only tools that print aggregate results (counts, frame numbers, scores, timings, ages in days, pass or fail), and leave a step that needs someone to look at the data itself to the owner. Screenshots and screen recordings of the capture view are never shared with an agent; debug screenshots show only screens without the camera view.
  - Images that reach Node stream to private storage or stay in memory. Never use `@fastify/multipart` `saveRequestFiles` or multer disk storage.
  - Tests: the CI blur test for any change to the module's image code; the localization test for no temp files and no body bytes in logs; a new test whenever an image path changes.
  - Fixtures in git are synthetic, recorded where the owner is happy to publish them (no images or GNSS fixes), or images used with the subject's consent or under an open licence. Nothing recorded in a venue goes in git, recordings included: keep it in the git-ignored `.data/fixtures/`, and tests that need it skip when it is absent. Only generated synthetic recordings (`origin: synthetic`) are tracked.
- **Moderation:**
  - Nothing reaches the public map except through a published change set: `approved` through `moderator_review`, or `auto_published` through `owner_mapper` (the owner's structural work) or `trusted_status_auto` (status edits). The database enforces who may use each path.
  - The automated gates (privacy re-check, restricted-zone check, alignment residual checks, at least two street priors per connected group) must pass on every path, recorded in `moderation_events`, before a publish path is set. A failed gate or an open privacy flag blocks publishing; the owner or a moderator clears a privacy flag explicitly, and that is recorded too.
  - Every map version except a rollback publishes at least one change set. Seed data (venues and levels) and the imported OSM street graph are written by the owner's scripts, and reach the public files only inside such a version.
- **Public walkways only:** never model or publish back-of-house, service or security areas. Record them as `restricted_zones`: extraction clips against them, and no feature may overlap the interior of one (sharing an edge is fine); the database refuses an overlap. The outlines are private: never commit them, put them in public files or log them.
- **Snapshots are immutable:** never edit a published `map_versions` snapshot. Publish a new version instead.
- **Native boundary:** no per-frame data or images cross from the Swift module into JavaScript. JS gets a session handle, status events at about 5 Hz and compact results.
- **Heavy work never runs in the API process.** It goes to worker processes through the job queue.
- **Languages:** server code is TypeScript on Node; Go only in `services/localization`; Python only for offline tooling and containerised batch workers, never in the API or the localization serving path. cgo only inside Linux containers.

## Conventions

- Geometry is stored in WGS84 (EPSG:4326). Do metric work in SVY21 (EPSG:3414); never measure in degrees.
- `ordinal` is the level switcher's display band: 0 = street, -1 = first basement band, and so on; several levels of one venue may share a band. Physical height is `levels.elevation_m`. Venue-signed names ("B2") live in `levels.name`. Routing never infers a connection from equal ordinals.
- Units are metres and seconds; routing cost is time in seconds. Times are `timestamptz`, displayed in Asia/Singapore; opening hours are evaluated in Asia/Singapore time.
- TypeScript extends `tsconfig.base.json`: strict, erasable syntax only (no enums, namespaces or parameter properties) and `.ts` extensions in relative imports, so Node runs `.ts` files directly. Workspace packages export their TypeScript source, so a consumer typechecks a dependency's source under its own config: packages used by `apps/web` or `apps/mapper` stay environment-neutral (no Node globals or `node:` imports). Bundler packages override only `"module": "preserve"`. Shared tool versions come from the `catalog:` in `pnpm-workspace.yaml`. Biome lints and formats; Vitest tests. Run `pnpm check` before committing.
- Schema changes are new dbmate migrations (`pnpm db new <name>`), each with a `-- migrate:down` that undoes it. Then `pnpm migrate` and `pnpm db dump`, and commit the migration with the regenerated `db/schema.sql`; CI rebuilds the snapshot and fails on a diff. Never edit `db/schema.sql` by hand. Database rules get tests in `db/test/db/` (`pnpm test:db`), with a passing and a refused case that checks the reason (SQLSTATE plus constraint or message).
- `packages/contracts` is the source of truth for every file format and API. After changing a schema, run `pnpm gen` and commit the output; CI regenerates the types and fails on a diff. Schemas stay within the subset Ajv, json-schema-to-typescript and quicktype all handle (rules in `packages/contracts/README.md`).
- Capture bundles follow `docs/capture-bundle.md`. Change that doc first, then `packages/contracts`, then the Swift module and the validator, and bump `schema_version`.
- Session recordings follow `docs/session-recording.md` the same way: the doc, then `packages/contracts`, then the Swift recorder and `validate-recording`, and bump `recording_version`.
- Routing cost and penalties live in `packages/routing/routing-config.json` (`docs/decisions/0003-routing.md`).
- Base data: OneMap raster tiles (the OneMap API account is for search only), the OSM street graph for footpaths, LTA's MRT Station Exit data for exit positions. Keep OneMap, OpenStreetMap and LTA attribution visible on every map view.

## Environment

- Node: the latest release, not only LTS (26.x now), pinned in `.node-version`; CI follows it. pnpm 12, pinned through `packageManager` in `package.json`.
- pnpm refuses versions published less than a day ago (`minimumReleaseAgeStrict`), so it fails instead of falling back. Pin an older version; never add `minimumReleaseAgeExclude` entries, and revert any pnpm writes.
- Tests that read the git-ignored `.data/fixtures/` or need PostGIS or RustFS run as separate uncached Turborepo tasks (for example `test:venue`, `test:db` with `passThroughEnv`), so cached results never hide a skipped or stateful test.
- The owner's machine is Windows. Keep the repo on the Windows filesystem and run Node, pnpm and Expo natively on Windows (Metro in WSL needs mirrored networking or `--tunnel`). Docker Desktop with the WSL2 backend runs PostGIS (`postgis/postgis:18-3.6`) and RustFS as the local S3.
- No Mac. iOS builds run on EAS Build or on GitHub macOS runners; JS changes reach the phone through the dev client and Metro. Escape hatch: a rented cloud Mac for occasional Xcode, Simulator or Instruments days.
- Capture device: iPhone 17 Pro Max on current iOS; avoid iOS 26.4-26.6.0 (LiDAR drift regression). The owner creates the Expo account now (Expo Go on iOS opens a project only when Expo CLI and Expo Go are signed in to the same account) and joins the Apple Developer Program now, before the spike's first build (every build needs it, and enrolment can take days).
- Phone testing goes through tunnels, not the LAN (the Wi-Fi profile is Public): `pnpm dev:phone` runs one ngrok agent, inspection off, with the API on the reserved domain and Metro on a random address whose debugger and other PC-only endpoints ngrok's Traffic Policy refuses (`docs/phone-testing.md`, ADR 0009). Everything it starts listens on loopback only. Only read-only routes, public map data and the app's development code go through it; never bundles, recordings, anything pose-bearing or locate photos. It is for desk testing: walks use the walk build.
- Budget is as low as possible. Phases 1-3 run on the owner's PC: bundles and recordings reach it over USB in Phase 1 (`pnpm rec pull`), and over the home LAN from Phase 2; public map files go to Cloudflare Pages and R2. No GPU without the owner's explicit approval.
- No secrets in the repo, which will be public on GitHub. OneMap credentials and storage keys go in `.env` files, which are git-ignored. Never commit signing files (`credentials.json`, `*.p8`, `*.p12`, `*.mobileprovision`).

## How to work here

- Pick tasks from `docs/backlog.md` and tick them off when done. Add tasks you discover.
- When a decision changes, update `docs/spec.md` and add or amend a record in `docs/decisions/` in the same change.
- Keep changes small, with tests. Spatial code gets tests with real coordinates: existing tests use the City Hall cluster, and new synthetic data prefers the corridor (Esplanade, Raffles City, South Beach).
- Open questions are listed at the end of the spec's "Risks and open questions" section. Ask rather than guess on those.
