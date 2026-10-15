# Public map files (snapshot format v1)

The files public clients read: the webapp and, for the published map, the mapper app. The publish transaction writes them ([0004](decisions/0004-storage-and-versioning.md)); clients never read the database. This is `schema_version` 1.

Change this doc first, then the JSON Schemas in `packages/contracts/schemas/snapshot/` (with the shared definitions in `schemas/map/defs.schema.json`), then the snapshot builder and the clients. Bump `schema_version` on any breaking change, including a new field, feature type or enum value. `pnpm gen` writes TypeScript types from the schemas; nothing in Swift reads these files, so they get no Swift types.

## Layout

All files live in the public bucket (`usg-public` in RustFS on the owner's PC, Cloudflare R2 in production; [0009](decisions/0009-hosting-and-budget.md)). Nothing private is ever written there.

On the owner's PC the API stands in for Cloudflare: it serves the bucket read-only at `GET /public/<key>` (`/public/latest.json`, `/public/snapshots/<snapshot_sha256>/indoor.json`), only the files listed below, and answers 404 for one that isn't there, as before the first publish. The bucket itself gets no public-read rule. The webapp's dev server (`pnpm web`) proxies `/public/` to it.

```
latest.json                           pointer to the current version
status.json                           status overlay; never part of a version
snapshots/<snapshot_sha256>/
  indoor.json                         venues, levels, spaces, nodes, edges, POIs, street connectors
  street.json                         the street graph from OpenStreetMap, under the ODbL
```

| File | Written | Stored as | `Cache-Control` |
| --- | --- | --- | --- |
| `snapshots/<sha>/indoor.json`, `street.json` | Once, by the publish transaction, before it commits | Brotli, `Content-Encoding: br`, `Content-Type: application/geo+json` | `public, max-age=31536000, immutable` |
| `latest.json` | After each publish commits, only while `map_head` still names that version, so it never moves back; repaired by the reconcile job (`reconcileLatest`, `pnpm map reconcile`) | Uncompressed, `application/json` | `public, max-age=60` |
| `status.json` | Whenever the overlay changes, and on a schedule (Phase 4); before that, once with no entries, by the first publish | Uncompressed, `application/json` | `public, max-age=60` |

Clients fetch `latest.json`, then the two version files it names (cached for good, since their path changes with their content), then `status.json`. A client that gets no `status.json`, or one it can't read, treats it as having no entries ([status.json](#statusjson)).

### Content addressing

- A version file's `bytes` and `sha256` are those of the JSON as decoded, not of the brotli bytes: browsers remove the content encoding before a page sees the body, and brotli output varies between encoder versions.
- `snapshot_sha256` is the SHA-256 of one `sha256sum` line per version file, `indoor.json` first: `<indoor sha256>  indoor.json\n<street sha256>  street.json\n`, with two spaces. From a shell, `sha256sum --text indoor.json street.json | sha256sum`. Keep `--text`: on Windows, Git Bash's `sha256sum` defaults to binary mode and writes `<sha256> *indoor.json`, which gives a different hash.
- The version's directory is `snapshots/<snapshot_sha256>/`. The publish transaction stores the hash in `map_versions.snapshot_sha256` and the directory, relative to the root of the public files, in `map_versions.snapshot_uri` (`snapshots/<snapshot_sha256>/`), so the same row works on RustFS and on R2.
- A directory is never overwritten or deleted. (One exception: `pnpm demo --reset` deletes the demo map's directories on the owner's PC, with the database that published them, so no demo data is left in the public bucket.) Identical content gives an identical path: a rollback that restores exactly an earlier state, a retried publish, or a publish that changes only private rows (anchors) finds its files already there and leaves them. Two `map_versions` rows may then share a hash and a directory, but never a private export: each version's `private_export_uri` has a key of its own ([head-export-format.md](head-export-format.md#storage)), never derived from `snapshot_sha256`, because the private rows of two versions with the same public files can differ. Before reusing a file that is already there, the publish reads it back and checks that it decodes to the same bytes. An upload whose transaction fails leaves a directory nothing points to, which is harmless.
- The version files hold no version number or publish time, which is what makes them content-addressed; `latest.json` carries both.
- Both files sit in their version's directory, so a client downloads `street.json` again after every publish, even one that changed only `indoor.json`. This is accepted: publishes are rare next to visits, the file is small once brotli-compressed, and one directory per version keeps `snapshot_uri`, the reconcile job and audits simple. If it ever matters, a new format version can address each file by its own hash.

### Serialisation

The builder writes the files deterministically, so the same HEAD and street graph always give the same bytes, and the same hash. Every id in them is stable: a HEAD row's UUID, a street connector's id derived from its node's, or an OpenStreetMap id.

- UTF-8 JSON without a byte order mark, compact (no indentation), with members in the order the examples below show and the schemas list: a collection's `type`, `schema_version` (`source` in `street.json`), `features`; a feature's `type`, `id`, `properties`, `geometry`; and its properties starting with `feature_type` (then `id` in `indoor.json`), followed by the order of the tables below.
- Features sorted: in `indoor.json` by type (venue, level, space, node, edge, poi, street_connector), then by id; in `street.json` nodes by id, then edges by `osm_way_id`, `from_osm_node` and `to_osm_node`.
- Coordinates are `[longitude, latitude]` in WGS84 with at most 7 decimals (about 1 cm): `ST_AsGeoJSON(geom, 7)`. No altitude: height is `elevation_m`.
- Polygon rings follow RFC 7946, whichever way HEAD stores them: the exterior ring counterclockwise, holes clockwise (`ST_ForcePolygonCCW`).
- Lengths and elevations are metres, rounded to 2 decimals. Absent text is `null`, never `""`. UUIDs are lowercase.

The snapshot builder (`buildSnapshot` in `services/api/src/publish/snapshot.ts`) has a golden-file test that checks the output, and the routing tests read the same files (`services/api/test/fixtures/snapshot/`).

## latest.json

```json latest.json
{
  "schema_version": 1,
  "version": 7,
  "published_at": "2026-11-02T14:05:11+08:00",
  "snapshot_sha256": "3f8a2b6c4d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a",
  "files": {
    "indoor": {
      "path": "snapshots/3f8a2b6c4d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a/indoor.json",
      "bytes": 48213,
      "sha256": "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"
    },
    "street": {
      "path": "snapshots/3f8a2b6c4d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a/street.json",
      "bytes": 120934,
      "sha256": "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"
    }
  },
  "attribution": [
    { "text": "© OpenStreetMap contributors", "url": "https://www.openstreetmap.org/copyright" },
    { "text": "Contains information from LTA MRT Station Exit (GEOJSON) accessed on 20 October 2026 from data.gov.sg which is made available under the terms of the Singapore Open Data Licence version 1.0",
      "url": "https://data.gov.sg/open-data-licence" }
  ]
}
```

| Field | Notes |
| --- | --- |
| `version` | `map_versions.id` |
| `published_at` | `map_versions.published_at`, in Singapore time |
| `snapshot_sha256` | `map_versions.snapshot_sha256`; names the version's directory |
| `files` | Each version file's path relative to `latest.json`, and its decoded `bytes` and `sha256`. A client may check them (Web Crypto's SHA-256) before trusting a file |
| `attribution` | Plain text and an `https` link for each data source in the version, for an "about the data" view: OpenStreetMap's, for `street.json`, in every version; LTA's, with the date the exit data was accessed, once the LTA exit import puts exit positions in a version. The map's own attribution control uses `packages/map-style`, which also carries OneMap's |
| `demo` | Optional. `true` when the published map is demonstration data rather than a surveyed map, and clients show a banner. It follows the database, not the publisher's say: `true` while the database holds the demo map (`pnpm demo`, on the owner's PC only), which its owner contributor marks, so the reconcile job writes it as the publish did. Nothing real is published beside the demo: the seed script and the publish refuse real data there until `pnpm demo --reset`. Absent otherwise |

`latest.json` can lag `map_head` until the reconcile job runs, but never names an older version than it did: every write of it (after a publish, and by the reconcile job) holds `map_head` `FOR SHARE` in a short transaction and writes only the version `map_head` names, and none replaces a `latest.json` that names a newer one. The owner's tools on the LAN use `GET /map/latest`, which reads `map_head`.

## indoor.json

A GeoJSON FeatureCollection of IMDF-like features ([0004](decisions/0004-storage-and-versioning.md)): each is a GeoJSON Feature whose `id` is the HEAD row's UUID, stable from version to version because extraction conflates against HEAD. Two IMDF-like members sit inside `properties`, so a MapLibre style can read them:

- `feature_type` says what the feature is (IMDF keeps it beside `properties`; style filters can only read `properties`).
- `id` repeats the feature's id: MapLibre identifies GeoJSON features only by a numeric id or a property it promotes (`promoteId: "id"`), which feature state, such as closures from `status.json`, needs.

Properties hold only what clients need to draw and route. Each feature type:

| `feature_type` | From | Geometry | Properties besides `feature_type` and `id` |
| --- | --- | --- | --- |
| `venue` | `venues` | MultiPolygon `footprint`, or `null` | `name`, `kind` |
| `level` | `levels` | Always `null` | `venue_id`, `name` (as signed, "B2"), `ordinal`, `sort_key`, `elevation_m` (or `null`) |
| `space` | `spaces` | Polygon | `level_id`, `ordinal`, `kind`, `name` (or `null`) |
| `node` | `nodes` | Point | `level_id` (`null` outside any venue), `ordinal`, `kind`, `name`, `street_name` (exits and entrances: the street or building they open onto), `connector_id` |
| `edge` | `edges` | LineString | `from_node`, `to_node`, `from_ordinal`, `to_ordinal`, `level_id` (`null` for a vertical connector), `kind`, `connector_id`, `oneway`, `access`, `opening_hours` (OSM syntax, Asia/Singapore; `null` means always open), `length_m`, `step_free`, `sheltered`, `outdoor` |
| `poi` | `pois` | Point | `level_id`, `ordinal`, `space_id` (or `null`), `name`, `category` |
| `street_connector` | `street_connectors` | LineString, node to street vertex | `node_id`, `osm_node_id` (a street node in `street.json`), `ordinal`, `length_m` |

- `ordinal`, `from_ordinal` and `to_ordinal` are display bands copied from the levels (0 for a node without a level), so the level filter can read them: a feature shows on its band, and an edge on the bands of both its ends, which is how a connector is drawn on both end levels. Routing never infers a connection from them ([0003](decisions/0003-routing.md)).
- An edge's line runs from `from_node` to `to_node`: its first position is exactly `from_node`'s and its last exactly `to_node`'s, so a route drawn edge by edge has no gaps and a one-way arrow can follow the line. It is the stored centreline, which HEAD keeps in that direction ([diff-format.md](diff-format.md#rows)), with its first and last positions set to the nodes' points (reversed first if it runs the other way, compared in SVY21), or a straight line between the nodes when HEAD has none. A street connector's line runs the same way, from its node to its street vertex.
- The publish transaction rebuilds the street connectors before it builds the files: each exit and entrance to its nearest street node by SVY21 distance, the lowest OSM node id breaking a tie, with a straight line between them (`rebuildStreetConnectors` in `services/api/src/publish/street-connectors.ts`). Only a street node within 100 m counts (`STREET_CONNECTOR_MAX_LENGTH_M`, a tuning value): an exit or entrance with none that close gets no connector, rather than a line drawn through buildings to a far-away vertex, as when the street graph near it is missing. The limit is generous because the graph's vertices along a sidewalk can be tens of metres apart.
- A street connector's id is derived from its node's: the UUIDv5 (RFC 9562) of `node_id`, as lowercase text, in the namespace `1ffdedde-dd2f-4f6d-a18a-800669a179e1` (`STREET_CONNECTOR_ID_NAMESPACE`; `streetConnectorId` in `@usg/contracts/validators` computes it). `street_connectors` is keyed by `node_id`, so an exit or entrance has at most one connector, and its id stays the same from version to version although the table is rebuilt in every publish.
- The enum values are the database's: `venue_kind`, `space_kind`, `node_kind`, `edge_kind`, `edge_access` and `poi_category` in `db/schema.sql`. A test keeps them in step.

An excerpt (`features` cut to four):

```json indoor.json
{
  "type": "FeatureCollection",
  "schema_version": 1,
  "features": [
    { "type": "Feature", "id": "20000000-0000-0000-0000-000000000001",
      "properties": { "feature_type": "level", "id": "20000000-0000-0000-0000-000000000001",
        "venue_id": "10000000-0000-0000-0000-000000000001", "name": "B2", "ordinal": -2,
        "sort_key": 0, "elevation_m": -9.5 },
      "geometry": null },
    { "type": "Feature", "id": "30000000-0000-0000-0000-000000000001",
      "properties": { "feature_type": "space", "id": "30000000-0000-0000-0000-000000000001",
        "level_id": "20000000-0000-0000-0000-000000000001", "ordinal": -2, "kind": "walkway",
        "name": null },
      "geometry": { "type": "Polygon", "coordinates": [[[103.8497, 1.2911], [103.8504, 1.2911],
        [103.8504, 1.2916], [103.8497, 1.2916], [103.8497, 1.2911]]] } },
    { "type": "Feature", "id": "40000000-0000-0000-0000-000000000004",
      "properties": { "feature_type": "node", "id": "40000000-0000-0000-0000-000000000004",
        "level_id": null, "ordinal": 0, "kind": "exit", "name": "Exit B",
        "street_name": "North Bridge Road", "connector_id": "90000000-0000-0000-0000-000000000002" },
      "geometry": { "type": "Point", "coordinates": [103.8506, 1.2916] } },
    { "type": "Feature", "id": "50000000-0000-0000-0000-000000000003",
      "properties": { "feature_type": "edge", "id": "50000000-0000-0000-0000-000000000003",
        "from_node": "40000000-0000-0000-0000-000000000003",
        "to_node": "40000000-0000-0000-0000-000000000004", "from_ordinal": -2, "to_ordinal": 0,
        "level_id": null, "kind": "stairs", "connector_id": "90000000-0000-0000-0000-000000000002",
        "oneway": false, "access": "public", "opening_hours": "Mo-Su 06:00-24:00",
        "length_m": 24.2, "step_free": false, "sheltered": true, "outdoor": false },
      "geometry": { "type": "LineString", "coordinates": [[103.8504, 1.2916], [103.8506, 1.2916]] } }
  ]
}
```

## street.json

The street graph imported from OpenStreetMap (`street_nodes` and `street_edges`), in a file of its own so the indoor data stays a separate database under the OSMF collective-database guideline ([0003](decisions/0003-routing.md); the approach needs legal review). Each version's `street.json` is built from the street tables as they stand at publish; a rollback does not roll them back.

```json street.json
{
  "type": "FeatureCollection",
  "schema_version": 1,
  "source": {
    "name": "OpenStreetMap",
    "licence": "ODbL-1.0",
    "licence_url": "https://opendatacommons.org/licenses/odbl/1-0/",
    "attribution": "© OpenStreetMap contributors",
    "attribution_url": "https://www.openstreetmap.org/copyright"
  },
  "features": [
    { "type": "Feature", "id": 1001, "properties": { "feature_type": "street_node" },
      "geometry": { "type": "Point", "coordinates": [103.8507, 1.2916] } },
    { "type": "Feature", "id": 1002, "properties": { "feature_type": "street_node" },
      "geometry": { "type": "Point", "coordinates": [103.8515, 1.293] } },
    { "type": "Feature",
      "properties": { "feature_type": "street_edge", "osm_way_id": 2001, "from_osm_node": 1001,
        "to_osm_node": 1002, "highway": "footway", "footway": "sidewalk", "covered": false,
        "length_m": 178.58 },
      "geometry": { "type": "LineString", "coordinates": [[103.8507, 1.2916], [103.8515, 1.293]] } }
  ]
}
```

- `source` is fixed: the schema allows only these values, so the ODbL attribution travels with the data.
- A `street_node`'s `id` is its OpenStreetMap node id (a number, so MapLibre identifies it without a promoted property).
- A `street_edge` has no `id`: `street_edges.id` changes on every import, so an edge is identified by `osm_way_id`, `from_osm_node` and `to_osm_node`. Street edges are walkable both ways.
- A `street_edge`'s line runs from `from_osm_node` to `to_osm_node`: its first position is exactly the first node's and its last exactly the second's.
- `highway` and `footway` are the way's OpenStreetMap tags (or `null`), for routing: step-free mode avoids `highway=steps`, and a crossing (`footway=crossing`) can carry a wait. No other tags are published.
- `covered` comes from `covered=yes` plus the import's tunnel, building and roof heuristics; `length_m` is measured in SVY21.

## status.json

The status overlay: "exit closed", "lift down". It is never part of a version, so rolling back a structural version doesn't undo an unrelated closure, and frequent status edits don't churn versions ([0004](decisions/0004-storage-and-versioning.md)). It arrives with status edits in Phase 4.

```json status.json
{
  "schema_version": 1,
  "generated_at": "2026-11-03T08:00:00+08:00",
  "entries": [
    { "feature_type": "edge", "feature_id": "50000000-0000-0000-0000-000000000001",
      "is_open": false, "note": "Escalator under maintenance",
      "valid_from": "2026-11-03T07:00:00+08:00", "valid_until": "2026-11-03T18:00:00+08:00" },
    { "feature_type": "node", "feature_id": "40000000-0000-0000-0000-000000000004",
      "is_open": false, "note": null,
      "valid_from": "2026-11-01T00:00:00+08:00", "valid_until": null }
  ]
}
```

- Built from `status_reports` whose change set is published and whose window (`valid_from` to `valid_until`, `null` meaning until replaced) covers `generated_at`. At most one entry per `feature_type` and `feature_id`: of the reports that cover it, the one made last wins (the latest `created_at`, then the greatest `id` to break a tie), since a newer report replaces an older one ([0004](decisions/0004-storage-and-versioning.md#status-overlay)). So a reopening reported after a planned closure was filed cancels it, even when the closure's window starts later, and a report that waited for review never overrides one made after it.
- Rebuilt whenever a status change set publishes, and on a schedule so reports start and end on time (the interval is set in Phase 4).
- It exists from the first publish: until the overlay arrives, the publisher writes one with no entries beside `latest.json` when there is none. A client that still gets no `status.json`, or one it can't read or validate, treats it as having no entries.
- Keyed by stable feature ids of `indoor.json`. A client ignores entries for features the version it loaded doesn't have, and entries whose `valid_until` has passed, in case the file is stale. Routing excludes closed features; the map draws them as closed.
- `note` is shown to everyone, so moderators review it as public text (trusted contributors' reports publish without review, with spot checks). Evidence photos and `evidence_uri` are private and never appear here.

## Privacy

Public files are served from Cloudflare's global edge, so they hold public, non-personal map data only ([0005](decisions/0005-privacy-by-design.md)). They never contain:

- anchors: their positions, `facing_deg`, street priors (`surveyed_geom`, `prior_source`, `prior_sigma_m`) and reference photos (`photo_uri`);
- restricted zones: no outline, no note, nothing that reveals that one exists;
- `venues.permission` (references to landlords' letters), and `venues.operator`, which clients don't need;
- contributors, change sets, moderation events, reviewers, `published_by`;
- captures, bundle URIs, device models, segment alignments, trajectories;
- status evidence (`evidence_uri`) and status reports' ids, change sets and authors;
- private storage keys (`private_export_uri`), `rev` numbers, and bookkeeping times (`updated_at`, `created_at`, `imported_at`);
- OpenStreetMap tags other than `highway` and `footway`.

The schemas enforce the shape: every object has `additionalProperties: false`, so an unlisted field fails validation, and `packages/contracts/test/snapshot.test.ts` checks that no schema names a private field and that each place a builder bug could put one refuses it. The snapshot builder selects the listed columns by name, never `SELECT *`, and validates every file with `@usg/contracts/validators` before uploading it: the version's two files with `validateVersion`, and `latest.json` and `status.json` with `validateSnapshotFile`.

## Validation

`validateSnapshotFile(file, document)` in `@usg/contracts/validators` (Node) checks one file: the schema, then what the schema can't express. `validateVersion(indoor, street)` checks a version's two files, each with `validateSnapshotFile` and then against each other; the snapshot builder runs it before it uploads them. The checks after the schema also run on their own in any environment (`checkIndoorSnapshot` and the others in `@usg/contracts`), except street connectors' ids, which need SHA-1:

- coordinates: latitudes within -90 to 90, at most 7 decimals, closed polygon rings;
- `indoor.json`: unique ids equal to `properties.id`; references that resolve within the file (a level's venue, the level of a space, node or POI, an edge's nodes, a POI's space, a connector's node); ordinals that match their level or nodes; no edge from a node to itself, no step-free stairs or escalator; an edge's line starting exactly at `from_node` and ending exactly at `to_node`; connectors only from exits and entrances, at most one per node, each with its line starting exactly at its node and its id derived from `node_id` (`validateSnapshotFile` only); the sort order;
- `street.json`: unique node ids, edges whose ends are two different nodes in the file and whose lines start exactly at `from_osm_node` and end exactly at `to_osm_node`, the sort order;
- both version files together (`checkStreetConnectors`, run by `validateVersion`): every street connector ends exactly at a street node in `street.json`;
- `latest.json`: each file's path is its own name under `snapshots/<snapshot_sha256>/`; `verifyLatestPointer` also checks `bytes`, `sha256` and `snapshot_sha256` against the files;
- `status.json`: one entry per feature, and windows that cover `generated_at`.
