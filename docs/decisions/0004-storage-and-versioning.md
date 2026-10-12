# 0004: PostGIS HEAD tables plus immutable published snapshots

Status: accepted · 2026-10-12

## Decision

- PostGIS tables hold HEAD, the latest approved map (`db/schema.sql`).
- Pending work lives in `change_sets.diff` and is applied to HEAD only on approval, in one transaction.
- Each approval writes a `map_versions` row and an immutable JSON snapshot of the cluster. Clients load snapshots, not the tables.
- Rollback restores HEAD from an earlier snapshot and publishes it as a new version (`map_versions.restores`).

## Why

- A cluster's whole map is small, so a snapshot per version is cheap and can be cached on a CDN.
- Clients route locally over the snapshot (0003).
- Rollback is simple and leaves a full audit trail.

## Conventions

- Store geometry in WGS84 (EPSG:4326). Do metric work (lengths, buffers, georeferencing fits) in SVY21 (EPSG:3414).
- `ordinal` is a city-wide height band: 0 = street, -1 = B1, -2 = B2. Map each venue's signed level names onto it.
- Keep the model close to Apple IMDF so an IMDF export is possible later.
