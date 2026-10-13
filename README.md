# Underground SG

Find your way through downtown Singapore's underground links and malls: see where you are, and get a route between two street-level points that stays underground.

Status: planning. The stack was decided on 2026-10-12; nothing is built yet. The MVP covers the City Hall cluster: City Hall MRT, Funan, Raffles City, CityLink Mall and Esplanade MRT.

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

Map data © OneMap / Singapore Land Authority and © OpenStreetMap contributors.

Contains information from MRT Station Exit (LTA) accessed via data.gov.sg, made available under the Singapore Open Data Licence. (To be confirmed against the dataset page before release.)
