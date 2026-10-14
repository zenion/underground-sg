# Underground SG

Find your way through downtown Singapore's underground links and malls: see where you are, and get a route between two street-level points that stays underground.

Status: Phase 1. The stack was decided on 2026-10-12 and the monorepo is scaffolded; no apps or services are built yet. The MVP covers the City Hall cluster: City Hall MRT, Funan, Raffles City, CityLink Mall and Esplanade MRT.

## Docs

| File | What it is |
| --- | --- |
| [docs/spec.md](docs/spec.md) | Product and technical spec, the source of truth |
| [docs/backlog.md](docs/backlog.md) | Tasks by phase, in detail for phases 1 and 2 |
| [docs/capture-bundle.md](docs/capture-bundle.md) | Format of a capture upload, shared by the mapper app and the server |
| [docs/snapshot-format.md](docs/snapshot-format.md) | The public map files: `latest.json`, each version's `indoor.json` and `street.json`, and the `status.json` overlay |
| [docs/diff-format.md](docs/diff-format.md) | A change set's diff, and how approval applies it to the map |
| [docs/decisions/](docs/decisions/) | Why the key choices were made |
| [docs/reviews/](docs/reviews/) | Background research behind the decisions, such as the 2026-10-12 stack review |
| [db/](db/) | The PostGIS schema: dbmate migrations, a generated `schema.sql` snapshot and the database rule tests |
| [CLAUDE.md](CLAUDE.md) | Working context for Claude Code |

## How it works

1. A mapper walks a corridor with a LiDAR iPhone Pro, from one fixed anchor to another, and checks the floor-plan preview on the spot. The mapper app is built with Expo; a Swift module captures the LiDAR scan and blurs faces and screens before any image is saved.
2. The server checks privacy again, aligns the scan to the street map using the anchors, and puts the changes up for review.
3. Approved changes are published as a new, immutable map version.
4. The public webapp shows that version over the OneMap street map and routes through it. Locating you from a single photo comes in Phase 4.

## Development

You need Node 26 (the repo follows the latest Node release), pnpm 12 and Docker Desktop (WSL2 backend on Windows). The repo pins pnpm through `packageManager` in `package.json`.

```bash
pnpm install
```

```bash
pnpm check
```

`pnpm check` runs Biome (lint and format check), then typecheck and tests across the workspace through Turborepo. `pnpm format` applies Biome's fixes. `pnpm gen` regenerates the TypeScript and Swift types from the JSON Schemas in `packages/contracts`. `node packages/contracts/src/bundle-validator/cli.ts <bundle directory or tar>` checks a capture bundle against [docs/capture-bundle.md](docs/capture-bundle.md).

### Local stack

PostGIS and RustFS (the local S3 stand-in) run in Docker, defined in [docker-compose.yml](docker-compose.yml). Their settings come from `.env` at the repo root, which is git-ignored: copy [.env.example](.env.example), whose defaults suit a stack bound to 127.0.0.1. The same commands work in PowerShell.

```bash
cp .env.example .env
docker compose up -d --wait
pnpm migrate
pnpm buckets
pnpm test:db
```

- `pnpm migrate` runs dbmate: it creates the `usg` database on first run and applies the migrations in `db/migrations/`.
- `pnpm buckets` creates the local buckets, if missing: `usg-bundles` for raw capture bundles and `usg-exports` for the full exports that rollback restores from (both private), and `usg-public` for the public map files (Cloudflare R2 in production).
- `pnpm test:db` runs the database rule tests against the stack. Each test file gets its own throwaway database (`usg_scratch_*`), so the `usg` database is never touched. `pnpm check` doesn't run them; CI does, in its `Database (postgis)` job.
- The RustFS console is at http://localhost:29001/rustfs/console/; sign in with `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`.
- The data lives in the Docker volumes `usg_postgis-data` and `usg_rustfs-data`, inside Docker Desktop's disk image, so encrypt the drive that image is on before real captures arrive ([0009](docs/decisions/0009-hosting-and-budget.md)). `docker compose down` keeps the volumes; `docker compose down -v` deletes them.

### Changing the schema

```bash
pnpm db new add_something
pnpm migrate
pnpm db dump
```

`pnpm db new` writes `db/migrations/<timestamp>_add_something.sql`: put the change under `-- migrate:up` and what undoes it under `-- migrate:down`. `pnpm db dump` regenerates `db/schema.sql` (pg_dump runs inside the PostGIS container, so you need no PostgreSQL client); commit it with the migration. Never edit `db/schema.sql` by hand: CI regenerates it and fails on a diff. `pnpm db status` lists applied and pending migrations, and `pnpm db rollback --yes` undoes the newest one on the local database.

## Attribution

Map data © OneMap / Singapore Land Authority and © OpenStreetMap contributors.

Contains information from MRT Station Exit (LTA) accessed via data.gov.sg, made available under the Singapore Open Data Licence. (To be confirmed against the dataset page before release.)
