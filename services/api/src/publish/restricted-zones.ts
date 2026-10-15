// HEAD against the restricted zones, as the publish transaction sees it (CLAUDE.md, "Public walkways
// only"). The database's trigger refuses a space, node, edge or POI whose own geometry overlaps the
// interior of a zone on its level, but it can't see the rest: an edge with no stored line (drawn
// straight between its nodes), an edge without a level (drawn on the levels of both its ends), a
// line redrawn because a node it ends on moved, a zone added after the features, or a street
// connector. This checks HEAD as the public files will draw it, against the zones as they are now:
//
// - spaces and POIs, and nodes that have a level, against the zones of their level;
// - every edge as drawn (lineFromTo: its stored line with its ends on its nodes, or a straight
//   line), against its level's zones, or those of both its ends' levels when it has none;
// - with `connectors`, every street connector of a node that has a level, as drawn.
//
// Zones of a level are the zones on it and the venue-wide ones (level_id NULL) of its venue. Sharing
// a zone's edge is fine; only the interior counts (ST_Relate 'T********'). Results name features and
// zones by id, never an outline (docs/decisions/0005).

import { type Kysely, sql } from "kysely";
import type { Database } from "../database.ts";
import { lineFromTo } from "./snapshot.ts";

/** One feature overlapping one zone on one level. */
export interface Overlap {
  /** "space <id>", "edge <id>", "street connector of node <id>", ... */
  readonly feature: string;
  readonly level_id: string;
  readonly zone_id: string;
}

/** How an overlap is told: ids only. */
export function describeOverlap(overlap: Overlap): string {
  return `${overlap.feature} overlaps restricted zone ${overlap.zone_id} on level ${overlap.level_id}`;
}

/** A stable key for comparing overlaps before and after a change. */
export const overlapKey = (o: Overlap) => `${o.feature}|${o.level_id}|${o.zone_id}`;

/**
 * Every feature of HEAD that overlaps the interior of a restricted zone, as set out above, sorted.
 * Empty when HEAD is clear. Reads what `db` sees: inside the publish transaction, HEAD as it has
 * applied it so far.
 */
export async function headOverlaps(
  db: Kysely<Database>,
  options: { readonly connectors: boolean },
): Promise<Overlap[]> {
  const connectors = options.connectors
    ? sql`UNION ALL
      SELECT 'street connector of node ' || c.node_id, n.level_id,
             ${lineFromTo("c.geom", "n.geom", "s.geom")}
        FROM street_connectors c
        JOIN nodes n ON n.id = c.node_id
        JOIN street_nodes s ON s.osm_node_id = c.osm_node_id
       WHERE n.level_id IS NOT NULL`
    : sql``;
  const result = await sql<Overlap>`
    WITH features (feature, level_id, geom) AS (
      SELECT 'space ' || s.id, s.level_id, s.geom FROM spaces s
      UNION ALL
      SELECT 'poi ' || p.id, p.level_id, p.geom FROM pois p
      UNION ALL
      SELECT 'node ' || n.id, n.level_id, n.geom FROM nodes n WHERE n.level_id IS NOT NULL
      UNION ALL
      SELECT 'edge ' || e.id, lv.level_id, ${lineFromTo("e.geom", "f.geom", "t.geom")}
        FROM edges e
        JOIN nodes f ON f.id = e.from_node
        JOIN nodes t ON t.id = e.to_node
        CROSS JOIN LATERAL (
          SELECT DISTINCT l
            FROM unnest(CASE WHEN e.level_id IS NOT NULL THEN ARRAY[e.level_id]
                             ELSE ARRAY[f.level_id, t.level_id] END) AS l
           WHERE l IS NOT NULL
        ) AS lv (level_id)
      ${connectors}
    )
    SELECT DISTINCT f.feature, f.level_id::text AS level_id, rz.id::text AS zone_id
      FROM features f
      JOIN levels l ON l.id = f.level_id
      JOIN restricted_zones rz
        ON rz.venue_id = l.venue_id AND (rz.level_id IS NULL OR rz.level_id = f.level_id)
     WHERE rz.geom && f.geom AND ST_Relate(f.geom, rz.geom, 'T********')
     ORDER BY 1, 2, 3`.execute(db);
  return result.rows;
}
