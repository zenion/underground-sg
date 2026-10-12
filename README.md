# Underground SG

Find your way through downtown Singapore's underground links and malls: see where you are, and get a route between two street-level points that stays underground.

Status: planning. The MVP covers the City Hall cluster: City Hall MRT, Funan, Raffles City, CityLink Mall and Esplanade MRT.

## Docs

| File | What it is |
| --- | --- |
| [docs/spec.md](docs/spec.md) | Product and technical spec, the source of truth |
| [docs/backlog.md](docs/backlog.md) | Tasks for phases 1 and 2 |
| [docs/capture-bundle.md](docs/capture-bundle.md) | Format of a capture upload, shared by the iOS app and the server |
| [docs/decisions/](docs/decisions/) | Why the key choices were made |
| [db/schema.sql](db/schema.sql) | Draft PostGIS schema |
| [CLAUDE.md](CLAUDE.md) | Working context for Claude Code |

## How it works

1. A mapper walks a corridor with an iPhone Pro, from one fixed anchor point to another, and checks the floor-plan preview on the spot.
2. The server refines the scan, aligns it to the street map, and puts the changes up for review.
3. Approved changes are published as a new, immutable map version.
4. The public webapp shows that version over the OneMap street map, routes through it, and locates you from a single photo.

Map data © OneMap / Singapore Land Authority and © OpenStreetMap contributors.
