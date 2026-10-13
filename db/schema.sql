-- Underground SG: draft PostGIS schema (v1)
--
-- Target: PostgreSQL 18 + PostGIS 3.6 (image postgis/postgis:18-3.6).
-- This file stays the draft until the Phase 1 migration task turns it into the first
-- dbmate migration (plain SQL in db/migrations/).
--
-- Model (see docs/decisions/0004-storage-and-versioning.md):
--   * The map tables hold HEAD: the latest approved map. Every HEAD row has a rev,
--     bumped on each approved change that touches it.
--   * Pending work lives in change_sets.diff (entries {op, feature_type, id, base_rev,
--     before, after}; docs/diff-format.md). Each change set records the version it was
--     based on. Approval runs in one transaction: lock map_head, check every touched row
--     still has its base_rev and the base version was not undone by a rollback (otherwise
--     decision = needs_rebase), apply the diff, bump revs, rebuild street_connectors,
--     build and upload the snapshot, write the private full export, insert map_versions,
--     commit. Then update the latest.json pointer.
--   * A change set is inserted as pending and published by an UPDATE that sets its
--     publish_path. The database refuses that unless the automated gates passed
--     (recorded in moderation_events) and no linked capture failed or is privacy-flagged.
--     A published change set, its captures and its status reports are frozen.
--   * Each version has immutable public files (indoor.json, street.json) under a
--     content-addressed path, plus a private full export of HEAD used for rollback.
--     Clients read the public files, never these tables. Every version except a
--     rollback publishes at least one change set, and map_head only moves forward.
--   * Rollback = restore HEAD from an earlier version's private export and publish it
--     as a new version.
--   * Status edits go to status_reports and the status.json overlay. They never create
--     a version.
--   * Who may publish without moderator review is enforced here (publish_path trigger).
--   * Anchors, segment alignment and street priors:
--     docs/decisions/0008-anchors-and-georeferencing.md.
--
-- Conventions (see CLAUDE.md):
--   * Geometry is stored in WGS84 (EPSG:4326). Do metric work in SVY21 (EPSG:3414)
--     via ST_Transform, never in degrees.
--   * levels.ordinal is a display band for the level switcher: 0 = street band,
--     -1 = first basement band, and so on. Several levels of one venue may share a band.
--     Physical height is levels.elevation_m, in metres relative to the cluster height
--     datum (a reference street-level floor, recorded in docs/spec.md). Routing never
--     infers a connection from equal ordinals.
--   * Units are metres and seconds. Times are timestamptz, displayed in Asia/Singapore.
--   * Private, never served publicly: anchors.photo_uri, captures.bundle_uri,
--     status_reports.evidence_uri, map_versions.private_export_uri, restricted_zones
--     (whose outlines also stay out of git).
--   * Drafts live on the phone through Phase 3 (expo-sqlite, client UUIDs plus a
--     server_id mapping). A server-side drafts table arrives in Phase 4.

CREATE EXTENSION IF NOT EXISTS postgis;
-- gen_random_uuid() is built into PostgreSQL; no pgcrypto needed.

-- ---------------------------------------------------------------- enums

-- new, trusted, moderator: contributor tiers. owner: the project owner.
CREATE TYPE trust_tier          AS ENUM ('new', 'trusted', 'moderator', 'owner');
CREATE TYPE venue_kind          AS ENUM ('mall', 'mrt_station', 'link', 'office', 'hotel', 'other');
CREATE TYPE space_kind          AS ENUM ('walkway', 'concourse', 'plaza', 'shop', 'toilet', 'fare_zone', 'other');
-- escalator, lift, stairs, travelator and ramp nodes are landings: one node per end,
-- or one per stop for a lift.
CREATE TYPE node_kind           AS ENUM ('junction', 'exit', 'entrance', 'escalator', 'lift', 'stairs',
                                         'fare_gate', 'door', 'travelator', 'ramp');
-- street: an outdoor link the owner maps between indoor nodes where OSM has no footpath.
-- OSM footpaths live in street_edges, never in edges.
CREATE TYPE edge_kind           AS ENUM ('walk', 'escalator', 'stairs', 'lift', 'ramp', 'travelator', 'street');
-- Routing excludes paid_fare_zone and customers_only edges by default.
CREATE TYPE edge_access         AS ENUM ('public', 'paid_fare_zone', 'customers_only');
CREATE TYPE poi_category        AS ENUM ('shop', 'food', 'toilet', 'atm', 'info', 'nursing_room', 'other');
-- floor_point: ARKit raycast to the floor at a door threshold or fare-gate line, plus facing.
-- image_anchor: ARImageAnchor on a permanent planar sign (repeatable 6-DoF pose).
CREATE TYPE anchor_kind         AS ENUM ('floor_point', 'image_anchor');
-- Where an anchor's absolute street prior (anchors.surveyed_geom) came from.
CREATE TYPE street_prior_source AS ENUM ('lta_exit', 'gnss', 'imagery', 'onemap');
CREATE TYPE capture_status      AS ENUM ('uploading', 'uploaded', 'processing', 'failed',
                                         'ready_for_review', 'approved', 'rejected');
CREATE TYPE change_track        AS ENUM ('structural', 'status');
CREATE TYPE change_decision     AS ENUM ('pending', 'approved', 'rejected', 'auto_published',
                                         'rolled_back', 'needs_rebase');
-- moderator_review: a moderator or the owner approved it (decision = approved).
-- owner_mapper: the owner's structural work from mapper mode (decision = auto_published).
-- trusted_status_auto: a trusted contributor's status edit (decision = auto_published).
-- "Published" means decision IN ('approved', 'auto_published').
-- The automated gates (privacy re-check, restricted-zone check, alignment residual checks,
-- at least two street priors per connected group) must pass on every path:
-- change_sets_guard refuses a publish path without a recorded 'gates_passed'.
CREATE TYPE publish_path        AS ENUM ('moderator_review', 'owner_mapper', 'trusted_status_auto');

-- ---------------------------------------------------------------- people

CREATE TABLE contributors (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name    text NOT NULL,
    trust_tier      trust_tier NOT NULL DEFAULT 'new',
    accepted_count  integer NOT NULL DEFAULT 0,
    rejected_count  integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now()
    -- No sign-in until Phase 4 (the owner is the only mapper). Until then the owner's
    -- devices use per-device tokens, stored hashed; the owner-device-token task (Phase 2)
    -- adds their table. Then email one-time codes plus passkeys; add the identity
    -- columns when that lands.
);

-- ---------------------------------------------------------------- map (HEAD)
-- rev: starts at 1 and is bumped by the approval transaction each time an approved
-- change touches the row. Diff entries carry the base_rev they were made against.

CREATE TABLE venues (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    kind        venue_kind NOT NULL,
    operator    text,                                  -- landlord or station operator
    permission  text,                                  -- reference to written permission to scan
    footprint   geometry(MultiPolygon, 4326),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    rev         integer NOT NULL DEFAULT 1
);
CREATE INDEX venues_footprint_idx ON venues USING gist (footprint);

CREATE TABLE levels (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id     uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    ordinal      smallint NOT NULL,                    -- display band: 0 street, -1 first basement band, ...
    name         text NOT NULL,                        -- as signed on site, e.g. 'B2'
    elevation_m  real,                                 -- metres relative to the cluster height datum; NULL until measured
    sort_key     smallint NOT NULL DEFAULT 0,          -- orders levels of one venue that share a band
    rev          integer NOT NULL DEFAULT 1,
    UNIQUE (venue_id, name),
    UNIQUE (id, venue_id)                              -- target of restricted_zones' (level_id, venue_id) key
);

CREATE TABLE spaces (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    level_id    uuid NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
    kind        space_kind NOT NULL,
    name        text,
    geom        geometry(Polygon, 4326) NOT NULL,
    rev         integer NOT NULL DEFAULT 1
);
CREATE INDEX spaces_geom_idx  ON spaces USING gist (geom);
CREATE INDEX spaces_level_idx ON spaces (level_id);

-- Open/closed state is not stored here: it lives in status_reports (status.json overlay).
CREATE TABLE nodes (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    level_id      uuid REFERENCES levels(id) ON DELETE CASCADE, -- NULL for street nodes outside any venue
    ordinal       smallint NOT NULL,                   -- copy of levels.ordinal, kept in step by trigger; 0 without a level
    kind          node_kind NOT NULL,
    name          text,
    street_name   text,                                -- exits/entrances: the street or building they open onto
    connector_id  uuid,                                -- groups the landings of one physical escalator, lift or stairs
    elevation_m   real,                                -- optional; same datum as levels.elevation_m
    geom          geometry(Point, 4326) NOT NULL,
    rev           integer NOT NULL DEFAULT 1
);
CREATE INDEX nodes_geom_idx      ON nodes USING gist (geom);
CREATE INDEX nodes_kind_idx      ON nodes (kind);
CREATE INDEX nodes_level_idx     ON nodes (level_id);
CREATE INDEX nodes_connector_idx ON nodes (connector_id) WHERE connector_id IS NOT NULL;

-- Keep nodes.ordinal and anchors.ordinal in step with levels.ordinal (rows without a
-- level use 0). FOR SHARE stops a concurrent change to the level's band from committing
-- between this read and the insert.
CREATE FUNCTION sync_ordinal_from_level() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    band smallint;
BEGIN
    IF NEW.level_id IS NULL THEN
        NEW.ordinal := 0;
    ELSE
        SELECT l.ordinal INTO band FROM levels l WHERE l.id = NEW.level_id FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION '% %: level % does not exist', TG_TABLE_NAME, NEW.id, NEW.level_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        NEW.ordinal := band;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER nodes_sync_ordinal
    BEFORE INSERT OR UPDATE OF level_id, ordinal ON nodes
    FOR EACH ROW EXECUTE FUNCTION sync_ordinal_from_level();

CREATE FUNCTION levels_propagate_ordinal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE nodes   SET ordinal = NEW.ordinal WHERE level_id = NEW.id;
    UPDATE anchors SET ordinal = NEW.ordinal WHERE level_id = NEW.id;
    RETURN NULL;
END;
$$;

CREATE TRIGGER levels_propagate_ordinal
    AFTER UPDATE OF ordinal ON levels
    FOR EACH ROW WHEN (OLD.ordinal IS DISTINCT FROM NEW.ordinal)
    EXECUTE FUNCTION levels_propagate_ordinal();

-- Vertical connectors: an edge of kind escalator, stairs, lift, ramp or travelator joins
-- two landing nodes on different levels, has level_id NULL and is drawn on both end
-- levels. A lift is one landing node per stop sharing a connector_id, with edges between
-- consecutive stops (the boarding penalty is applied once, by the router). The router
-- never infers a connection from equal ordinals.
CREATE TABLE edges (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_node      uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    to_node        uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    kind           edge_kind NOT NULL,
    oneway         boolean NOT NULL DEFAULT false,     -- true: traversable only from_node -> to_node
    access         edge_access NOT NULL DEFAULT 'public',
    opening_hours  text,                               -- OSM opening_hours syntax, Asia/Singapore time; NULL = always open
    level_id       uuid REFERENCES levels(id) ON DELETE CASCADE, -- set for single-level edges, NULL for connectors
    connector_id   uuid,                               -- the physical connector this edge belongs to
    length_m       real NOT NULL CHECK (length_m >= 0),
    step_free      boolean NOT NULL,
    sheltered      boolean NOT NULL,
    outdoor        boolean NOT NULL,
    geom           geometry(LineString, 4326),         -- centreline, for drawing the route
    rev            integer NOT NULL DEFAULT 1,
    CHECK (from_node <> to_node),
    CHECK (kind NOT IN ('stairs', 'escalator') OR step_free = false)
);
CREATE INDEX edges_from_idx      ON edges (from_node);
CREATE INDEX edges_to_idx        ON edges (to_node);
CREATE INDEX edges_level_idx     ON edges (level_id);
CREATE INDEX edges_connector_idx ON edges (connector_id) WHERE connector_id IS NOT NULL;
CREATE INDEX edges_geom_idx      ON edges USING gist (geom);

-- An anchor is a physical feature (door threshold, fare-gate line or permanent sign),
-- not the phone's pose at a tap. Street-facing anchors carry an absolute prior
-- (surveyed_geom with its source and sigma) for the network adjustment; every connected
-- group of segments needs at least two widely spaced priors before it can be published.
CREATE TABLE anchors (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id         uuid REFERENCES nodes(id) ON DELETE SET NULL,
    kind            anchor_kind NOT NULL,
    name            text NOT NULL,                     -- e.g. 'Funan B2 UPL door'
    level_id        uuid REFERENCES levels(id),        -- NULL for street anchors
    ordinal         smallint NOT NULL,                 -- copy of levels.ordinal, kept in step by trigger; 0 without a level
    facing_deg      real CHECK (facing_deg >= 0 AND facing_deg < 360), -- way the door or sign faces, degrees clockwise from SVY21 grid north
    surveyed_geom   geometry(Point, 4326),             -- absolute street prior; NULL if indoor-only
    prior_source    street_prior_source,
    prior_sigma_m   real CHECK (prior_sigma_m > 0),
    photo_uri       text,                              -- private reference photo so mappers can find it again
    created_at      timestamptz NOT NULL DEFAULT now(),
    rev             integer NOT NULL DEFAULT 1,
    -- A prior needs a source and a sigma; without surveyed_geom both stay NULL.
    CHECK ((surveyed_geom IS NULL) = (prior_source IS NULL)
       AND (surveyed_geom IS NULL) = (prior_sigma_m IS NULL))
);
CREATE INDEX anchors_surveyed_geom_idx ON anchors USING gist (surveyed_geom);
CREATE INDEX anchors_node_idx          ON anchors (node_id);
CREATE INDEX anchors_level_idx         ON anchors (level_id);

CREATE TRIGGER anchors_sync_ordinal
    BEFORE INSERT OR UPDATE OF level_id, ordinal ON anchors
    FOR EACH ROW EXECUTE FUNCTION sync_ordinal_from_level();

CREATE TABLE pois (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    space_id    uuid REFERENCES spaces(id) ON DELETE SET NULL,
    level_id    uuid NOT NULL REFERENCES levels(id) ON DELETE CASCADE,
    name        text NOT NULL,
    category    poi_category NOT NULL,
    geom        geometry(Point, 4326) NOT NULL,
    rev         integer NOT NULL DEFAULT 1
);
CREATE INDEX pois_geom_idx  ON pois USING gist (geom);
CREATE INDEX pois_level_idx ON pois (level_id);

-- ---------------------------------------------------------------- restricted areas (never published)
-- Back-of-house, service and security areas. Private: the outlines never go in git,
-- public files or logs. Extraction clips against them, and no HEAD feature may overlap
-- the interior of one (sharing an edge is fine), on every publish path. Not versioned:
-- a level or venue that has zones cannot be deleted, so a rollback never drops them.

CREATE TABLE restricted_zones (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id  uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
    level_id  uuid,                                    -- NULL = every level of the venue
    geom      geometry(Polygon, 4326) NOT NULL CHECK (ST_IsValid(geom)),
    note      text,
    -- The level must belong to the zone's venue. MATCH SIMPLE: a NULL level_id is not checked.
    FOREIGN KEY (level_id, venue_id) REFERENCES levels (id, venue_id) ON DELETE RESTRICT
);
CREATE INDEX restricted_zones_geom_idx  ON restricted_zones USING gist (geom);
CREATE INDEX restricted_zones_venue_idx ON restricted_zones (venue_id);

-- Refuse a feature on a venue level whose geometry overlaps the interior of a zone on that
-- level (or a venue-wide zone). Boundary contact is allowed: a walkway that shares the
-- zone's edge, or a door on it. Rows without a level (street nodes, connector edges) are
-- checked by the approval code against both end levels.
CREATE FUNCTION reject_restricted_overlap() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.geom IS NOT NULL AND NEW.level_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM restricted_zones rz
        JOIN levels l ON l.id = NEW.level_id
        WHERE rz.venue_id = l.venue_id
          AND (rz.level_id IS NULL OR rz.level_id = NEW.level_id)
          AND rz.geom && NEW.geom
          AND ST_Relate(NEW.geom, rz.geom, 'T********')) THEN
        RAISE EXCEPTION '% %: overlaps a restricted zone', TG_TABLE_NAME, NEW.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_not_restricted BEFORE INSERT OR UPDATE OF geom, level_id ON spaces
    FOR EACH ROW EXECUTE FUNCTION reject_restricted_overlap();
CREATE TRIGGER nodes_not_restricted  BEFORE INSERT OR UPDATE OF geom, level_id ON nodes
    FOR EACH ROW EXECUTE FUNCTION reject_restricted_overlap();
CREATE TRIGGER edges_not_restricted  BEFORE INSERT OR UPDATE OF geom, level_id ON edges
    FOR EACH ROW EXECUTE FUNCTION reject_restricted_overlap();
CREATE TRIGGER pois_not_restricted   BEFORE INSERT OR UPDATE OF geom, level_id ON pois
    FOR EACH ROW EXECUTE FUNCTION reject_restricted_overlap();

-- ---------------------------------------------------------------- street side (imported from OSM)
-- A street graph keyed by OSM node ID, published per version as street.json (ODbL),
-- separate from the indoor data. Imported reference data, not HEAD: each version's
-- street.json is built from these tables as they stand at publish, and a rollback does
-- not roll them back. The import drops ways with tunnel=yes, indoor=*, negative level or
-- layer, and ways inside venue footprints (OSM already maps some underground links). It is
-- re-runnable and idempotent; nothing references street_edges.id, so a re-import may
-- replace the rows in one transaction.

CREATE TABLE street_nodes (
    osm_node_id  bigint PRIMARY KEY,
    geom         geometry(Point, 4326) NOT NULL
);
CREATE INDEX street_nodes_geom_idx ON street_nodes USING gist (geom);

CREATE TABLE street_edges (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    osm_way_id     bigint NOT NULL,
    from_osm_node  bigint NOT NULL REFERENCES street_nodes(osm_node_id) ON DELETE CASCADE,
    to_osm_node    bigint NOT NULL REFERENCES street_nodes(osm_node_id) ON DELETE CASCADE,
    tags           jsonb NOT NULL DEFAULT '{}',
    covered        boolean NOT NULL DEFAULT false,     -- covered=yes plus tunnel/building/roof heuristics
    length_m       real NOT NULL CHECK (length_m >= 0), -- measured in SVY21
    geom           geometry(LineString, 4326) NOT NULL,
    imported_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX street_edges_geom_idx ON street_edges USING gist (geom);
CREATE INDEX street_edges_way_idx  ON street_edges (osm_way_id);
CREATE INDEX street_edges_from_idx ON street_edges (from_osm_node);
CREATE INDEX street_edges_to_idx   ON street_edges (to_osm_node);

-- Joins each exit/entrance node to the nearest street vertex, computed in SVY21.
-- Published in indoor.json. Derived, not HEAD: rebuilt for every exit and entrance inside
-- each publish transaction, so a cascade below never reaches a published file.
CREATE TABLE street_connectors (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id      uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    osm_node_id  bigint NOT NULL REFERENCES street_nodes(osm_node_id) ON DELETE CASCADE,
    length_m     real NOT NULL CHECK (length_m >= 0),
    geom         geometry(LineString, 4326) NOT NULL
);
CREATE INDEX street_connectors_geom_idx     ON street_connectors USING gist (geom);
CREATE INDEX street_connectors_node_idx     ON street_connectors (node_id);
CREATE INDEX street_connectors_osm_node_idx ON street_connectors (osm_node_id);

-- ---------------------------------------------------------------- capture and review

CREATE TABLE captures (
    id               uuid PRIMARY KEY,                 -- generated on the phone; matches the bundle's capture_id
    contributor_id   uuid NOT NULL REFERENCES contributors(id), -- from the upload's auth, never from the manifest
    start_anchor_id  uuid REFERENCES anchors(id),
    end_anchor_id    uuid REFERENCES anchors(id),
    bundle_uri       text,                             -- private object storage, never public
    status           capture_status NOT NULL DEFAULT 'uploading',
    device_model     text,
    os_version       text,
    app_version      text,
    drift_m          real,                             -- end-anchor gap from the phone; NULL when not computable
    failure_reason   text,                             -- e.g. 'privacy'
    -- Set by the privacy re-check when it quarantines frames. A flagged capture blocks
    -- publishing on every path until the owner or a moderator clears the flag (recorded
    -- in moderation_events as 'privacy_flag_cleared').
    privacy_flagged  boolean NOT NULL DEFAULT false,
    -- Frame indices of keyframes the re-check removed from the stored bundle; validating
    -- the stored bundle again expects their files to be missing.
    quarantined_frames integer[] NOT NULL DEFAULT '{}',
    captured_at      timestamptz NOT NULL,
    uploaded_at      timestamptz
);
CREATE INDEX captures_contributor_idx ON captures (contributor_id);
CREATE INDEX captures_status_idx      ON captures (status);

-- One row per capture per network adjustment run (solve_id). The transform takes the
-- capture's ARKit world frame into SVY21: yaw about the vertical, then translation, with
-- tz_m relative to the cluster height datum (ARKit is gravity-aligned and metric, so no
-- roll, pitch or scale). Residuals are the leftover gaps at the segment's start and end
-- anchors. Where each anchor's solved position and yaw (and its residual against its
-- street prior) are stored is decided in the Phase 2 network-adjustment task.
-- See docs/decisions/0008-anchors-and-georeferencing.md.
CREATE TABLE segment_alignments (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    capture_id        uuid NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    solve_id          uuid NOT NULL,
    tx_m              real NOT NULL,
    ty_m              real NOT NULL,
    tz_m              real NOT NULL,
    yaw_rad           real NOT NULL,                   -- SVY21 frame
    start_residual_m  real,
    end_residual_m    real,
    solved_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (solve_id, capture_id)
);
CREATE INDEX segment_alignments_capture_idx ON segment_alignments (capture_id);

-- Immutable once written: the triggers at the end reject UPDATE, DELETE and TRUNCATE.
CREATE TABLE map_versions (
    id                  serial PRIMARY KEY,            -- 1, 2, 3 ...
    published_at        timestamptz NOT NULL DEFAULT now(),
    published_by        uuid REFERENCES contributors(id),
    snapshot_uri        text NOT NULL,                 -- immutable content-addressed path of indoor.json and street.json
    snapshot_sha256     text NOT NULL,                 -- content hash of the public snapshot (docs/snapshot-format.md)
    private_export_uri  text NOT NULL,                 -- private full export of every HEAD table, anchors included; used for rollback
    restores            integer REFERENCES map_versions(id), -- set when this version is a rollback
    note                text
);

-- Single row pointing at the current version. The approval transaction takes
-- SELECT ... FROM map_head FOR UPDATE first, so approvals are serialised. The row cannot
-- be deleted or truncated, and version_id only moves forward: a rollback publishes a new
-- version, never re-points the head.
CREATE TABLE map_head (
    id          boolean PRIMARY KEY DEFAULT true CHECK (id),
    version_id  integer REFERENCES map_versions(id)    -- NULL until the first version is published
);
INSERT INTO map_head DEFAULT VALUES;

CREATE FUNCTION map_head_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
        RAISE EXCEPTION 'map_head: % is not allowed', TG_OP USING ERRCODE = 'raise_exception';
    END IF;
    IF OLD.version_id IS NOT NULL AND (NEW.version_id IS NULL OR NEW.version_id <= OLD.version_id) THEN
        RAISE EXCEPTION 'map_head only moves forward (% -> %); a rollback publishes a new version',
            OLD.version_id, NEW.version_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER map_head_guard
    BEFORE UPDATE OR DELETE ON map_head
    FOR EACH ROW EXECUTE FUNCTION map_head_guard();
CREATE TRIGGER map_head_no_truncate
    BEFORE TRUNCATE ON map_head
    FOR EACH STATEMENT EXECUTE FUNCTION map_head_guard();

-- A structural change set with no captures is a manual edit (move a node, retag, redraw
-- an outline). It can publish only through moderator_review or owner_mapper, because
-- trusted_status_auto needs track = status. A status change set has an empty diff: its
-- content is its status_reports rows.
CREATE TABLE change_sets (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contributor_id   uuid NOT NULL REFERENCES contributors(id),
    track            change_track NOT NULL,
    base_version_id  integer REFERENCES map_versions(id), -- the version the diff was made against
    diff             jsonb NOT NULL,                    -- docs/diff-format.md
    note             text,
    decision         change_decision NOT NULL DEFAULT 'pending',
    publish_path     publish_path,                      -- set when published; never changes afterwards
    reviewer_id      uuid REFERENCES contributors(id),
    reviewed_at      timestamptz,
    map_version_id   integer REFERENCES map_versions(id), -- the version that published it (structural only)
    created_at       timestamptz NOT NULL DEFAULT now(),
    -- Target of status_reports' (change_set_id, track) key.
    CONSTRAINT change_sets_id_track_key UNIQUE (id, track),
    -- The decision and the publish path agree, so nothing is published without a path.
    CONSTRAINT change_sets_decision_matches_path CHECK (CASE decision
        WHEN 'approved'       THEN publish_path IS NOT DISTINCT FROM 'moderator_review'
        WHEN 'auto_published' THEN publish_path IS NOT NULL AND publish_path <> 'moderator_review'
        WHEN 'rolled_back'    THEN publish_path IS NOT NULL
        ELSE                       publish_path IS NULL  -- pending, rejected, needs_rebase
    END),
    -- Status edits never create a map version. A structural change set has a version
    -- exactly when it was published (rolled_back ones keep theirs).
    CONSTRAINT change_sets_version_iff_published CHECK (CASE track
        WHEN 'status' THEN map_version_id IS NULL
        ELSE (decision IN ('approved', 'auto_published', 'rolled_back')) = (map_version_id IS NOT NULL)
    END),
    CONSTRAINT change_sets_status_has_no_diff CHECK (track = 'structural' OR diff = '[]'::jsonb)
);
CREATE INDEX change_sets_pending_idx     ON change_sets (created_at) WHERE decision = 'pending';
CREATE INDEX change_sets_contributor_idx ON change_sets (contributor_id);
CREATE INDEX change_sets_base_idx        ON change_sets (base_version_id);
CREATE INDEX change_sets_version_idx     ON change_sets (map_version_id);

-- Publish-path eligibility:
--   owner_mapper         track = structural and contributor's tier is owner
--   trusted_status_auto  track = status and contributor's tier is trusted, moderator or owner
--   moderator_review     reviewer's tier is moderator or owner, and reviewer <> contributor
-- Checked when the path is set or an input to the rule changes, using tiers at that
-- moment; later decision changes (e.g. rolled_back) are not re-checked.
CREATE FUNCTION change_sets_check_publish_path() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    contributor_tier trust_tier;
    reviewer_tier    trust_tier;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.publish_path IS NOT NULL AND NEW.publish_path IS DISTINCT FROM OLD.publish_path THEN
            RAISE EXCEPTION 'change set %: publish_path cannot change once set', NEW.id
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.publish_path   IS NOT DISTINCT FROM OLD.publish_path
           AND NEW.contributor_id IS NOT DISTINCT FROM OLD.contributor_id
           AND NEW.reviewer_id    IS NOT DISTINCT FROM OLD.reviewer_id
           AND NEW.track          IS NOT DISTINCT FROM OLD.track THEN
            RETURN NEW;
        END IF;
    END IF;

    IF NEW.publish_path IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT c.trust_tier INTO contributor_tier FROM contributors c WHERE c.id = NEW.contributor_id;

    CASE NEW.publish_path
    WHEN 'owner_mapper' THEN
        IF NEW.track <> 'structural' THEN
            RAISE EXCEPTION 'change set %: owner_mapper is for structural change sets only', NEW.id
                USING ERRCODE = 'check_violation';
        END IF;
        IF contributor_tier IS DISTINCT FROM 'owner' THEN
            RAISE EXCEPTION 'change set %: owner_mapper needs a contributor with tier owner (got %)',
                NEW.id, contributor_tier USING ERRCODE = 'check_violation';
        END IF;
    WHEN 'trusted_status_auto' THEN
        IF NEW.track <> 'status' THEN
            RAISE EXCEPTION 'change set %: trusted_status_auto is for status edits only', NEW.id
                USING ERRCODE = 'check_violation';
        END IF;
        IF contributor_tier IS NULL OR contributor_tier NOT IN ('trusted', 'moderator', 'owner') THEN
            RAISE EXCEPTION 'change set %: trusted_status_auto needs tier trusted, moderator or owner (got %)',
                NEW.id, contributor_tier USING ERRCODE = 'check_violation';
        END IF;
    WHEN 'moderator_review' THEN
        IF NEW.reviewer_id IS NULL OR NEW.reviewer_id = NEW.contributor_id THEN
            RAISE EXCEPTION 'change set %: moderator_review needs a reviewer other than the contributor', NEW.id
                USING ERRCODE = 'check_violation';
        END IF;
        SELECT c.trust_tier INTO reviewer_tier FROM contributors c WHERE c.id = NEW.reviewer_id;
        IF reviewer_tier IS NULL OR reviewer_tier NOT IN ('moderator', 'owner') THEN
            RAISE EXCEPTION 'change set %: reviewer needs tier moderator or owner (got %)',
                NEW.id, reviewer_tier USING ERRCODE = 'check_violation';
        END IF;
    END CASE;
    RETURN NEW;
END;
$$;

CREATE TRIGGER change_sets_check_publish_path
    BEFORE INSERT OR UPDATE ON change_sets
    FOR EACH ROW EXECUTE FUNCTION change_sets_check_publish_path();

-- Publishing and immutability:
--   * Publishing (publish_path goes from NULL to set) needs a 'gates_passed' event with no
--     later 'gates_failed', every linked capture in ready_for_review or approved and not
--     privacy-flagged, and, on trusted_status_auto, a valid_until on every status report.
--     The event needs the change set's id, so a change set is inserted as pending and
--     published by an UPDATE.
--   * Once published, a change set cannot be deleted, and its diff, track, contributor,
--     base version, reviewer and map version are frozen.
--   * rejected and rolled_back are final.
CREATE FUNCTION change_sets_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.publish_path IS NOT NULL THEN
            RAISE EXCEPTION 'change set %: a published change set cannot be deleted', OLD.id
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.publish_path IS NOT NULL
           AND (NEW.diff, NEW.track, NEW.contributor_id, NEW.base_version_id, NEW.reviewer_id, NEW.map_version_id)
               IS DISTINCT FROM
               (OLD.diff, OLD.track, OLD.contributor_id, OLD.base_version_id, OLD.reviewer_id, OLD.map_version_id) THEN
            RAISE EXCEPTION 'change set %: a published change set is frozen', NEW.id
                USING ERRCODE = 'check_violation';
        END IF;
        IF OLD.decision IN ('rejected', 'rolled_back') AND NEW.decision IS DISTINCT FROM OLD.decision THEN
            RAISE EXCEPTION 'change set %: % is final', NEW.id, OLD.decision
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF NEW.publish_path IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.publish_path IS NULL) THEN
        IF NOT EXISTS (
            SELECT 1 FROM moderation_events e
            WHERE e.change_set_id = NEW.id AND e.action = 'gates_passed'
              AND NOT EXISTS (SELECT 1 FROM moderation_events f
                              WHERE f.change_set_id = NEW.id AND f.action = 'gates_failed'
                                AND f.id > e.id)) THEN
            RAISE EXCEPTION 'change set %: the automated gates have not passed', NEW.id
                USING ERRCODE = 'check_violation';
        END IF;
        IF EXISTS (
            SELECT 1 FROM change_set_captures csc JOIN captures c ON c.id = csc.capture_id
            WHERE csc.change_set_id = NEW.id
              AND (c.status NOT IN ('ready_for_review', 'approved') OR c.privacy_flagged)) THEN
            RAISE EXCEPTION 'change set %: a linked capture failed or is privacy-flagged', NEW.id
                USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.publish_path = 'trusted_status_auto' AND EXISTS (
            SELECT 1 FROM status_reports s
            WHERE s.change_set_id = NEW.id AND s.valid_until IS NULL) THEN
            RAISE EXCEPTION 'change set %: reports published through trusted_status_auto need valid_until', NEW.id
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER change_sets_guard
    BEFORE INSERT OR UPDATE OR DELETE ON change_sets
    FOR EACH ROW EXECUTE FUNCTION change_sets_guard();

-- Rows that belong to a published change set are frozen (change_set_captures,
-- status_reports). A status report is ended by a newer report, not by editing.
CREATE FUNCTION frozen_once_published() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (TG_OP <> 'INSERT' AND EXISTS (SELECT 1 FROM change_sets
                                      WHERE id = OLD.change_set_id AND publish_path IS NOT NULL))
       OR (TG_OP <> 'DELETE' AND EXISTS (SELECT 1 FROM change_sets
                                         WHERE id = NEW.change_set_id AND publish_path IS NOT NULL)) THEN
        RAISE EXCEPTION '%: its change set is published', TG_TABLE_NAME
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TABLE change_set_captures (
    change_set_id  uuid NOT NULL REFERENCES change_sets(id) ON DELETE CASCADE,
    capture_id     uuid NOT NULL REFERENCES captures(id),
    PRIMARY KEY (change_set_id, capture_id)
);
CREATE INDEX change_set_captures_capture_idx ON change_set_captures (capture_id);

CREATE TRIGGER change_set_captures_frozen
    BEFORE INSERT OR UPDATE OR DELETE ON change_set_captures
    FOR EACH ROW EXECUTE FUNCTION frozen_once_published();

-- Append-only audit of moderation: the triggers below reject UPDATE, DELETE and TRUNCATE.
-- action is free text; change_sets_guard reads 'gates_passed' and 'gates_failed', and a
-- cleared privacy flag is recorded as 'privacy_flag_cleared'. The full list is set with
-- the moderation UI in Phase 4.
CREATE TABLE moderation_events (
    id             bigserial PRIMARY KEY,
    change_set_id  uuid NOT NULL REFERENCES change_sets(id),
    actor_id       uuid REFERENCES contributors(id),   -- NULL for automated gates
    action         text NOT NULL,
    detail         jsonb NOT NULL DEFAULT '{}',
    at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_events_change_set_idx ON moderation_events (change_set_id, at);

-- Status edits (exit closed, lift down), always on a status change set. Keyed by stable
-- feature IDs, so there is no foreign key to the feature; a report on a removed feature
-- drops out of the overlay. Rows whose change set is published (decision approved or
-- auto_published) and whose validity window covers now build status.json.
CREATE TABLE status_reports (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    feature_type   text NOT NULL CHECK (feature_type IN ('node', 'edge')),
    feature_id     uuid NOT NULL,
    is_open        boolean NOT NULL,
    note           text,
    evidence_uri   text,                               -- private
    valid_from     timestamptz NOT NULL,
    valid_until    timestamptz,                        -- NULL = until replaced (moderator_review only)
    change_set_id  uuid NOT NULL,
    track          change_track NOT NULL DEFAULT 'status' CHECK (track = 'status'),
    created_at     timestamptz NOT NULL DEFAULT now(),
    CHECK (valid_until IS NULL OR valid_until > valid_from),
    -- Only a status change set can carry reports.
    FOREIGN KEY (change_set_id, track) REFERENCES change_sets (id, track)
);
CREATE INDEX status_reports_feature_idx    ON status_reports (feature_type, feature_id);
CREATE INDEX status_reports_change_set_idx ON status_reports (change_set_id);

CREATE TRIGGER status_reports_frozen
    BEFORE INSERT OR UPDATE OR DELETE ON status_reports
    FOR EACH ROW EXECUTE FUNCTION frozen_once_published();

-- Every version except a rollback publishes at least one change set. Checked at commit,
-- because the change set is pointed at the version after the version row is inserted.
CREATE FUNCTION map_versions_need_change_set() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.restores IS NULL AND NOT EXISTS (
        SELECT 1 FROM change_sets cs
        WHERE cs.map_version_id = NEW.id AND cs.decision IN ('approved', 'auto_published')) THEN
        RAISE EXCEPTION 'map version % publishes no change set', NEW.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER map_versions_need_change_set
    AFTER INSERT ON map_versions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION map_versions_need_change_set();

-- ---------------------------------------------------------------- write-once tables

CREATE FUNCTION reject_update_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is write-once: % is not allowed', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER map_versions_write_once
    BEFORE UPDATE OR DELETE ON map_versions
    FOR EACH ROW EXECUTE FUNCTION reject_update_delete();
CREATE TRIGGER map_versions_no_truncate
    BEFORE TRUNCATE ON map_versions
    FOR EACH STATEMENT EXECUTE FUNCTION reject_update_delete();

CREATE TRIGGER moderation_events_write_once
    BEFORE UPDATE OR DELETE ON moderation_events
    FOR EACH ROW EXECUTE FUNCTION reject_update_delete();
CREATE TRIGGER moderation_events_no_truncate
    BEFORE TRUNCATE ON moderation_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_update_delete();
