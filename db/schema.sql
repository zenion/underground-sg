-- Underground SG: draft PostGIS schema (v0)
--
-- Model (see docs/decisions/0004-storage-and-versioning.md):
--   * These tables hold HEAD: the latest approved map.
--   * Pending work (contributor submissions, mapper drafts) lives in change_sets.diff
--     and is applied to HEAD only when approved, in one transaction.
--   * Every approval writes a map_versions row and an immutable snapshot file
--     (snapshot_uri). The webapp reads snapshots, never these tables directly.
--   * Rollback = restore HEAD from an earlier snapshot and publish it as a new version.
--
-- Conventions (see CLAUDE.md):
--   * Geometry is stored in WGS84 (EPSG:4326). Do metric work in SVY21 (EPSG:3414)
--     via ST_Transform, never in degrees.
--   * levels.ordinal is a city-wide height band: 0 = street level, -1 = B1, -2 = B2.
--   * Units are metres.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------- enums

CREATE TYPE trust_tier       AS ENUM ('new', 'trusted', 'moderator', 'owner');
CREATE TYPE venue_kind       AS ENUM ('mall', 'mrt_station', 'link', 'office', 'hotel', 'other');
CREATE TYPE space_kind       AS ENUM ('walkway', 'concourse', 'plaza', 'shop', 'toilet', 'fare_zone', 'other');
CREATE TYPE node_kind        AS ENUM ('junction', 'exit', 'entrance', 'escalator', 'lift', 'stairs',
                                      'fare_gate', 'door', 'travelator', 'ramp');
CREATE TYPE edge_kind        AS ENUM ('walk', 'escalator', 'stairs', 'lift', 'ramp', 'travelator', 'street');
CREATE TYPE poi_category     AS ENUM ('shop', 'food', 'toilet', 'atm', 'info', 'nursing_room', 'other');
CREATE TYPE capture_status   AS ENUM ('uploading', 'uploaded', 'processing', 'failed',
                                      'ready_for_review', 'approved', 'rejected');
CREATE TYPE change_track     AS ENUM ('structural', 'status');
CREATE TYPE change_decision  AS ENUM ('pending', 'approved', 'rejected', 'auto_published', 'rolled_back');

-- ---------------------------------------------------------------- people

CREATE TABLE contributors (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name    text NOT NULL,
    trust_tier      trust_tier NOT NULL DEFAULT 'new',
    accepted_count  integer NOT NULL DEFAULT 0,
    rejected_count  integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now()
    -- auth identity is an open question (email + passkeys, or Singpass); add when decided
);

-- ---------------------------------------------------------------- map (HEAD)

CREATE TABLE venues (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    kind        venue_kind NOT NULL,
    owner       text,                                  -- landlord or operator
    permission  text,                                  -- reference to written permission to scan
    footprint   geometry(MultiPolygon, 4326),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE levels (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id    uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    ordinal     smallint NOT NULL,                     -- 0 street, negative below ground
    name        text NOT NULL,                         -- as signed on site, e.g. 'B2'
    UNIQUE (venue_id, ordinal)
);

CREATE TABLE spaces (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    level_id    uuid NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
    kind        space_kind NOT NULL,
    name        text,
    geom        geometry(Polygon, 4326) NOT NULL
);
CREATE INDEX spaces_geom_idx ON spaces USING gist (geom);

CREATE TABLE nodes (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    level_id     uuid REFERENCES levels(id) ON DELETE CASCADE, -- NULL for street-level nodes outside any venue
    ordinal      smallint NOT NULL,                    -- denormalised from level for routing; 0 on the street
    kind         node_kind NOT NULL,
    name         text,
    street_name  text,                                 -- exits/entrances: the street or building they open onto
    status_open  boolean NOT NULL DEFAULT true,        -- status-track edits flip this (closed exit, lift down)
    geom         geometry(Point, 4326) NOT NULL
);
CREATE INDEX nodes_geom_idx ON nodes USING gist (geom);
CREATE INDEX nodes_kind_idx ON nodes (kind);

CREATE TABLE edges (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_node    uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    to_node      uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    kind         edge_kind NOT NULL,
    oneway       boolean NOT NULL DEFAULT false,       -- escalators and travelators
    length_m     real NOT NULL CHECK (length_m >= 0),
    step_free    boolean NOT NULL,
    sheltered    boolean NOT NULL,
    outdoor      boolean NOT NULL,
    status_open  boolean NOT NULL DEFAULT true,
    geom         geometry(LineString, 4326),           -- centreline, for drawing the route
    CHECK (from_node <> to_node)
);
CREATE INDEX edges_from_idx ON edges (from_node);
CREATE INDEX edges_to_idx   ON edges (to_node);

CREATE TABLE anchors (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id         uuid REFERENCES nodes(id) ON DELETE SET NULL,
    name            text NOT NULL,                     -- e.g. 'Funan B2 UPL door'
    surveyed_geom   geometry(Point, 4326),             -- from OneMap/SVY21 when street-facing; NULL if indoor-only
    ordinal         smallint NOT NULL,
    photo_uri       text,                              -- reference photo so mappers can find it again
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pois (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    space_id    uuid REFERENCES spaces(id) ON DELETE SET NULL,
    level_id    uuid NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
    name        text NOT NULL,
    category    poi_category NOT NULL,
    geom        geometry(Point, 4326) NOT NULL
);
CREATE INDEX pois_geom_idx ON pois USING gist (geom);

-- ---------------------------------------------------------------- street side (imported)

CREATE TABLE osm_footpaths (
    osm_way_id  bigint PRIMARY KEY,
    tags        jsonb NOT NULL DEFAULT '{}',
    covered     boolean NOT NULL DEFAULT false,        -- from covered=yes, for 'sheltered' routing
    geom        geometry(LineString, 4326) NOT NULL,
    imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX osm_footpaths_geom_idx ON osm_footpaths USING gist (geom);

-- ---------------------------------------------------------------- capture and review

CREATE TABLE captures (
    id               uuid PRIMARY KEY,                 -- generated on the phone; matches the bundle's capture_id
    contributor_id   uuid NOT NULL REFERENCES contributors(id),
    start_anchor_id  uuid REFERENCES anchors(id),
    end_anchor_id    uuid REFERENCES anchors(id),
    bundle_uri       text,                             -- private object storage, never public
    status           capture_status NOT NULL DEFAULT 'uploading',
    device_model     text,
    drift_m          real,                             -- end-anchor gap measured on the phone
    failure_reason   text,
    captured_at      timestamptz NOT NULL,
    uploaded_at      timestamptz
);

CREATE TABLE map_versions (
    id            serial PRIMARY KEY,                  -- 1, 2, 3 ... ; immutable once written
    published_at  timestamptz NOT NULL DEFAULT now(),
    published_by  uuid REFERENCES contributors(id),
    snapshot_uri  text NOT NULL,                       -- immutable JSON snapshot the webapp loads
    restores      integer REFERENCES map_versions(id), -- set when this version is a rollback
    note          text
);

CREATE TABLE change_sets (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contributor_id  uuid NOT NULL REFERENCES contributors(id),
    capture_id      uuid REFERENCES captures(id),       -- structural track
    track           change_track NOT NULL,
    diff            jsonb NOT NULL,                     -- added / modified / removed features
    evidence_uri    text,                               -- status track: photo or note
    note            text,
    decision        change_decision NOT NULL DEFAULT 'pending',
    reviewer_id     uuid REFERENCES contributors(id),
    reviewed_at     timestamptz,
    map_version_id  integer REFERENCES map_versions(id), -- the version that published it
    created_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (track = 'status' OR capture_id IS NOT NULL),  -- structural changes need a scan
    CHECK (reviewer_id IS NULL OR reviewer_id <> contributor_id
           OR decision = 'auto_published')               -- owner mapper-mode publishes use auto_published
);
CREATE INDEX change_sets_pending_idx ON change_sets (created_at) WHERE decision = 'pending';
