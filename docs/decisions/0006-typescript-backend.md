# 0006: TypeScript on Node for the backend, Go only for localization

Status: accepted · 2026-10-12

## Decision

The server side is TypeScript on Node. The one exception is the localization service (Phase 4), which is Go. Python never runs in the API or the localization serving path.

| Component | Choice |
| --- | --- |
| API (`services/api`) | Node 26 (the latest release; the owner tracks the newest Node rather than only LTS), Fastify 5, Kysely with raw SQL for geometry (`ST_AsGeoJSON` out, `ST_GeomFromGeoJSON` in) |
| Jobs | A Postgres-backed job queue, no Redis: pg-boss or graphile-worker, chosen in the Phase 1 job-queue task |
| Processing (`services/processing`) | TypeScript workers in separate processes, never in the API process. ONNX Runtime (onnxruntime-node) for the privacy re-check |
| Localization (`services/localization`, Phase 4) | Go with its own `go.mod`: onnxruntime_go, PoseLib through a cgo shim, built in a Linux container ([0002](0002-photo-localization.md)) |
| Contracts (`packages/contracts`) | JSON Schema 2020-12 files are the source of truth for every file format and API |
| Migrations | dbmate, plain SQL in `db/migrations/` |
| Database | Postgres 18 + PostGIS 3.6 (`postgis/postgis:18-3.6`) |
| Monorepo | pnpm workspaces + Turborepo, Vitest, TypeScript strict, Biome for lint and format (chosen in the scaffold task: one fast tool, no plugin stack to keep in step) |

Python is allowed in two places only:

- **Offline tooling**, such as one-off model exports to ONNX and evaluation scripts.
- **Containerised batch workers** driven by the Node job queue, for example a COLMAP 4.x / pycolmap step, if Phase 2 data shows refinement is needed.

## Why

- **The owner's constraints.** Development happens only on Windows and WSL, with no Mac, and there is no Python in core systems. Go and Node were the preferred options.
- **Performance does not decide it.** The public map is a CDN-cached file, bundles go straight from the phone to object storage, and moderation traffic is a handful of people. The heavy compute is C++ (COLMAP, PoseLib) or ONNX Runtime, whichever language calls it; the server language changes the glue code, not the speed of the maths.
- **One language for one developer.** The mapper app and the webapp are TypeScript ([0001](0001-mapper-app-and-public-webapp.md)). With a TypeScript server, shared packages run on the phone and the server without a port: `packages/floorplan` turns floor triangles into a walkable polygon in Hermes on the phone and in processing, and `packages/contracts` gives the app, the bundle validator and ingest the same types and schemas.
- **Localization is different.** It is a latency-bound serving path with large models. `onnxruntime-node` runs inference on the JavaScript main thread, so Node would need worker threads that each load their own copy of models of up to about 0.9 GB. In Go, goroutines can share one onnxruntime_go session, and PoseLib needs a native shim anyway.

## Consequences

- **Contracts are JSON Schema.** They would have to be anyway, because the Swift bundle writer reads the same formats. TypeScript types are generated with json-schema-to-typescript, runtime validation uses Ajv, Swift Codable types are generated with quicktype, Fastify route schemas reference the same files, and @fastify/swagger emits the OpenAPI document. CI regenerates everything and fails on a diff.
- **Heavy work never runs in the API process.** CPU-bound steps (PLY and depth parsing, the network adjustment, ONNX privacy checks) run in separate worker processes fed by the job queue. Workers load onnxruntime-node; the API does not.
- **Geometry goes through raw SQL.** TypeScript query builders barely know PostGIS, so geometry crosses the boundary as GeoJSON text with explicit casts, and metric work stays in PostGIS (`ST_Transform(..., 3414)`).
- **The job queue lives in Postgres.** One fewer service to run on the owner's PC and later on the small server ([0009](0009-hosting-and-budget.md)). `POST /captures` inserts the `captures` row and starts the multipart upload; when the upload completes, the API sets `captures.status = 'uploaded'` and enqueues validation in one transaction. The queue chosen in the Phase 1 job-queue task must allow that.
- **Migrations are plain SQL.** dbmate runs SQL files from `db/migrations/`. `db/schema.sql` stays the draft until the Phase 1 migration task turns it into the first migration.
- **The bundle validator is TypeScript.** It uses the `packages/contracts` schemas plus a CLI, runs in ingest, and runs on Windows against recorded bundles. It replaces the planned Python validator.
- **Node has an upload trap.** `@fastify/multipart`'s `saveRequestFiles` and multer's disk storage write uploads to temp files. Any image that reaches Node streams to private storage or stays in memory, with a test ([0005](0005-privacy-by-design.md)).
- **Go stays in one place.** Only `services/localization` is Go. It needs cgo for PoseLib and ONNX Runtime, so it is built in a Linux container; nothing uses cgo outside Linux containers, so the Windows host needs no C toolchain.
- **Python stays in containers or offline.** A Python batch step runs in its own container image, driven by the Node job queue; it never serves requests. Offline tooling includes the LightGlue-ONNX exporter for the localization models.
- **Sign-in can live in the API.** Until Phase 4 the API accepts only the owner: uploads and owner-only routes authenticate with a per-device token (the phone keeps its token in the iOS Keychain), which sets `captures.contributor_id`. When contributors arrive in Phase 4, a TypeScript auth library can run in the API process; Better Auth is the likely choice, confirmed in Phase 4.

## Alternatives considered

- **Go for every server component.** This was the stack review's original recommendation: Go 1.27 with the oapi-codegen strict server, pgx v5 + sqlc, goose migrations and River. Its advantages are real: CPU-bound glue uses every core without fighting an event loop, pgx is solid on PostGIS, and the API would be a single static binary. They are not decisive here. CPU-bound work moves to worker processes, PostGIS is reached through raw SQL either way, and Go is kept where it matters most, in localization. Go everywhere would mean a second language for one developer and no shared code between the phone and the server.
- **A TypeScript API with Go for the processing compute.** Two server languages for pipeline glue, while the maths that matters is C++ or ONNX either way.
- **Python (FastAPI and Python workers, as in the first spec).** Ruled out by the owner's constraint. The heavy compute was never Python, and Python remains available for containerised batch steps and offline tooling.
