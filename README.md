# Underground SG

Find your way through downtown Singapore's underground links and malls: see where you are, and get a route between two street-level points that stays underground.

Status: Phase 1. The stack was decided on 2026-10-12 and the monorepo is scaffolded. The mapper app is a shell that runs in Expo Go ([apps/mapper](apps/mapper/README.md)); no services are built yet. The MVP covers the City Hall cluster: City Hall MRT, Funan, Raffles City, CityLink Mall and Esplanade MRT.

## Docs

| File | What it is |
| --- | --- |
| [docs/spec.md](docs/spec.md) | Product and technical spec, the source of truth |
| [docs/backlog.md](docs/backlog.md) | Tasks by phase, in detail for phases 1 and 2 |
| [docs/capture-bundle.md](docs/capture-bundle.md) | Format of a capture upload, shared by the mapper app and the server |
| [docs/decisions/](docs/decisions/) | Why the key choices were made |
| [docs/reviews/](docs/reviews/) | Background research behind the decisions, such as the 2026-10-12 stack review |
| [db/schema.sql](db/schema.sql) | Draft PostGIS schema |
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

`pnpm check` runs Biome (lint and format check), then typecheck and tests across the workspace through Turborepo. `pnpm format` applies Biome's fixes. `pnpm gen` regenerates the TypeScript and Swift types from the JSON Schemas in `packages/contracts`. `node packages/contracts/src/bundle-validator/cli.ts <bundle directory or tar>` checks a capture bundle against [docs/capture-bundle.md](docs/capture-bundle.md). `pnpm test:venue` runs the tests that need meshes recorded in a venue, from the git-ignored `.data/fixtures/`; they skip when the files are absent. `pnpm mapper` starts Metro for the mapper app in Expo Go on the phone (see [apps/mapper/README.md](apps/mapper/README.md)), and `pnpm build` exports its iOS JavaScript bundle.

Map data © OneMap / Singapore Land Authority and © OpenStreetMap contributors.

Contains information from MRT Station Exit (LTA) accessed via data.gov.sg, made available under the Singapore Open Data Licence. (To be confirmed against the dataset page before release.)
