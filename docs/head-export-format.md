# Private full export of HEAD (format v1)

Every map version has a private full export: every row of every HEAD table (`venues`, `levels`, `spaces`, `nodes`, `edges`, `pois`, `anchors`) as it stood when the version was published, anchors and private columns included. Rollback restores HEAD from it, never from the public files, which leave out anchors, private columns and `rev` ([0004](decisions/0004-storage-and-versioning.md#rollback)). The publish transaction writes it before it inserts the `map_versions` row, and stores its key in `map_versions.private_export_uri`. This is `schema_version` 1.

Change this doc first, then `packages/contracts/schemas/export/head-export.schema.json`, then the code that writes and reads it (`services/api/src/publish/export.ts`). The rows reuse the definitions of the diff format ([diff-format.md](diff-format.md#rows)), so a column added to a HEAD table changes both.

## Storage

- In the private exports bucket (`usg-exports` in RustFS on the owner's PC, S3 in ap-southeast-1 from Phase 4; [0009](decisions/0009-hosting-and-budget.md)). Never in the public bucket, never on Cloudflare.
- Key: `head/<version>/<uuid>.json`, where `<version>` is `map_versions.id` and `<uuid>` a random UUID made for this publish. The key is never derived from `snapshot_sha256`: two versions can share their public files while their private rows (anchors) differ ([snapshot-format.md](snapshot-format.md#content-addressing)). The random part keeps keys unique when version numbers repeat, as they do after a local database is recreated (`pnpm demo --reset`).
- Stored brotli-compressed (`Content-Encoding: br`), `Content-Type: application/json`, compact UTF-8 JSON.
- Written once and never overwritten. An export whose publish transaction then fails is left behind with no version pointing at it, which is harmless. Backups cover these objects ([0009](decisions/0009-hosting-and-budget.md)).

## Document

```json head-export.json
{
  "schema_version": 1,
  "version": 7,
  "published_at": "2026-11-02T14:05:11+08:00",
  "snapshot_sha256": "3f8a2b6c4d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a",
  "venues": [
    { "id": "10000000-0000-0000-0000-000000000001", "rev": 1,
      "permission": "Written permission from the landlord, 2026-10-15",
      "row": { "name": "Funan", "kind": "mall", "operator": null, "footprint": null } }
  ],
  "levels": [
    { "id": "20000000-0000-0000-0000-000000000001", "rev": 2,
      "row": { "venue_id": "10000000-0000-0000-0000-000000000001", "ordinal": -2, "name": "B2",
        "elevation_m": -9.5, "sort_key": 0 } }
  ],
  "spaces": [],
  "nodes": [
    { "id": "40000000-0000-0000-0000-000000000004", "rev": 3,
      "row": { "level_id": null, "kind": "exit", "name": "Exit B", "street_name": "North Bridge Road",
        "connector_id": null, "elevation_m": null,
        "geom": { "type": "Point", "coordinates": [103.8506, 1.2928] } } }
  ],
  "edges": [],
  "pois": [],
  "anchors": [
    { "id": "80000000-0000-0000-0000-000000000001", "rev": 1,
      "row": { "node_id": "40000000-0000-0000-0000-000000000004", "kind": "floor_point",
        "name": "North Bridge Road exit B threshold", "level_id": null, "facing_deg": 352.5,
        "surveyed_geom": { "type": "Point", "coordinates": [103.8506, 1.2928] },
        "prior_source": "lta_exit", "prior_sigma_m": 3,
        "photo_uri": "anchor-photos/80000000-0000-0000-0000-000000000001.jpg" } }
  ]
}
```

| Field | Notes |
| --- | --- |
| `version` | `map_versions.id` of the version the export belongs to |
| `published_at` | `map_versions.published_at`, in Singapore time |
| `snapshot_sha256` | The version's public files ([snapshot-format.md](snapshot-format.md#content-addressing)), for cross-checking |
| `venues` ... `anchors` | One entry per HEAD row, sorted by `id`: the row's `id` and `rev`, and `row`, its columns in the diff format's row format |
| `permission` | Venues only: `venues.permission`, an optional, private reference to anything the venue agreed in writing (scanning needs none). The seed script owns it and no diff carries it, so it sits beside `row` |

- `row` is exactly the diff format's row for that table ([diff-format.md](diff-format.md#rows)): geometry as GeoJSON with at most 7 decimals, `null` for absent text, no `ordinal` on nodes and anchors (a trigger copies it from the level), no bookkeeping times.
- Not in the export: `restricted_zones` (not versioned; a restore that would delete a level or venue with zones is refused), the street graph and `street_connectors` (imported and derived data, which a rollback does not roll back), and everything outside HEAD (contributors, captures, change sets, moderation events).
- The publish transaction validates the export against the schema before it uploads it, and refuses to publish if it fails.

Rollback (restoring HEAD from an export) is not built yet. `GET /map/head` ([diff-format.md](diff-format.md#manual-edits)) will reuse these entry definitions (`HeadVenue` to `HeadAnchor`) when it is.
