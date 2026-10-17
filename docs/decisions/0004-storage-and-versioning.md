# 0004: PostGIS HEAD tables plus immutable published snapshots

Status: accepted · 2026-10-12 · amended 2026-10-15, 2026-10-17

## Decision

### HEAD and change sets

- PostGIS tables hold HEAD, the latest approved map. The schema is the dbmate migrations in `db/migrations/`, starting from the draft v1; [`db/schema.sql`](../../db/schema.sql) is a generated snapshot of the result.
- Every HEAD table (`venues`, `levels`, `spaces`, `nodes`, `edges`, `anchors`, `pois`) has `rev integer NOT NULL DEFAULT 1`, bumped on each approved change.
- Pending work lives in `change_sets.diff` and is applied to HEAD only on approval, in one transaction. Every change set records `base_version_id`, the version it was based on.
- Diff entries are `{op, feature_type, id, base_rev, before, after}`, with whole rows as `before` and `after`: [diff-format.md](../diff-format.md), with a JSON Schema in `packages/contracts`. A change set may add, modify and remove spaces, nodes, edges, POIs and anchors, and modify venues and levels.
- A change set lists its captures in `change_set_captures`. One with no captures is a manual edit (move a node, retag, redraw an outline) and can publish only through `moderator_review` or `owner_mapper`. A status change set has an empty diff: its content is its `status_reports` rows.
- `change_sets.publish_path` records how a change set was published. The decision is `approved` on `moderator_review`, and `auto_published` on `owner_mapper` (structural only) and `trusted_status_auto` (status only); a CHECK ties the two, and "published" means one of those two decisions. A trigger enforces eligibility by trust tier. Every moderation action is appended to `moderation_events`.
- The automated gates ([spec](../spec.md), crowdsourcing and moderation) run on every path, and their result is recorded in `moderation_events` (`gates_passed` or `gates_failed`). The database refuses to set a publish path without a `gates_passed` that no later `gates_failed` overrides, or while a linked capture has failed or carries a privacy flag. So a change set is inserted as `pending` and published by an update.
- Once published, a change set cannot be deleted, and its diff, track, contributor, base version, reviewer and version are frozen, as are its `change_set_captures` and `status_reports` rows. `rejected` and `rolled_back` are final.
- Every map version except a rollback publishes at least one change set. Seed data (venues and levels from the site walk) and the imported OSM street graph are written by the owner's scripts, not through change sets, and reach the public files only inside such a version. Only the seed script adds or removes venues and levels, and it removes one only when no other HEAD row references it (the cascade would otherwise change HEAD without a change set). Once a row exists, the seed script writes only `venues.permission`, which no diff carries, so it bumps no `rev`. Every other column of a venue or level changes only through change sets (a level's measured height, a renamed level, a redrawn footprint), so re-running the seed script never undoes an approved change.

### Approval and publish order

For a structural change set (status edits are below):

1. Lock `map_head` with `SELECT ... FOR UPDATE`, so approvals are serialised.
2. Run the rebase check of [diff-format.md](../diff-format.md#approval): the diff still validates, every touched feature still has the `rev` the diff was based on, every row it references still exists, no remove would cascade or remove an anchor a capture uses, and a rollback has not undone the change set's base version (see [Rollback](#rollback)). If any of these fails, the decision becomes `needs_rebase` and nothing is applied.
3. Apply the diff and bump revs, under a savepoint. If the database refuses an entry (a unique, foreign-key or check constraint), or HEAD would then hold a feature overlapping a restricted zone that it didn't before (the zones as they are now, every line as the public files draw it), the change set is rolled back to the savepoint and goes to `needs_rebase` too.
4. Rebuild `street_connectors` for every exit and entrance (in SVY21; one per node, keyed by `node_id`). Check the whole of HEAD against the restricted zones, street connectors included, and refuse the publish if anything overlaps one (a zone drawn over a published feature, say). Then build the public files from HEAD inside the transaction.
5. Upload them to a content-addressed, immutable key, before commit.
6. Write the private full export, under a key of its own for the version (`head/<version>/<uuid>.json` in the exports bucket; format in [head-export-format.md](../head-export-format.md)). Never derive it from `snapshot_sha256`: two versions can share their public files while their private rows (anchors) differ.
7. Insert the `map_versions` row (`snapshot_uri`, `snapshot_sha256`, `private_export_uri`), mark the change sets published with its `map_version_id`, and point `map_head` at it. `map_head` cannot be deleted and only moves forward.
8. Commit.
9. Update the short-TTL `latest.json` pointer, holding `map_head` `FOR SHARE` and only while it still names this version, so the pointer never moves back (a newer publish writes its own). If that update fails, a reconcile job repairs it, under the same lock.

The automated gates run before step 1, in a transaction of their own, so their `gates_passed` or `gates_failed` record stands whatever the publish does. The record names the diff (its SHA-256) and the captures it checked, and the publish refuses a change set whose diff or captures have changed since; the restricted zones are checked again in step 3, since HEAD and the zones may have moved on. In Phase 1 the publish runs as a CLI (`pnpm map`), in a process of its own, and publishes only through `owner_mapper`; it may carry several change sets, applied oldest first, and one that needs a rebase doesn't stop the others ([diff-format.md](../diff-format.md#approval)). Implementation and order in detail: [services/api/README.md](../../services/api/README.md#publishing).

### ID stability

- Extraction conflates against HEAD: it matches by kind, level and proximity or topology, and keeps existing IDs. New UUIDs only for genuinely new features.
- New anchors and street priors enter `anchors` through the change set like any other feature, never directly ([0008](0008-anchors-and-georeferencing.md)).
- Drafts live on the phone through Phase 3 (expo-sqlite). Draft features keep their own client UUIDs plus a `server_id` mapping filled in on sync. A server-side `drafts` table arrives in Phase 4 with shared drafts.

### Public files

Per version, under an immutable content-addressed path:

| File | Contents |
| --- | --- |
| `indoor.json` | `venues`, `levels`, `spaces`, `nodes`, `edges`, `pois`, `street_connectors` as IMDF-like GeoJSON features, 7-decimal coordinates, served with brotli |
| `street.json` | The OSM-derived street graph, under ODbL ([0003](0003-routing.md)) |

Short-TTL files outside versions:

| File | Contents |
| --- | --- |
| `latest.json` | Pointer to the current version |
| `status.json` | The status overlay, keyed by stable feature IDs, with `valid_from` and `valid_until` |

The format is [snapshot-format.md](../snapshot-format.md), with JSON Schemas in `packages/contracts`. A version's files live under `snapshots/<snapshot_sha256>/`, stored brotli-compressed. `snapshot_sha256` is the SHA-256 of the two files' `sha256sum --text` lines (`indoor.json` then `street.json`, each hashed as decoded JSON), and `snapshot_uri` is that directory relative to the root of the public files. The files are written deterministically and every id in them is stable, so identical content always gets the same immutable path. Both files share the directory, so clients fetch `street.json` again after each publish even when the street graph hasn't changed; that is accepted for its simplicity ([snapshot-format.md](../snapshot-format.md#content-addressing)). Public files are served from Cloudflare (Pages + R2). Nothing private goes there.

`street_connectors` and the street tables are not HEAD tables. The street graph is imported reference data: each version's `street.json` is built from it as it stands at publish, and a rollback does not roll it back. Connectors are derived and rebuilt in every publish (step 4), so they always match the street graph they are published with. Each is keyed by its node, and its public id is derived from the node's, so it stays the same from version to version.

The API's `GET /map/latest` reads `map_head` and serves the owner's tools on the LAN. Public clients read only `latest.json`, which can lag `map_head` until the reconcile job runs.

### Status overlay

Status edits ("exit closed", "lift down") never create a map version. Each is a row in `status_reports` (`is_open`, `valid_from`, `valid_until`, a private `evidence_uri`) linked to a status change set; the database only lets status change sets carry reports. Active rows build `status.json`. Nodes and edges no longer have `status_open`.

Reports published through `trusted_status_auto` must have `valid_until`; an open-ended closure needs `moderator_review`. The maximum duration is a tuning value set in Phase 4. A published report is never edited: a newer report replaces it. Where several cover the same feature, the one made last (`created_at`) wins ([snapshot-format.md](../snapshot-format.md#statusjson)).

### Rollback

- Rollback restores HEAD from the chosen version's private full export ([head-export-format.md](../head-export-format.md)), not from the public files, and publishes the result as a new version (`map_versions.restores`). Not built yet.
- Structural change sets published by the versions the rollback undoes (after the restored version) become `rolled_back`. Status change sets are unaffected.
- Restored rows keep their revs from the export, so a rev can repeat. Approval therefore returns `needs_rebase` for any change set whose `base_version_id` a rollback undid (after the restored version and before the rollback version), whenever it arrives, not only those pending at rollback time.
- The private export covers all HEAD tables, including anchors. `restricted_zones` are not versioned; a restore that would delete a level or venue that has zones is refused.

### Localization index

The index is built per published version from approved captures only ([0002](0002-photo-localization.md)). Rollback rolls it back too. Nothing is indexed before approval.

### Levels and height

- `levels.ordinal` is the level-switcher display band: 0 is the street band, -1 the first basement band, and so on. Several levels of one venue may share a band; `levels.sort_key` orders them within it.
- Venue-signed names ("B2") live in `levels.name`, unique per venue: `UNIQUE (venue_id, name)`.
- Physical height is `levels.elevation_m`: metres relative to the height datum, NULL until measured. The datum is a reference street-level floor, chosen on the site walk and recorded in the spec.
- A trigger keeps `nodes.ordinal` and `anchors.ordinal` in step with `levels.ordinal`; rows without a level use 0. `nodes.elevation_m` is optional.
- Routing never infers connectivity from equal ordinals (0003).

### Conventions

- Store geometry in WGS84 (EPSG:4326). Do metric work (lengths, buffers, the network adjustment) in SVY21 (EPSG:3414).
- Keep the model close to Apple IMDF so an IMDF export is possible later. On export, map the display band onto IMDF's per-building ordinals.

## Why

- A cluster's whole map is small, so a snapshot per version is cheap and can be cached on a CDN.
- Clients route locally over the snapshot (0003).
- Without a base version and revs, two approvals against the same version can overwrite each other. The `map_head` lock serialises approvals, and the rev check catches stale diffs.
- Without conflation, a re-scan gives every feature a new UUID, so the diff shows a remove and an add instead of a move. That breaks status reports and `anchors.node_id`.
- Public files leave out anchors and internal fields, so restoring HEAD from them would lose data. The private export keeps everything.
- Uploading before commit means every committed version has its files. Moving the pointer after commit means clients never see a version that might still roll back. An upload whose transaction then fails leaves an object nothing points to, which is harmless.
- Status as an overlay: rolling back a structural change does not undo unrelated "lift down" reports, and frequent status edits do not churn map versions.
- "B2 means the same height everywhere" is physically false, and street level varies across the cluster. The old `UNIQUE (venue_id, ordinal)` forbade mezzanines and split levels.

Background and sources: [stack review](../reviews/2026-10-12-stack-review.md), section 7 (items 2, 4, 5 and 11).

## Consequences

- Never edit a published snapshot; publish a new version.
- Rollback stays simple and leaves a full audit trail in `map_versions`, `change_sets` and `moderation_events`.
- A `needs_rebase` change set has to be diffed again against the new HEAD before it can be approved.
- Rollback depends on the private exports and the version history, so backups must cover the database and the private-export objects ([0009](0009-hosting-and-budget.md)).
- The snapshot writer gets a golden-file test that the TypeScript routing tests also read.
- The spec's MapVersion `changeset_ids` field is gone; use `change_sets.map_version_id`.
- Open, decided when the status overlay is built in Phase 4: whether status approvals also take the `map_head` lock, and what the overlay does with a status report whose feature a later structural change removes.
