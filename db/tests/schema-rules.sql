-- Database rule tests for db/schema.sql (draft v1), with synthetic data at City Hall
-- cluster coordinates. Run against an EMPTY database (the script is not idempotent):
--   psql -v ON_ERROR_STOP=1 -f db/schema.sql -f db/tests/schema-rules.sql
-- Every refused case must fail for the intended reason; a refused case that is accepted
-- raises 'TEST FAILED'. Validated on postgis/postgis:18-3.6 (PostgreSQL 18.6, PostGIS 3.6.4).
-- The backlog's "Database rule tests" task turns this into tests that run against the
-- compose stack in CI.
\set ON_ERROR_STOP 1
SET client_min_messages = warning;

CREATE FUNCTION pg_temp.expect_fail(label text, stmt text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    BEGIN
        EXECUTE stmt;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'ok (rejected) %: %', label, SQLERRM;
        RETURN;
    END;
    RAISE EXCEPTION 'TEST FAILED: % was accepted', label;
END $$;

CREATE FUNCTION pg_temp.expect_eq(label text, got text, want text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF got IS DISTINCT FROM want THEN
        RAISE EXCEPTION 'TEST FAILED: %: got %, want %', label, got, want;
    END IF;
    RAISE WARNING 'ok %', label;
END $$;

-- people
INSERT INTO contributors (id, display_name, trust_tier) VALUES
    ('00000000-0000-0000-0000-00000000000a', 'Josh',    'owner'),
    ('00000000-0000-0000-0000-00000000000b', 'Mod',     'moderator'),
    ('00000000-0000-0000-0000-00000000000c', 'Trusted', 'trusted'),
    ('00000000-0000-0000-0000-00000000000d', 'Newbie',  'new');

-- venues and levels (City Hall cluster coordinates)
INSERT INTO venues (id, name, kind, operator) VALUES
    ('10000000-0000-0000-0000-000000000001', 'Funan', 'mall', 'landlord'),
    ('10000000-0000-0000-0000-000000000002', 'Raffles City', 'mall', 'landlord');
INSERT INTO levels (id, venue_id, ordinal, name, elevation_m, sort_key) VALUES
    ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', -2, 'B2', -9.5, 0),
    ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', -1, 'B1', -4.5, 0),
    ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', -1, 'B1M', -3.0, 1);
SELECT pg_temp.expect_fail('duplicate level name in venue',
    $q$INSERT INTO levels (venue_id, ordinal, name) VALUES ('10000000-0000-0000-0000-000000000001', -3, 'B2')$q$);

-- ordinal sync: nodes and anchors
INSERT INTO nodes (id, level_id, kind, geom) VALUES
    ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'escalator',
     ST_SetSRID(ST_MakePoint(103.84990, 1.29130), 4326)),
    ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'escalator',
     ST_SetSRID(ST_MakePoint(103.84995, 1.29135), 4326));
INSERT INTO nodes (id, level_id, ordinal, kind, street_name, geom) VALUES
    ('30000000-0000-0000-0000-000000000003', NULL, 7, 'exit', 'North Bridge Road',
     ST_SetSRID(ST_MakePoint(103.85060, 1.29280), 4326));
SELECT pg_temp.expect_eq('node ordinal from level',
    (SELECT ordinal::text FROM nodes WHERE id = '30000000-0000-0000-0000-000000000001'), '-2');
SELECT pg_temp.expect_eq('street node ordinal forced to 0',
    (SELECT ordinal::text FROM nodes WHERE id = '30000000-0000-0000-0000-000000000003'), '0');
INSERT INTO anchors (id, node_id, kind, name, level_id, ordinal, facing_deg)
VALUES ('80000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'floor_point',
        'Funan B2 UPL door', '20000000-0000-0000-0000-000000000001', 0, 90);
SELECT pg_temp.expect_eq('anchor ordinal from level',
    (SELECT ordinal::text FROM anchors WHERE id = '80000000-0000-0000-0000-000000000001'), '-2');
UPDATE levels SET ordinal = -3 WHERE id = '20000000-0000-0000-0000-000000000001';
SELECT pg_temp.expect_eq('level band change reaches nodes',
    (SELECT ordinal::text FROM nodes WHERE id = '30000000-0000-0000-0000-000000000001'), '-3');
SELECT pg_temp.expect_eq('level band change reaches anchors',
    (SELECT ordinal::text FROM anchors WHERE id = '80000000-0000-0000-0000-000000000001'), '-3');
INSERT INTO anchors (kind, name, ordinal, surveyed_geom, prior_source, prior_sigma_m)
VALUES ('floor_point', 'City Hall exit A', 4, ST_SetSRID(ST_MakePoint(103.85230, 1.29310), 4326), 'lta_exit', 2);
SELECT pg_temp.expect_eq('street anchor ordinal forced to 0',
    (SELECT ordinal::text FROM anchors WHERE name = 'City Hall exit A'), '0');

-- edges
SELECT pg_temp.expect_fail('step-free escalator',
    $q$INSERT INTO edges (from_node, to_node, kind, oneway, length_m, step_free, sheltered, outdoor)
       VALUES ('30000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'escalator', true, 12, true, true, false)$q$);
INSERT INTO edges (from_node, to_node, kind, oneway, connector_id, length_m, step_free, sheltered, outdoor)
VALUES ('30000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'escalator', true,
        '40000000-0000-0000-0000-000000000001', 12, false, true, false);

-- restricted zones
INSERT INTO restricted_zones (venue_id, level_id, geom, note)
VALUES ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
        ST_MakeEnvelope(103.84980, 1.29120, 103.84985, 1.29125, 4326), 'loading bay');
SELECT pg_temp.expect_fail('zone level from another venue',
  $q$INSERT INTO restricted_zones (venue_id, level_id, geom) VALUES ('10000000-0000-0000-0000-000000000002',
     '20000000-0000-0000-0000-000000000002', ST_MakeEnvelope(103.852, 1.293, 103.8521, 1.2931, 4326))$q$);
SELECT pg_temp.expect_fail('invalid zone polygon',
  $q$INSERT INTO restricted_zones (venue_id, geom) VALUES ('10000000-0000-0000-0000-000000000001',
     ST_GeomFromText('POLYGON((103.8498 1.2912, 103.8499 1.2913, 103.8499 1.2912, 103.8498 1.2913, 103.8498 1.2912))', 4326))$q$);
SELECT pg_temp.expect_fail('node inside zone',
  $q$INSERT INTO nodes (level_id, kind, geom) VALUES ('20000000-0000-0000-0000-000000000001', 'door', ST_SetSRID(ST_MakePoint(103.849825, 1.291225), 4326))$q$);
SELECT pg_temp.expect_fail('space overlapping zone',
  $q$INSERT INTO spaces (level_id, kind, geom) VALUES ('20000000-0000-0000-0000-000000000001', 'walkway', ST_MakeEnvelope(103.84979, 1.29119, 103.84986, 1.29126, 4326))$q$);
SELECT pg_temp.expect_fail('poi inside zone',
  $q$INSERT INTO pois (level_id, name, category, geom) VALUES ('20000000-0000-0000-0000-000000000001', 'x', 'other', ST_SetSRID(ST_MakePoint(103.849825, 1.291225), 4326))$q$);
INSERT INTO spaces (level_id, kind, geom) VALUES ('20000000-0000-0000-0000-000000000001', 'walkway', ST_MakeEnvelope(103.84985, 1.29120, 103.84995, 1.29125, 4326));
INSERT INTO nodes (level_id, kind, geom) VALUES ('20000000-0000-0000-0000-000000000001', 'door', ST_SetSRID(ST_MakePoint(103.84985, 1.291225), 4326));
INSERT INTO nodes (level_id, kind, geom) VALUES ('20000000-0000-0000-0000-000000000002', 'door', ST_SetSRID(ST_MakePoint(103.849825, 1.291225), 4326));
SELECT pg_temp.expect_fail('delete a level with a zone',
  $q$DELETE FROM anchors; DELETE FROM levels WHERE id = '20000000-0000-0000-0000-000000000001'$q$);
SELECT pg_temp.expect_fail('delete a venue with a zone',
  $q$DELETE FROM venues WHERE id = '10000000-0000-0000-0000-000000000001'$q$);

-- street side
INSERT INTO street_nodes VALUES (1001, ST_SetSRID(ST_MakePoint(103.85070, 1.29285), 4326));
INSERT INTO street_connectors (node_id, osm_node_id, length_m, geom)
SELECT '30000000-0000-0000-0000-000000000003', 1001, ST_Length(ST_Transform(g, 3414)), g
FROM (SELECT ST_SetSRID(ST_MakeLine(ST_MakePoint(103.85060, 1.29280), ST_MakePoint(103.85070, 1.29285)), 4326) g) s;
SELECT pg_temp.expect_eq('street connector length in SVY21 is about 12 m',
    (SELECT round(length_m)::text FROM street_connectors), '12');

-- map_head guards
SELECT pg_temp.expect_fail('delete map_head', $q$DELETE FROM map_head$q$);
SELECT pg_temp.expect_fail('truncate map_head', $q$TRUNCATE map_head$q$);
SELECT pg_temp.expect_fail('second map_head row', $q$INSERT INTO map_head (id) VALUES (true)$q$);

-- publish flow: pending -> gates -> owner_mapper -> version, in one transaction
INSERT INTO captures (id, contributor_id, status, device_model, os_version, app_version, captured_at) VALUES
    ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'ready_for_review',
     'iPhone 17 Pro Max', '26.6.1', '0.1.0', now());
INSERT INTO segment_alignments (capture_id, solve_id, tx_m, ty_m, tz_m, yaw_rad, start_residual_m, end_residual_m)
VALUES ('50000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', 29650, 31200, -9.5, 0.3, 0.2, 0.4);
BEGIN;
INSERT INTO change_sets (id, contributor_id, track, diff) VALUES
    ('70000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'structural', '[]');
INSERT INTO change_set_captures VALUES ('70000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001');
SELECT pg_temp.expect_fail('publish before gates',
  $q$UPDATE change_sets SET decision='auto_published', publish_path='owner_mapper' WHERE id='70000000-0000-0000-0000-000000000001'$q$);
INSERT INTO moderation_events (change_set_id, action) VALUES ('70000000-0000-0000-0000-000000000001', 'gates_passed');
SELECT version_id FROM map_head FOR UPDATE;
INSERT INTO map_versions (published_by, snapshot_uri, snapshot_sha256, private_export_uri)
VALUES ('00000000-0000-0000-0000-00000000000a', 'v/1', 'h1', 'p/1');
UPDATE change_sets SET decision='auto_published', publish_path='owner_mapper', map_version_id=1
WHERE id='70000000-0000-0000-0000-000000000001';
UPDATE map_head SET version_id = 1;
COMMIT;
SELECT pg_temp.expect_eq('published v1', (SELECT version_id::text FROM map_head), '1');

SELECT pg_temp.expect_fail('publish path set on insert',
  $q$INSERT INTO change_sets (contributor_id, track, diff, decision, publish_path)
     VALUES ('00000000-0000-0000-0000-00000000000a', 'structural', '[]', 'auto_published', 'owner_mapper')$q$);
SELECT pg_temp.expect_fail('orphan map version',
  $q$INSERT INTO map_versions (snapshot_uri, snapshot_sha256, private_export_uri) VALUES ('v/x', 'x', 'p/x'); SET CONSTRAINTS ALL IMMEDIATE$q$);
SELECT pg_temp.expect_fail('head moves back', $q$UPDATE map_head SET version_id = NULL$q$);
SELECT pg_temp.expect_fail('edit a published version', $q$UPDATE map_versions SET note = 'x' WHERE id = 1$q$);
SELECT pg_temp.expect_fail('delete a published version', $q$DELETE FROM map_versions WHERE id = 1$q$);
SELECT pg_temp.expect_fail('truncate map_versions', $q$TRUNCATE map_versions CASCADE$q$);
SELECT pg_temp.expect_fail('truncate moderation_events', $q$TRUNCATE moderation_events$q$);
SELECT pg_temp.expect_fail('edit an audit event', $q$UPDATE moderation_events SET action = 'reject'$q$);
SELECT pg_temp.expect_fail('delete an audit event', $q$DELETE FROM moderation_events$q$);
SELECT pg_temp.expect_fail('rewrite a published diff',
  $q$UPDATE change_sets SET diff='[{"op":"x"}]' WHERE id='70000000-0000-0000-0000-000000000001'$q$);
SELECT pg_temp.expect_fail('re-point a published change set',
  $q$UPDATE change_sets SET map_version_id = NULL, decision = 'auto_published' WHERE id='70000000-0000-0000-0000-000000000001'$q$);
SELECT pg_temp.expect_fail('delete a published change set',
  $q$DELETE FROM change_sets WHERE id='70000000-0000-0000-0000-000000000001'$q$);
SELECT pg_temp.expect_fail('changing the publish path afterwards',
  $q$UPDATE change_sets SET publish_path = 'trusted_status_auto' WHERE id = '70000000-0000-0000-0000-000000000001'$q$);
SELECT pg_temp.expect_fail('link a capture after publishing',
  $q$INSERT INTO captures (id, contributor_id, status, captured_at) VALUES ('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', 'ready_for_review', now());
     INSERT INTO change_set_captures VALUES ('70000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000002')$q$);

-- a flagged or failed capture blocks the owner path; clearing the flag unblocks it
INSERT INTO captures (id, contributor_id, status, privacy_flagged, quarantined_frames, captured_at) VALUES
    ('50000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'ready_for_review', true, '{812}', now());
INSERT INTO change_sets (id, contributor_id, track, base_version_id, diff) VALUES
    ('70000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'structural', 1, '[]');
INSERT INTO change_set_captures VALUES ('70000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000003');
INSERT INTO moderation_events (change_set_id, action) VALUES ('70000000-0000-0000-0000-000000000003', 'gates_passed');
SELECT pg_temp.expect_fail('publish with a flagged capture',
  $q$INSERT INTO map_versions (snapshot_uri, snapshot_sha256, private_export_uri) VALUES ('v/3', 'h3', 'p/3');
     UPDATE change_sets SET decision='auto_published', publish_path='owner_mapper', map_version_id=currval('map_versions_id_seq')
     WHERE id='70000000-0000-0000-0000-000000000003'$q$);
INSERT INTO moderation_events (change_set_id, actor_id, action) VALUES
    ('70000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'gates_failed');
UPDATE captures SET privacy_flagged = false WHERE id = '50000000-0000-0000-0000-000000000003';
INSERT INTO moderation_events (change_set_id, actor_id, action) VALUES
    ('70000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', 'privacy_flag_cleared');
SELECT pg_temp.expect_fail('publish after a later gates_failed',
  $q$INSERT INTO map_versions (snapshot_uri, snapshot_sha256, private_export_uri) VALUES ('v/3', 'h3', 'p/3');
     UPDATE change_sets SET decision='auto_published', publish_path='owner_mapper', map_version_id=currval('map_versions_id_seq')
     WHERE id='70000000-0000-0000-0000-000000000003'$q$);
INSERT INTO moderation_events (change_set_id, action) VALUES ('70000000-0000-0000-0000-000000000003', 'gates_passed');
BEGIN;
INSERT INTO map_versions (snapshot_uri, snapshot_sha256, private_export_uri) VALUES ('v/3', 'h3', 'p/3');
UPDATE change_sets SET decision='auto_published', publish_path='owner_mapper', map_version_id=currval('map_versions_id_seq')
WHERE id='70000000-0000-0000-0000-000000000003';
UPDATE map_head SET version_id = currval('map_versions_id_seq');
COMMIT;
SELECT pg_temp.expect_eq('flag cleared, then published', (SELECT decision::text FROM change_sets WHERE id='70000000-0000-0000-0000-000000000003'), 'auto_published');

-- publish-path eligibility (all after gates_passed)
INSERT INTO change_sets (id, contributor_id, track, diff) VALUES
    ('70000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-00000000000d', 'structural', '[]'),
    ('70000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-00000000000b', 'structural', '[]'),
    ('70000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-00000000000c', 'structural', '[]'),
    ('70000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-00000000000d', 'status', '[]'),
    ('70000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-00000000000a', 'status', '[]');
INSERT INTO moderation_events (change_set_id, action)
SELECT id, 'gates_passed' FROM change_sets WHERE decision = 'pending';
SELECT pg_temp.expect_fail('owner_mapper by a new contributor',
  $q$UPDATE change_sets SET decision='auto_published', publish_path='owner_mapper', map_version_id=1 WHERE id='70000000-0000-0000-0000-000000000010'$q$);
SELECT pg_temp.expect_fail('owner_mapper by a moderator',
  $q$UPDATE change_sets SET decision='auto_published', publish_path='owner_mapper', map_version_id=1 WHERE id='70000000-0000-0000-0000-000000000011'$q$);
SELECT pg_temp.expect_fail('owner_mapper on a status change set',
  $q$UPDATE change_sets SET decision='auto_published', publish_path='owner_mapper' WHERE id='70000000-0000-0000-0000-000000000014'$q$);
SELECT pg_temp.expect_fail('trusted_status_auto on a structural change',
  $q$UPDATE change_sets SET decision='auto_published', publish_path='trusted_status_auto', map_version_id=1 WHERE id='70000000-0000-0000-0000-000000000012'$q$);
SELECT pg_temp.expect_fail('trusted_status_auto by a new contributor',
  $q$UPDATE change_sets SET decision='auto_published', publish_path='trusted_status_auto' WHERE id='70000000-0000-0000-0000-000000000013'$q$);
SELECT pg_temp.expect_fail('moderator reviewing their own change',
  $q$UPDATE change_sets SET decision='approved', publish_path='moderator_review', reviewer_id='00000000-0000-0000-0000-00000000000b', map_version_id=1 WHERE id='70000000-0000-0000-0000-000000000011'$q$);
SELECT pg_temp.expect_fail('trusted contributor as reviewer',
  $q$UPDATE change_sets SET decision='approved', publish_path='moderator_review', reviewer_id='00000000-0000-0000-0000-00000000000c', map_version_id=1 WHERE id='70000000-0000-0000-0000-000000000010'$q$);
SELECT pg_temp.expect_fail('moderator_review without a reviewer',
  $q$UPDATE change_sets SET decision='approved', publish_path='moderator_review', map_version_id=1 WHERE id='70000000-0000-0000-0000-000000000010'$q$);
SELECT pg_temp.expect_fail('approved structural without a version',
  $q$UPDATE change_sets SET decision='approved', publish_path='moderator_review', reviewer_id='00000000-0000-0000-0000-00000000000b' WHERE id='70000000-0000-0000-0000-000000000010'$q$);
SELECT pg_temp.expect_fail('approved without a publish path',
  $q$UPDATE change_sets SET decision='approved' WHERE id='70000000-0000-0000-0000-000000000010'$q$);
SELECT pg_temp.expect_fail('pending with a version',
  $q$UPDATE change_sets SET map_version_id=1 WHERE id='70000000-0000-0000-0000-000000000010'$q$);
BEGIN;
INSERT INTO map_versions (snapshot_uri, snapshot_sha256, private_export_uri) VALUES ('v/4', 'h4', 'p/4');
UPDATE change_sets SET decision='approved', publish_path='moderator_review', reviewer_id='00000000-0000-0000-0000-00000000000b',
       reviewed_at=now(), map_version_id=currval('map_versions_id_seq')
WHERE id='70000000-0000-0000-0000-000000000010';
UPDATE map_head SET version_id = currval('map_versions_id_seq');
COMMIT;
-- reviewer demoted later; rolling the change set back still works, and rolled_back is final
UPDATE contributors SET trust_tier = 'new' WHERE id = '00000000-0000-0000-0000-00000000000b';
UPDATE change_sets SET decision = 'rolled_back' WHERE id = '70000000-0000-0000-0000-000000000010';
SELECT pg_temp.expect_fail('rolled_back flipped back to approved',
  $q$UPDATE change_sets SET decision = 'approved' WHERE id = '70000000-0000-0000-0000-000000000010'$q$);
UPDATE contributors SET trust_tier = 'moderator' WHERE id = '00000000-0000-0000-0000-00000000000b';
UPDATE change_sets SET decision = 'rejected' WHERE id = '70000000-0000-0000-0000-000000000012';
SELECT pg_temp.expect_fail('rejected flipped to pending',
  $q$UPDATE change_sets SET decision = 'pending' WHERE id = '70000000-0000-0000-0000-000000000012'$q$);

-- status track
SELECT pg_temp.expect_fail('status change set with a structural diff',
  $q$INSERT INTO change_sets (contributor_id, track, diff) VALUES ('00000000-0000-0000-0000-00000000000c', 'status', '[{"op":"update"}]')$q$);
SELECT pg_temp.expect_fail('status report on a structural change set',
  $q$INSERT INTO status_reports (feature_type, feature_id, is_open, valid_from, change_set_id)
     VALUES ('node', '30000000-0000-0000-0000-000000000003', false, now(), '70000000-0000-0000-0000-000000000011')$q$);
SELECT pg_temp.expect_fail('status report on a space',
  $q$INSERT INTO status_reports (feature_type, feature_id, is_open, valid_from, change_set_id)
     VALUES ('space', gen_random_uuid(), false, now(), '70000000-0000-0000-0000-000000000014')$q$);
SELECT pg_temp.expect_fail('status report ending before it starts',
  $q$INSERT INTO status_reports (feature_type, feature_id, is_open, valid_from, valid_until, change_set_id)
     VALUES ('node', gen_random_uuid(), false, now(), now() - interval '1 hour', '70000000-0000-0000-0000-000000000014')$q$);
INSERT INTO change_sets (id, contributor_id, track, diff) VALUES
    ('70000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000c', 'status', '[]');
INSERT INTO status_reports (feature_type, feature_id, is_open, valid_from, change_set_id)
VALUES ('node', '30000000-0000-0000-0000-000000000003', false, now(), '70000000-0000-0000-0000-000000000002');
INSERT INTO moderation_events (change_set_id, action) VALUES ('70000000-0000-0000-0000-000000000002', 'gates_passed');
SELECT pg_temp.expect_fail('trusted report with no end time',
  $q$UPDATE change_sets SET decision='auto_published', publish_path='trusted_status_auto' WHERE id='70000000-0000-0000-0000-000000000002'$q$);
UPDATE status_reports SET valid_until = now() + interval '4 hours' WHERE change_set_id = '70000000-0000-0000-0000-000000000002';
UPDATE change_sets SET decision='auto_published', publish_path='trusted_status_auto' WHERE id='70000000-0000-0000-0000-000000000002';
SELECT pg_temp.expect_fail('status change set with a map version',
  $q$UPDATE change_sets SET map_version_id = 1 WHERE id = '70000000-0000-0000-0000-000000000002'$q$);
SELECT pg_temp.expect_fail('edit a published status report', $q$UPDATE status_reports SET is_open = true$q$);
SELECT pg_temp.expect_fail('add a report to a published change set',
  $q$INSERT INTO status_reports (feature_type, feature_id, is_open, valid_from, valid_until, change_set_id)
     VALUES ('node', gen_random_uuid(), false, now(), now() + interval '1 hour', '70000000-0000-0000-0000-000000000002')$q$);
-- the owner's own status edit goes through trusted_status_auto
INSERT INTO status_reports (feature_type, feature_id, is_open, valid_from, valid_until, change_set_id)
VALUES ('edge', gen_random_uuid(), false, now(), now() + interval '1 hour', '70000000-0000-0000-0000-000000000014');
UPDATE change_sets SET decision='auto_published', publish_path='trusted_status_auto' WHERE id='70000000-0000-0000-0000-000000000014';

-- a rollback version needs no change set
BEGIN;
INSERT INTO map_versions (snapshot_uri, snapshot_sha256, private_export_uri, restores) VALUES ('v/r', 'hr', 'p/r', 1);
UPDATE map_head SET version_id = currval('map_versions_id_seq');
COMMIT;

-- an unpublished change set with no audit events can still be deleted, with its capture links
INSERT INTO change_sets (id, contributor_id, track, diff) VALUES
    ('70000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-00000000000a', 'structural', '[]');
INSERT INTO change_set_captures VALUES ('70000000-0000-0000-0000-000000000020', '50000000-0000-0000-0000-000000000001');
DELETE FROM change_sets WHERE id = '70000000-0000-0000-0000-000000000020';
SELECT pg_temp.expect_eq('capture links cascade with an unpublished change set',
    (SELECT count(*)::text FROM change_set_captures WHERE change_set_id = '70000000-0000-0000-0000-000000000020'), '0');

SELECT 'ALL SCHEMA TESTS PASSED' AS result;
