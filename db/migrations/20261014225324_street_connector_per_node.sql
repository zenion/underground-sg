-- One street connector per exit or entrance, keyed by its node.
--
-- The publish transaction rebuilds street_connectors for every exit and entrance, joining each
-- to its nearest street vertex. The random id each rebuilt row got was published in indoor.json,
-- so the same HEAD and street graph gave different bytes, and a new content-addressed directory,
-- on every publish (docs/snapshot-format.md, "Content addressing"). A connector is now keyed by
-- its node: node_id is the primary key, so an exit or entrance has at most one connector, and
-- indoor.json identifies the connector by a UUIDv5 of node_id (streetConnectorId in
-- @usg/contracts/validators), which stays the same from version to version.

-- migrate:up

ALTER TABLE street_connectors DROP COLUMN id;
-- The primary key's index replaces it.
DROP INDEX street_connectors_node_idx;
ALTER TABLE street_connectors ADD PRIMARY KEY (node_id);

-- migrate:down

ALTER TABLE street_connectors DROP CONSTRAINT street_connectors_pkey;
CREATE INDEX street_connectors_node_idx ON street_connectors (node_id);
ALTER TABLE street_connectors ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE street_connectors ADD PRIMARY KEY (id);
