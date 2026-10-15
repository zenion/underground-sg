-- A venue's level names stay unique, but the publish may check that once a whole change set is in.
--
-- A change set that swaps two levels' names (correcting a B1/B2 mix-up) is valid, yet its first
-- UPDATE broke the immediate UNIQUE (venue_id, name), and the publish could never apply it. The
-- constraint is now DEFERRABLE INITIALLY IMMEDIATE: every other writer (the seed script, the tests)
-- is checked statement by statement as before, and the publish transaction defers it while one
-- change set's entries go in, then sets it IMMEDIATE again, which checks those rows there
-- (services/api/src/publish/apply.ts). Same name, same columns: only when it is checked changes.
--
-- The restricted-zone trigger (reject_restricted_overlap) still checks only rows with a level and
-- a geometry of their own. The rest (an edge with no stored line, drawn straight between its
-- nodes; an edge without a level, drawn on the levels of both its ends; lines redrawn because a
-- node moved; zones drawn after the features; street connectors) the publish checks against HEAD
-- as the public files draw it (services/api/src/publish/restricted-zones.ts).

-- migrate:up

ALTER TABLE levels DROP CONSTRAINT levels_venue_id_name_key;
ALTER TABLE levels ADD CONSTRAINT levels_venue_id_name_key UNIQUE (venue_id, name)
    DEFERRABLE INITIALLY IMMEDIATE;

-- migrate:down

ALTER TABLE levels DROP CONSTRAINT levels_venue_id_name_key;
ALTER TABLE levels ADD CONSTRAINT levels_venue_id_name_key UNIQUE (venue_id, name);
