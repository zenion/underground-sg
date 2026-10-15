# Change-set diff format (v1)

`change_sets.diff`: what a structural change set changes in HEAD, the PostGIS tables of the latest approved map ([0004](decisions/0004-storage-and-versioning.md)). Processing writes it after extraction and conflation; manual edits from the mapper app (moving a node, retagging, redrawing an outline) are diffs too, made from HEAD rows ([Manual edits](#manual-edits)). The approval transaction applies it. Diffs are private: they live in the database, show in the moderation view, and never reach a public file.

Change this doc first, then `packages/contracts/schemas/diff/change-set-diff.schema.json` (with the shared definitions in `schemas/map/defs.schema.json`), then the code that writes and applies diffs. Diffs are validated when they are written and again at approval, and carry no version number. A migration that adds a column to a HEAD table adds it to the row here too (a test against `db/schema.sql` fails until it does); a pending change set made before it then fails validation at approval and goes to `needs_rebase` ([Approval](#approval), step 2), and published ones stay as written, as frozen history that is not validated again.

## Entries

A diff is a JSON array of entries, one per HEAD row it touches, at most 10,000:

```json
{ "op": "modify", "feature_type": "node", "id": "<uuid>", "base_rev": 3, "before": { ... }, "after": { ... } }
```

| `op` | `base_rev` | `before` | `after` |
| --- | --- | --- | --- |
| `add` | `null` | `null` | The new row |
| `modify` | The row's `rev` when the diff was made | The row then | The row as the change set leaves it |
| `remove` | The row's `rev` when the diff was made | The row then | `null` |

- `id` is the row's UUID. An add uses a new UUID; a modify or remove names an existing row. Conflation keeps ids: a re-extracted feature that matches one in HEAD (by kind, level and proximity or topology, in SVY21) becomes a modify of that row, never a remove and an add, so status reports and `anchors.node_id` keep pointing at it.
- `before` and `after` are whole rows (every diffable column, below), not just the changed ones, so the moderation view needs no HEAD lookups and a rebase can see what the diff was made against.
- A status change set's diff is `[]`: its content is its `status_reports` rows (a CHECK in the database). A structural change set has at least one entry.
- Entries may come in any order; approval sorts them. Each `feature_type` and `id` appears at most once.

## What a change set may touch

| `feature_type` | Table | Ops |
| --- | --- | --- |
| `venue` | `venues` | `modify` |
| `level` | `levels` | `modify` |
| `space` | `spaces` | `add`, `modify`, `remove` |
| `node` | `nodes` | `add`, `modify`, `remove` |
| `edge` | `edges` | `add`, `modify`, `remove` |
| `poi` | `pois` | `add`, `modify`, `remove` |
| `anchor` | `anchors` | `add`, `modify`, `remove` |

- Venues and levels are added and removed only by the owner's seed script, from the site walk. A change set may modify them, so extraction can record a level's measured `elevation_m`, and a moderator-reviewed edit can rename a level or redraw a venue's footprint. Once a row exists, the seed script writes only `venues.permission`, which is never in a diff (so it bumps no `rev`); every other column changes only through change sets, so re-running the seed script never undoes an approved change ([0004](decisions/0004-storage-and-versioning.md)).
- Anchors enter HEAD only through a diff, street priors included ([0008](decisions/0008-anchors-and-georeferencing.md)). An anchor that a capture starts or ends on (`captures.start_anchor_id`, `captures.end_anchor_id`) is never removed, because every later network adjustment needs it: processing and the mapper app never emit such a remove, approval sends one to `needs_rebase` (a capture that uses the anchor arrived after the diff was made), and the foreign keys, which have no `ON DELETE` action, refuse it as well.
- Never in a diff: the street graph (`street_nodes`, `street_edges`, written by the OpenStreetMap import), `street_connectors` (rebuilt in every publish), `restricted_zones` (private, loaded by the owner's script) and `status_reports` (a status change set's own rows).

## Rows

Each row holds the table's columns in `db/schema.sql` order, except `id` and `rev` (they are on the entry), `ordinal` (a trigger copies it from the level) and bookkeeping times. A test checks the rows against the generated `db/schema.sql`.

| `feature_type` | Columns |
| --- | --- |
| `venue` | `name`, `kind`, `operator`, `footprint` |
| `level` | `venue_id`, `ordinal`, `name`, `elevation_m`, `sort_key` |
| `space` | `level_id`, `kind`, `name`, `geom` |
| `node` | `level_id`, `kind`, `name`, `street_name`, `connector_id`, `elevation_m`, `geom` |
| `edge` | `from_node`, `to_node`, `kind`, `oneway`, `access`, `opening_hours`, `level_id`, `connector_id`, `length_m`, `step_free`, `sheltered`, `outdoor`, `geom` |
| `poi` | `space_id`, `level_id`, `name`, `category`, `geom` |
| `anchor` | `node_id`, `kind`, `name`, `level_id`, `facing_deg`, `surveyed_geom`, `prior_source`, `prior_sigma_m`, `photo_uri` |

- Geometry columns are GeoJSON in WGS84, `[longitude, latitude]` with at most 7 decimals: `footprint` a MultiPolygon or `null`, `geom` a Polygon (spaces), Point (nodes, POIs) or LineString or `null` (edges), `surveyed_geom` a Point or `null`. Read them with `ST_AsGeoJSON(geom, 7)` and write them with `ST_GeomFromGeoJSON`.
- An edge's `geom` runs from `from_node` to `to_node`. Extraction and manual edits write it that way, and the snapshot builder relies on it ([snapshot-format.md](snapshot-format.md#indoorjson)).
- Nullable columns are `null` when empty, never `""` or absent. Enum values are the database's.
- `anchors.photo_uri` is the private storage key of the anchor's reference photo.

## Example

```json change_sets.diff
[
  { "op": "add", "feature_type": "space", "id": "30000000-0000-0000-0000-000000000003",
    "base_rev": null, "before": null,
    "after": { "level_id": "20000000-0000-0000-0000-000000000001", "kind": "walkway", "name": null,
      "geom": { "type": "Polygon", "coordinates": [[[103.8504, 1.2911], [103.8506, 1.2911],
        [103.8506, 1.2916], [103.8504, 1.2916], [103.8504, 1.2911]]] } } },
  { "op": "modify", "feature_type": "node", "id": "40000000-0000-0000-0000-000000000003",
    "base_rev": 3,
    "before": { "level_id": "20000000-0000-0000-0000-000000000001", "kind": "junction", "name": null,
      "street_name": null, "connector_id": null, "elevation_m": null,
      "geom": { "type": "Point", "coordinates": [103.8504, 1.2916] } },
    "after": { "level_id": "20000000-0000-0000-0000-000000000001", "kind": "junction", "name": null,
      "street_name": null, "connector_id": null, "elevation_m": null,
      "geom": { "type": "Point", "coordinates": [103.85041, 1.29162] } } },
  { "op": "remove", "feature_type": "poi", "id": "60000000-0000-0000-0000-000000000001",
    "base_rev": 1,
    "before": { "space_id": "30000000-0000-0000-0000-000000000002",
      "level_id": "20000000-0000-0000-0000-000000000001", "name": "Toilets", "category": "toilet",
      "geom": { "type": "Point", "coordinates": [103.8496, 1.2912] } },
    "after": null },
  { "op": "modify", "feature_type": "level", "id": "20000000-0000-0000-0000-000000000003",
    "base_rev": 1,
    "before": { "venue_id": "10000000-0000-0000-0000-000000000002", "ordinal": -2,
      "name": "Concourse", "elevation_m": null, "sort_key": 0 },
    "after": { "venue_id": "10000000-0000-0000-0000-000000000002", "ordinal": -2,
      "name": "Concourse", "elevation_m": -8.2, "sort_key": 0 } },
  { "op": "add", "feature_type": "anchor", "id": "80000000-0000-0000-0000-000000000001",
    "base_rev": null, "before": null,
    "after": { "node_id": "40000000-0000-0000-0000-000000000004", "kind": "floor_point",
      "name": "North Bridge Road exit B threshold", "level_id": null, "facing_deg": 352.5,
      "surveyed_geom": { "type": "Point", "coordinates": [103.8506, 1.2916] },
      "prior_source": "lta_exit", "prior_sigma_m": 3,
      "photo_uri": "anchor-photos/80000000-0000-0000-0000-000000000001.jpg" } }
]
```

## Manual edits

A manual edit starts from HEAD rows, not from the public files. Those leave out `rev`, private columns (`nodes.elevation_m`, `venues.operator`) and anchors, and draw an edge without a centreline as a straight line, so neither `base_rev` nor a whole `before` row can be rebuilt from them.

The mapper app reads HEAD through an owner-only API endpoint, `GET /map/head`: every HEAD row in this doc's row format with its `id` and `rev`, anchors included, and the version `map_head` points at. The app copies the rows it changes into `after`, keeps the rows as read in `before` and their `rev` in `base_rev`, sets the change set's `base_version_id` to that version, checks the diff with `checkChangeSetDiff` and uploads it. The response gets a JSON Schema in `packages/contracts` that reuses this doc's row definitions, written with the endpoint. It is owner-only through Phase 3, when the owner is the only mapper; what contributors' manual edits read is decided with sign-up in Phase 4, since anchors and private columns must not reach them.

## Approval

The approval transaction applies a structural change set's diff in the order of [0004](decisions/0004-storage-and-versioning.md#approval-and-publish-order). The automated gates have already passed and been recorded in `moderation_events`; the database refuses to set a publish path otherwise.

1. **Lock** `map_head` with `SELECT ... FOR UPDATE`, so approvals are serialised.
2. **Rebase check.** The change set goes to `needs_rebase`, and nothing is applied, if any of these holds:
   - a rollback undid its `base_version_id` (after the restored version and before the rollback version), whenever the change set arrives;
   - the diff no longer passes `validateChangeSetDiff`, for example because a migration has since added a column to a HEAD table;
   - a `modify` or `remove` names a row that is gone, or whose `rev` differs from `base_rev`;
   - an `add` names an id that HEAD already has;
   - an `add`'s or `modify`'s `after` references a venue, level, space or node (the columns in `DIFF_ROW_REFERENCES`: `venue_id`, `level_id`, `space_id`, `from_node`, `to_node`, `node_id`) that HEAD no longer has and the diff doesn't add, for example because a change set approved in the meantime removed it. Applying the entry would fail on a foreign key;
   - a `remove` would cascade: another HEAD row references the removed one (an edge its node, a POI its space, an anchor its node) and the diff neither removes that row nor modifies it so that its `after` no longer references the removed one. The database's `ON DELETE CASCADE` and `SET NULL` must never change a row the diff doesn't name, or HEAD would change without review and without a rev bump. (A diff whose own `after` still references a row it removes is refused when it is written; see [Validation](#validation).)
   - a `remove` names an anchor that a capture starts or ends on.
3. **Apply.** Adds and modifies in the order venue, level, space, node, edge, poi, anchor (parents first), then removes in the reverse order (children first). An add inserts `after` with `rev` 1; a modify writes the whole of `after` and sets `rev` to `base_rev + 1`; a remove deletes the row. Triggers copy `ordinal` from the level, and refuse a feature that overlaps a restricted zone's interior (the restricted-zone gate should have caught it first).
4. Rebuild `street_connectors`, build and upload the public files, write the private full export, insert the `map_versions` row and mark the change set published, as [0004](decisions/0004-storage-and-versioning.md) sets out; then commit and update `latest.json` ([snapshot-format.md](snapshot-format.md)).

A `needs_rebase` change set is diffed again against the new HEAD (processing re-runs conflation for a capture; the mapper app redoes a manual edit) and resubmitted as a new pending change set.

## Validation

`validateChangeSetDiff(diff, track)` in `@usg/contracts/validators` (Node) checks the schema, then what it can't express; `checkChangeSetDiff(diff, track)` in `@usg/contracts` runs the second half anywhere, so the mapper app can check a manual edit before upload. Processing and the API validate every diff before inserting it, and approval validates it again (step 2).

The schema checks the op, `base_rev`, `before` and `after` combinations, the feature types and ops above, and each row's columns, types and enums. The checker adds:

- an empty diff for a status change set and a non-empty one for a structural change set;
- at most one entry per `feature_type` and `id`;
- a modify changes something (`after` differs from `before`);
- no add or modify whose `after` references a row the same diff removes (`DIFF_ROW_REFERENCES`, the foreign keys between HEAD tables): approval applies removes last, so the database's cascade would undo the entry;
- the rules the database also enforces: an edge doesn't join a node to itself, stairs and escalators are never `step_free`, and an anchor's `surveyed_geom`, `prior_source` and `prior_sigma_m` are all set or all `null`;
- coordinates: latitudes within -90 to 90, at most 7 decimals, closed polygon rings.

Whether each `base_rev` still matches HEAD, whether the rows an entry references still exist, and whether a removed anchor is free of captures, is for approval to check (step 2).
