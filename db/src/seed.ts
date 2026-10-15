// The seed script's mechanism (docs/backlog.md, "Seed script"; docs/decisions/0004): venues and
// their pedestrian-network levels, written straight into HEAD by the owner. Their rows reach the
// public files only inside a version that publishes a change set (CLAUDE.md, moderation rules).
//
// - A row the dataset lists and HEAD lacks is inserted. Once a row exists, a re-run writes only
//   venues.permission, which no diff carries (so it bumps no rev): every other column changes only
//   through change sets, so a re-run never undoes an approved change such as a measured
//   elevation_m or a renamed level. Where HEAD differs from the dataset, the report says so.
// - Venues and levels go only when the dataset names them under `remove`, and only when no other
//   HEAD row references them (and no restricted zone is drawn on them): the database's cascades
//   would otherwise change HEAD without a change set. Anything else refuses the whole run.
// - One transaction, holding map_head FOR UPDATE, so a seed never interleaves with a publish.
// - Running it twice changes nothing.
// - It refuses a database that holds the demo map (src/demo.ts), unless it is loading the demo's
//   own dataset: real venues never go in beside demo data.

import { DEMO_PRESENT_MESSAGE, holdsDemo } from "./demo.ts";

/** What the seed needs from a connection: node-postgres's Client and PoolClient both fit. */
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

export type VenueKind = "mall" | "mrt_station" | "link" | "office" | "hotel" | "other";

/** A GeoJSON MultiPolygon in WGS84, [longitude, latitude]. */
export interface MultiPolygon {
  readonly type: "MultiPolygon";
  readonly coordinates: readonly (readonly (readonly (readonly [number, number])[])[])[];
}

export interface SeedLevel {
  readonly id: string;
  /** As the venue signs it, for example "B2". */
  readonly name: string;
  /** The level switcher's display band: 0 street, -1 the first basement band, and so on. */
  readonly ordinal: number;
  /** Orders levels of one venue that share a band. */
  readonly sort_key: number;
}

export interface SeedVenue {
  readonly id: string;
  readonly name: string;
  readonly kind: VenueKind;
  /** The landlord or station operator, or null. Private. */
  readonly operator: string | null;
  /** A reference to the written permission to scan (never the letter itself), or null. Private. */
  readonly permission: string | null;
  readonly footprint: MultiPolygon | null;
  /** elevation_m stays NULL until measured, through a change set. */
  readonly levels: readonly SeedLevel[];
}

export interface SeedDataset {
  /** For messages: what the dataset is. */
  readonly name: string;
  readonly venues: readonly SeedVenue[];
  /** Venues and levels to remove from HEAD, by id, once nothing references them. */
  readonly remove?: { readonly venues?: readonly string[]; readonly levels?: readonly string[] };
}

export interface SeedReport {
  readonly insertedVenues: readonly string[];
  readonly insertedLevels: readonly string[];
  /** Venues whose permission the run changed. */
  readonly permissionUpdated: readonly string[];
  readonly removedVenues: readonly string[];
  readonly removedLevels: readonly string[];
  /**
   * Where HEAD differs from the dataset, left as HEAD has it: changed through a change set, or
   * the dataset was edited after the row was created.
   */
  readonly differences: readonly string[];
}

/** The dataset is malformed, or HEAD refuses it; nothing was written. */
export class SeedError extends Error {
  override name = "SeedError";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VENUE_KINDS: readonly VenueKind[] = [
  "mall",
  "mrt_station",
  "link",
  "office",
  "hotel",
  "other",
];

/** Problems with the dataset itself, before it touches the database. */
export function checkDataset(dataset: SeedDataset): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const unique = (id: string, what: string) => {
    if (!UUID.test(id)) problems.push(`${what}: id ${JSON.stringify(id)} is not a lowercase UUID`);
    if (ids.has(id)) problems.push(`${what}: id ${id} is used twice`);
    ids.add(id);
  };
  const text = (value: string, what: string) => {
    if (value.trim() !== value || value.length < 1 || value.length > 200) {
      problems.push(`${what} must be 1 to 200 characters with no space at either end`);
    }
  };
  for (const venue of dataset.venues) {
    const at = `venue ${venue.id}`;
    unique(venue.id, at);
    text(venue.name, `${at}: name`);
    if (!VENUE_KINDS.includes(venue.kind))
      problems.push(`${at}: kind ${venue.kind} is not a venue_kind`);
    if (venue.operator !== null) text(venue.operator, `${at}: operator`);
    if (
      venue.permission !== null &&
      (venue.permission.length < 1 || venue.permission.length > 1000)
    ) {
      problems.push(`${at}: permission must be 1 to 1000 characters, or null`);
    }
    if (venue.footprint !== null && venue.footprint.type !== "MultiPolygon") {
      problems.push(`${at}: footprint must be a MultiPolygon or null`);
    }
    const names = new Set<string>();
    for (const level of venue.levels) {
      const atLevel = `${at}, level ${level.id}`;
      unique(level.id, atLevel);
      text(level.name, `${atLevel}: name`);
      if (names.has(level.name)) problems.push(`${atLevel}: name ${level.name} is used twice`);
      names.add(level.name);
      for (const [field, value] of [
        ["ordinal", level.ordinal],
        ["sort_key", level.sort_key],
      ] as const) {
        if (!Number.isInteger(value) || value < -32_768 || value > 32_767) {
          problems.push(`${atLevel}: ${field} must be a smallint`);
        }
      }
    }
  }
  for (const id of [...(dataset.remove?.venues ?? []), ...(dataset.remove?.levels ?? [])]) {
    if (!UUID.test(id)) problems.push(`remove: ${JSON.stringify(id)} is not a lowercase UUID`);
    if (ids.has(id)) problems.push(`remove: ${id} is also listed to keep`);
  }
  return problems;
}

export interface SeedOptions {
  /** The dataset is the demo map's (`pnpm demo`): allowed on a database that holds the demo. */
  readonly demo?: boolean;
}

/**
 * Loads a dataset into HEAD, as set out above, in one transaction on `client` (which must not be
 * in one already). Throws SeedError, having written nothing, when the dataset is malformed, HEAD
 * refuses it, or the database holds the demo map and the dataset isn't the demo's.
 */
export async function seed(
  client: Queryable,
  dataset: SeedDataset,
  options: SeedOptions = {},
): Promise<SeedReport> {
  const problems = checkDataset(dataset);
  if (problems.length > 0) {
    throw new SeedError(`${dataset.name}: ${problems.join("; ")}`);
  }
  await client.query("BEGIN");
  try {
    const report = await seedInTransaction(client, dataset, options);
    await client.query("COMMIT");
    return report;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function seedInTransaction(
  client: Queryable,
  dataset: SeedDataset,
  options: SeedOptions,
): Promise<SeedReport> {
  await client.query("SELECT version_id FROM map_head FOR UPDATE");
  if (options.demo !== true && (await holdsDemo(client))) {
    throw new SeedError(`${dataset.name}: ${DEMO_PRESENT_MESSAGE}`);
  }
  const report = {
    insertedVenues: [] as string[],
    insertedLevels: [] as string[],
    permissionUpdated: [] as string[],
    removedVenues: [] as string[],
    removedLevels: [] as string[],
    differences: [] as string[],
  };

  for (const venue of dataset.venues) {
    const footprint = venue.footprint === null ? null : JSON.stringify(venue.footprint);
    const existing = (
      await client.query<{
        name: string;
        kind: string;
        operator: string | null;
        permission: string | null;
        same_footprint: boolean;
      }>(
        `SELECT name, kind::text AS kind, operator, permission,
                footprint IS NOT DISTINCT FROM
                  ST_SetSRID(ST_GeomFromGeoJSON($2::text), 4326) AS same_footprint
           FROM venues WHERE id = $1`,
        [venue.id, footprint],
      )
    ).rows[0];
    if (existing === undefined) {
      await client.query(
        `INSERT INTO venues (id, name, kind, operator, permission, footprint)
         VALUES ($1, $2, $3, $4, $5, ST_SetSRID(ST_GeomFromGeoJSON($6::text), 4326))`,
        [venue.id, venue.name, venue.kind, venue.operator, venue.permission, footprint],
      );
      report.insertedVenues.push(venue.id);
    } else {
      if (existing.permission !== venue.permission) {
        // The one column a re-run writes. Not in any diff, so no rev bump.
        await client.query("UPDATE venues SET permission = $2, updated_at = now() WHERE id = $1", [
          venue.id,
          venue.permission,
        ]);
        report.permissionUpdated.push(venue.id);
      }
      const differs = [
        existing.name !== venue.name && "name",
        existing.kind !== venue.kind && "kind",
        existing.operator !== venue.operator && "operator",
        !existing.same_footprint && "footprint",
      ].filter((column): column is string => column !== false);
      if (differs.length > 0) {
        report.differences.push(
          `venue ${venue.id}: HEAD's ${differs.join(", ")} differ; left as HEAD has them`,
        );
      }
    }

    for (const level of venue.levels) {
      const current = (
        await client.query<{ venue_id: string; name: string; ordinal: number; sort_key: number }>(
          "SELECT venue_id, name, ordinal, sort_key FROM levels WHERE id = $1",
          [level.id],
        )
      ).rows[0];
      if (current === undefined) {
        const clash = (
          await client.query<{ id: string }>(
            "SELECT id FROM levels WHERE venue_id = $1 AND name = $2",
            [venue.id, level.name],
          )
        ).rows[0];
        if (clash !== undefined) {
          throw new SeedError(
            `${dataset.name}: level ${level.id}: venue ${venue.id} already has a level named ${level.name} (${clash.id})`,
          );
        }
        await client.query(
          `INSERT INTO levels (id, venue_id, ordinal, name, sort_key) VALUES ($1, $2, $3, $4, $5)`,
          [level.id, venue.id, level.ordinal, level.name, level.sort_key],
        );
        report.insertedLevels.push(level.id);
        continue;
      }
      const differs = [
        current.venue_id !== venue.id && "venue_id",
        current.name !== level.name && "name",
        current.ordinal !== level.ordinal && "ordinal",
        current.sort_key !== level.sort_key && "sort_key",
      ].filter((column): column is string => column !== false);
      if (differs.length > 0) {
        report.differences.push(
          `level ${level.id}: HEAD's ${differs.join(", ")} differ; left as HEAD has them`,
        );
      }
    }
  }

  for (const id of dataset.remove?.levels ?? []) {
    const references = await levelReferences(client, id);
    if (references === undefined) continue;
    if (references.length > 0) {
      throw new SeedError(
        `${dataset.name}: level ${id} can't be removed while HEAD has ${references.join(", ")} on it`,
      );
    }
    await client.query("DELETE FROM levels WHERE id = $1", [id]);
    report.removedLevels.push(id);
  }
  for (const id of dataset.remove?.venues ?? []) {
    const counts = (
      await client.query<{ present: boolean; levels: number; zones: number }>(
        `SELECT EXISTS (SELECT 1 FROM venues WHERE id = $1) AS present,
                (SELECT count(*)::int FROM levels WHERE venue_id = $1) AS levels,
                (SELECT count(*)::int FROM restricted_zones WHERE venue_id = $1) AS zones`,
        [id],
      )
    ).rows[0];
    if (counts === undefined || !counts.present) continue;
    if (counts.levels > 0 || counts.zones > 0) {
      throw new SeedError(
        `${dataset.name}: venue ${id} can't be removed while it has ${counts.levels} levels and ${counts.zones} restricted zones`,
      );
    }
    await client.query("DELETE FROM venues WHERE id = $1", [id]);
    report.removedVenues.push(id);
  }
  return report;
}

/** What references a level ("3 nodes", ...), or undefined when HEAD has no such level. */
async function levelReferences(client: Queryable, id: string): Promise<string[] | undefined> {
  const row = (
    await client.query<Record<string, number | boolean>>(
      `SELECT EXISTS (SELECT 1 FROM levels WHERE id = $1) AS present,
              (SELECT count(*)::int FROM spaces WHERE level_id = $1) AS spaces,
              (SELECT count(*)::int FROM nodes WHERE level_id = $1) AS nodes,
              (SELECT count(*)::int FROM edges WHERE level_id = $1) AS edges,
              (SELECT count(*)::int FROM pois WHERE level_id = $1) AS pois,
              (SELECT count(*)::int FROM anchors WHERE level_id = $1) AS anchors,
              (SELECT count(*)::int FROM restricted_zones WHERE level_id = $1) AS restricted_zones`,
      [id],
    )
  ).rows[0];
  if (row === undefined || row["present"] !== true) return undefined;
  return Object.entries(row)
    .filter(([name, count]) => name !== "present" && typeof count === "number" && count > 0)
    .map(([name, count]) => `${count} ${name.replace("_", " ")}`);
}
