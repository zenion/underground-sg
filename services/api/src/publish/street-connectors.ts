// Street connectors: each exit and entrance joined to its nearest street vertex, measured in SVY21
// (docs/decisions/0003-routing.md). Derived, not HEAD: the publish transaction rebuilds them before
// it builds the snapshot (docs/decisions/0004, step 4), so they always match the street graph they
// are published with. Keyed by node_id; indoor.json derives each connector's id from it.

import { type Kysely, sql } from "kysely";
import type { Database } from "../database.ts";

/**
 * Nearest candidates taken from the 4326 index before ranking by SVY21 distance. At Singapore's
 * latitude a degree of longitude and one of latitude differ in length by under 0.03%, so the
 * nearest vertex in metres is always among the nearest few in degrees.
 */
const CANDIDATES = 16;

/**
 * The longest connector, in metres (SVY21). An exit or entrance with no street node this close
 * gets no connector, rather than a line drawn through buildings to a far-away vertex, as when the
 * street graph near it is missing. Generous, because the graph's vertices along a sidewalk can be
 * tens of metres apart: it guards against a missing street graph, not against imprecision. A
 * tuning value (docs/snapshot-format.md).
 */
export const STREET_CONNECTOR_MAX_LENGTH_M = 100;

/**
 * Replaces every street connector: one per exit or entrance node, to the nearest street node by
 * SVY21 distance (ties go to the lowest OSM node id), with a straight line from the node to the
 * street node and its length in metres. A node gets none when no street node is within
 * STREET_CONNECTOR_MAX_LENGTH_M. Runs in the caller's transaction, or in one of its own. Returns
 * how many connectors it wrote.
 */
export async function rebuildStreetConnectors(db: Kysely<Database>): Promise<number> {
  if (!db.isTransaction) {
    return db.transaction().execute((trx) => rebuildStreetConnectors(trx));
  }
  await sql`DELETE FROM street_connectors`.execute(db);
  const result = await sql`
    INSERT INTO street_connectors (node_id, osm_node_id, length_m, geom)
    SELECT n.id, nearest.osm_node_id,
           ST_Length(ST_Transform(ST_MakeLine(n.geom, nearest.geom), 3414)),
           ST_MakeLine(n.geom, nearest.geom)
      FROM nodes n
      CROSS JOIN LATERAL (
        SELECT c.osm_node_id, c.geom
          FROM (SELECT s.osm_node_id, s.geom
                  FROM street_nodes s
                 ORDER BY s.geom <-> n.geom
                 LIMIT ${sql.lit(CANDIDATES)}) c
         WHERE ST_DWithin(ST_Transform(c.geom, 3414), ST_Transform(n.geom, 3414),
                          ${sql.lit(STREET_CONNECTOR_MAX_LENGTH_M)})
         ORDER BY ST_Distance(ST_Transform(c.geom, 3414), ST_Transform(n.geom, 3414)),
                  c.osm_node_id
         LIMIT 1
      ) nearest
     WHERE n.kind IN ('exit', 'entrance')`.execute(db);
  return Number(result.numAffectedRows ?? 0n);
}
