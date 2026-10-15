// Applying a structural change set's diff to HEAD (docs/diff-format.md, "Approval", steps 2 and 3).
// Runs inside the publish transaction, after it has locked map_head: first the rebase check, which
// sends the change set to needs_rebase and applies nothing if HEAD has moved on since the diff was
// made; then the entries, parents first and removes last, each bumping the row's rev.
//
// The entries go in under a savepoint. If the database refuses one (a unique, foreign-key or check
// constraint), or HEAD would then have a feature overlapping a restricted zone that didn't before
// (src/publish/restricted-zones.ts: the zones as they are now, and lines as drawn, which the
// database's trigger can't see), the change set is rolled back to the savepoint and goes to
// needs_rebase with the reason; the other change sets of the publish carry on. Levels' unique name
// per venue is checked once the whole change set is in, so a diff can swap two levels' names.
//
// - Geometry goes in through ST_GeomFromGeoJSON (CLAUDE.md, docs/decisions/0006).
// - venues.permission is never written: no diff carries it (the seed script owns it).
// - `ordinal` on nodes and anchors is the levels' trigger's to set; the diff's level rows carry it.

import {
  type AnchorRow,
  type ChangeSetDiff,
  DIFF_FEATURE_TYPES,
  DIFF_ROW_REFERENCES,
  type DiffEntry,
  type DiffFeatureType,
  type EdgeRow,
  type LevelRow,
  type NodeRow,
  type PoiRow,
  type SpaceRow,
  type VenueRow,
} from "@usg/contracts";
import { validateChangeSetDiff } from "@usg/contracts/validators";
import { type Kysely, type RawBuilder, sql } from "kysely";
import type { ChangeTrack, Database } from "../database.ts";
import { describeOverlap, headOverlaps, overlapKey } from "./restricted-zones.ts";

/** The HEAD table of each feature type a diff may touch. */
export const FEATURE_TABLES = {
  venue: "venues",
  level: "levels",
  space: "spaces",
  node: "nodes",
  edge: "edges",
  poi: "pois",
  anchor: "anchors",
} as const satisfies Record<DiffFeatureType, keyof Database>;

/** A change set as the publish transaction reads it. */
export interface ChangeSetToApply {
  readonly id: string;
  readonly track: ChangeTrack;
  readonly base_version_id: number | null;
  /** change_sets.diff, parsed (node-postgres parses jsonb). */
  readonly diff: unknown;
}

export interface AppliedCounts {
  readonly added: number;
  readonly modified: number;
  readonly removed: number;
}

export type ApplyOutcome =
  | { readonly decision: "applied"; readonly counts: AppliedCounts }
  | { readonly decision: "needs_rebase"; readonly reasons: readonly string[] };

/** HEAD changed under an entry after the rebase check passed: a bug, or a writer that took no lock. */
export class ApplyConflictError extends Error {
  override name = "ApplyConflictError";
}

/** The database refused an entry: one of its constraints or triggers. */
export class EntryRefusedError extends Error {
  override name = "EntryRefusedError";
  readonly reason: string;

  constructor(reason: string, options?: ErrorOptions) {
    super(reason, options);
    this.reason = reason;
  }
}

/** The unique constraint on levels (venue_id, name), deferred while a change set goes in. */
const LEVEL_NAME_CONSTRAINT = "levels_venue_id_name_key";

/**
 * An integrity constraint violation (SQLSTATE class 23: unique, foreign key, check, not null,
 * restrict) from node-postgres: its message, which names the constraint or the trigger's reason.
 * Undefined for any other error.
 */
function integrityViolation(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code !== "string" || !code.startsWith("23")) return undefined;
  return typeof message === "string" ? message : code;
}

/** At most this many reasons are listed; the rest are counted. */
const MAX_REASONS = 50;

function capped(reasons: string[]): string[] {
  if (reasons.length <= MAX_REASONS) return reasons;
  return [...reasons.slice(0, MAX_REASONS), `and ${reasons.length - MAX_REASONS} more`];
}

const key = (type: DiffFeatureType, id: string) => `${type}:${id}`;

function requireTransaction(db: Kysely<Database>, what: string): void {
  if (!db.isTransaction) {
    throw new Error(`${what} runs inside the publish transaction, after it has locked map_head`);
  }
}

/**
 * The rebase check (docs/diff-format.md, "Approval", step 2): why the change set can't be applied
 * to HEAD as it stands, or an empty list when it can. Run it under the map_head lock, against HEAD
 * as the earlier change sets of the same publish have left it.
 */
export async function rebaseReasons(
  db: Kysely<Database>,
  changeSet: ChangeSetToApply,
): Promise<string[]> {
  requireTransaction(db, "The rebase check");
  const reasons: string[] = [];

  // A rollback undid its base version: after the restored version and before the rollback.
  const base = changeSet.base_version_id;
  if (base !== null) {
    const rollback = await db
      .selectFrom("map_versions")
      .select(["id", "restores"])
      .where("restores", "is not", null)
      .where("restores", "<", base)
      .where("id", ">", base)
      .orderBy("id")
      .executeTakeFirst();
    if (rollback !== undefined) {
      reasons.push(
        `version ${rollback.id} rolled back to version ${rollback.restores}, undoing the base version ${base}`,
      );
    }
  }

  // The diff must still validate: a migration may have added a column since it was made.
  const validation = validateChangeSetDiff(changeSet.diff, changeSet.track);
  if (!validation.valid) {
    reasons.push(
      ...validation.problems.map((problem) => `the diff no longer validates: ${problem}`),
    );
    return capped(reasons);
  }
  const diff = changeSet.diff as ChangeSetDiff;

  const entries = new Map(diff.map((entry) => [key(entry.feature_type, entry.id), entry]));
  const byType = new Map<DiffFeatureType, DiffEntry[]>();
  for (const entry of diff) {
    byType.set(entry.feature_type, [...(byType.get(entry.feature_type) ?? []), entry]);
  }

  // Every modify and remove names a row HEAD still has at base_rev; no add names one it has.
  for (const [type, typed] of byType) {
    const revs = await headRevs(
      db,
      type,
      typed.map((entry) => entry.id),
    );
    for (const entry of typed) {
      const rev = revs.get(entry.id);
      if (entry.op === "add") {
        if (rev !== undefined) reasons.push(`add ${type} ${entry.id}: HEAD already has it`);
      } else if (rev === undefined) {
        reasons.push(`${entry.op} ${type} ${entry.id}: HEAD no longer has it`);
      } else if (rev !== entry.base_rev) {
        reasons.push(
          `${entry.op} ${type} ${entry.id}: HEAD has rev ${rev}; the diff was made against rev ${entry.base_rev}`,
        );
      }
    }
  }

  // Every row an add or modify references is in HEAD, or added by the diff. (References to rows
  // the diff removes are refused by validateChangeSetDiff.)
  const wanted = new Map<DiffFeatureType, Set<string>>();
  for (const entry of diff) {
    if (entry.after === null) continue;
    const after = entry.after as unknown as Record<string, unknown>;
    for (const { column, feature_type } of DIFF_ROW_REFERENCES[entry.feature_type]) {
      const id = after[column];
      if (typeof id !== "string") continue;
      const referenced = entries.get(key(feature_type, id));
      if (referenced?.op === "add") continue;
      wanted.set(feature_type, (wanted.get(feature_type) ?? new Set()).add(id));
    }
  }
  const present = new Set<string>();
  for (const [type, ids] of wanted) {
    for (const id of (await headRevs(db, type, [...ids])).keys()) present.add(key(type, id));
  }
  for (const entry of diff) {
    if (entry.after === null) continue;
    const after = entry.after as unknown as Record<string, unknown>;
    for (const { column, feature_type } of DIFF_ROW_REFERENCES[entry.feature_type]) {
      const id = after[column];
      if (typeof id !== "string") continue;
      if (entries.get(key(feature_type, id))?.op === "add") continue;
      if (!present.has(key(feature_type, id))) {
        reasons.push(
          `${entry.op} ${entry.feature_type} ${entry.id}: ${column} references ${feature_type} ${id}, which HEAD no longer has`,
        );
      }
    }
  }

  // No remove may cascade: every HEAD row that references a removed one is removed too, or
  // modified so that it no longer does. ON DELETE CASCADE or SET NULL must never change a row the
  // diff doesn't name.
  const removed = new Map<DiffFeatureType, string[]>();
  for (const entry of diff) {
    if (entry.op === "remove") {
      removed.set(entry.feature_type, [...(removed.get(entry.feature_type) ?? []), entry.id]);
    }
  }
  for (const child of DIFF_FEATURE_TYPES) {
    for (const { column, feature_type: parent } of DIFF_ROW_REFERENCES[child]) {
      const ids = removed.get(parent);
      if (ids === undefined) continue;
      for (const row of await referencingRows(db, child, column, ids)) {
        const entry = entries.get(key(child, row.id));
        if (entry?.op === "remove") continue;
        if (entry?.op === "modify") {
          const after = entry.after as unknown as Record<string, unknown>;
          if (after[column] !== row.ref) continue;
        }
        reasons.push(
          `remove ${parent} ${row.ref}: ${child} ${row.id} references it (${column}), and the diff leaves that`,
        );
      }
    }
  }

  // A level keeps its venue while restricted zones are drawn on it: a zone's level belongs to the
  // zone's venue (restricted_zones' foreign key), and zones change only by the owner's hand.
  const levelModifies = diff.flatMap((entry) =>
    entry.feature_type === "level" && entry.op === "modify" ? [entry] : [],
  );
  if (levelModifies.length > 0) {
    const zoned = await sql<{ id: string; venue_id: string }>`
      SELECT l.id, l.venue_id
        FROM levels l
       WHERE l.id = ANY(${levelModifies.map((e) => e.id)}::uuid[])
         AND EXISTS (SELECT 1 FROM restricted_zones rz WHERE rz.level_id = l.id)`.execute(db);
    const venueOf = new Map(zoned.rows.map((row) => [row.id, row.venue_id]));
    for (const entry of levelModifies) {
      const venue = venueOf.get(entry.id);
      if (venue !== undefined && venue !== entry.after.venue_id) {
        reasons.push(
          `modify level ${entry.id}: moves it from venue ${venue} to ${entry.after.venue_id}, but restricted zones are drawn on it`,
        );
      }
    }
  }

  // An anchor a capture starts or ends on is never removed.
  const anchors = removed.get("anchor");
  if (anchors !== undefined) {
    const used = await db
      .selectFrom("captures")
      .select(["start_anchor_id", "end_anchor_id"])
      .where((eb) =>
        eb.or([eb("start_anchor_id", "in", anchors), eb("end_anchor_id", "in", anchors)]),
      )
      .execute();
    const usedIds = new Set(used.flatMap((c) => [c.start_anchor_id, c.end_anchor_id]));
    for (const id of anchors) {
      if (usedIds.has(id)) reasons.push(`remove anchor ${id}: a capture starts or ends on it`);
    }
  }

  return capped(reasons);
}

/** The rev of each of `ids` that HEAD has, by id. */
async function headRevs(
  db: Kysely<Database>,
  type: DiffFeatureType,
  ids: readonly string[],
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom(FEATURE_TABLES[type])
    .select(["id", "rev"])
    .where("id", "in", [...ids])
    .execute();
  return new Map(rows.map((row) => [row.id, row.rev]));
}

/** HEAD rows of `child` whose `column` names one of `ids`. */
async function referencingRows(
  db: Kysely<Database>,
  child: DiffFeatureType,
  column: string,
  ids: readonly string[],
): Promise<{ id: string; ref: string }[]> {
  const result = await sql<{ id: string; ref: string }>`
    SELECT id, ${sql.ref(column)} AS ref
      FROM ${sql.table(FEATURE_TABLES[child])}
     WHERE ${sql.ref(column)} = ANY(${[...ids]}::uuid[])
     ORDER BY id`.execute(db);
  return result.rows;
}

/**
 * The order approval applies entries in: adds and modifies parents first (venue, level, space,
 * node, edge, poi, anchor), then removes children first; by id within a type.
 */
export function applyOrder(diff: ChangeSetDiff): DiffEntry[] {
  const rank = (entry: DiffEntry) => DIFF_FEATURE_TYPES.indexOf(entry.feature_type);
  const byId = (a: DiffEntry, b: DiffEntry) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return [
    ...diff.filter((e) => e.op !== "remove").sort((a, b) => rank(a) - rank(b) || byId(a, b)),
    ...diff.filter((e) => e.op === "remove").sort((a, b) => rank(b) - rank(a) || byId(a, b)),
  ];
}

/**
 * Applies a diff that passed the rebase check: an add inserts `after` with rev 1, a modify writes
 * the whole of `after` and sets rev to base_rev + 1, a remove deletes the row. The database's
 * triggers set ordinals and refuse a feature whose own geometry overlaps a restricted zone. Throws
 * EntryRefusedError, naming the entry, when the database refuses one.
 */
export async function applyDiff(db: Kysely<Database>, diff: ChangeSetDiff): Promise<AppliedCounts> {
  requireTransaction(db, "Applying a diff");
  const counts = { added: 0, modified: 0, removed: 0 };
  for (const entry of applyOrder(diff)) {
    try {
      await applyEntry(db, entry);
    } catch (error) {
      const violation = integrityViolation(error);
      if (violation === undefined) throw error;
      throw new EntryRefusedError(
        `${entry.op} ${entry.feature_type} ${entry.id}: the database refused it: ${violation}`,
        { cause: error },
      );
    }
    if (entry.op === "add") counts.added += 1;
    else if (entry.op === "modify") counts.modified += 1;
    else counts.removed += 1;
  }
  return counts;
}

/**
 * The rebase check, then the diff if it passes, under a savepoint: a change set the database
 * refuses, or one that leaves HEAD with a new overlap of a restricted zone, is rolled back to it
 * and needs a rebase. Nothing of a change set that needs a rebase stays written; recording that
 * decision is the caller's.
 */
export async function applyChangeSet(
  db: Kysely<Database>,
  changeSet: ChangeSetToApply,
): Promise<ApplyOutcome> {
  const reasons = await rebaseReasons(db, changeSet);
  if (reasons.length > 0) return { decision: "needs_rebase", reasons };

  const overlapsBefore = new Set((await headOverlaps(db, { connectors: false })).map(overlapKey));
  const constraint = sql.id(LEVEL_NAME_CONSTRAINT);
  await sql`SAVEPOINT apply_change_set`.execute(db);
  const undo = async (why: readonly string[]): Promise<ApplyOutcome> => {
    await sql`ROLLBACK TO SAVEPOINT apply_change_set`.execute(db);
    await sql`SET CONSTRAINTS ${constraint} IMMEDIATE`.execute(db);
    await sql`RELEASE SAVEPOINT apply_change_set`.execute(db);
    return { decision: "needs_rebase", reasons: why };
  };

  let counts: AppliedCounts;
  try {
    await sql`SET CONSTRAINTS ${constraint} DEFERRED`.execute(db);
    counts = await applyDiff(db, changeSet.diff as ChangeSetDiff);
    // The deferred check, for this change set's rows: two levels may swap names, but no venue
    // ends up with two levels of one name.
    await sql`SET CONSTRAINTS ${constraint} IMMEDIATE`.execute(db);
  } catch (error) {
    if (error instanceof EntryRefusedError) return undo([error.reason]);
    const violation = integrityViolation(error);
    if (violation === undefined) throw error;
    return undo([`the database refused the change set: ${violation}`]);
  }

  const overlapsAdded = (await headOverlaps(db, { connectors: false })).filter(
    (overlap) => !overlapsBefore.has(overlapKey(overlap)),
  );
  if (overlapsAdded.length > 0) {
    return undo(capped(overlapsAdded.map((o) => `restricted zones: ${describeOverlap(o)}`)));
  }
  await sql`RELEASE SAVEPOINT apply_change_set`.execute(db);
  return { decision: "applied", counts };
}

// ---------------------------------------------------------------- writing rows

/** GeoJSON in, as PostGIS geometry in WGS84; null stays null. */
function geometry(value: object | null): RawBuilder<string> | null {
  if (value === null) return null;
  return sql<string>`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(value)}), 4326)`;
}

const venueColumns = (row: VenueRow) => ({
  name: row.name,
  kind: row.kind,
  operator: row.operator,
  footprint: geometry(row.footprint),
});

const levelColumns = (row: LevelRow) => ({
  venue_id: row.venue_id,
  ordinal: row.ordinal,
  name: row.name,
  elevation_m: row.elevation_m,
  sort_key: row.sort_key,
});

const spaceColumns = (row: SpaceRow) => ({
  level_id: row.level_id,
  kind: row.kind,
  name: row.name,
  geom: sql<string>`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(row.geom)}), 4326)`,
});

const nodeColumns = (row: NodeRow) => ({
  level_id: row.level_id,
  kind: row.kind,
  name: row.name,
  street_name: row.street_name,
  connector_id: row.connector_id,
  elevation_m: row.elevation_m,
  geom: sql<string>`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(row.geom)}), 4326)`,
});

const edgeColumns = (row: EdgeRow) => ({
  from_node: row.from_node,
  to_node: row.to_node,
  kind: row.kind,
  oneway: row.oneway,
  access: row.access,
  opening_hours: row.opening_hours,
  level_id: row.level_id,
  connector_id: row.connector_id,
  length_m: row.length_m,
  step_free: row.step_free,
  sheltered: row.sheltered,
  outdoor: row.outdoor,
  geom: geometry(row.geom),
});

const poiColumns = (row: PoiRow) => ({
  space_id: row.space_id,
  level_id: row.level_id,
  name: row.name,
  category: row.category,
  geom: sql<string>`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(row.geom)}), 4326)`,
});

const anchorColumns = (row: AnchorRow) => ({
  node_id: row.node_id,
  kind: row.kind,
  name: row.name,
  level_id: row.level_id,
  facing_deg: row.facing_deg,
  surveyed_geom: geometry(row.surveyed_geom),
  prior_source: row.prior_source,
  prior_sigma_m: row.prior_sigma_m,
  photo_uri: row.photo_uri,
});

function expectOne(count: bigint | undefined, entry: DiffEntry): void {
  if (count !== 1n) {
    throw new ApplyConflictError(
      `${entry.op} ${entry.feature_type} ${entry.id}: HEAD changed at rev ${entry.base_rev} after the rebase check`,
    );
  }
}

async function applyEntry(db: Kysely<Database>, entry: DiffEntry): Promise<void> {
  if (entry.op === "remove") {
    const result = await db
      .deleteFrom(FEATURE_TABLES[entry.feature_type])
      .where("id", "=", entry.id)
      .where("rev", "=", entry.base_rev)
      .executeTakeFirst();
    expectOne(result.numDeletedRows, entry);
    return;
  }
  if (entry.op === "add") {
    const id = entry.id;
    switch (entry.feature_type) {
      case "space":
        await db
          .insertInto("spaces")
          .values({ id, rev: 1, ...spaceColumns(entry.after) })
          .execute();
        return;
      case "node":
        await db
          .insertInto("nodes")
          .values({ id, rev: 1, ...nodeColumns(entry.after) })
          .execute();
        return;
      case "edge":
        await db
          .insertInto("edges")
          .values({ id, rev: 1, ...edgeColumns(entry.after) })
          .execute();
        return;
      case "poi":
        await db
          .insertInto("pois")
          .values({ id, rev: 1, ...poiColumns(entry.after) })
          .execute();
        return;
      case "anchor":
        await db
          .insertInto("anchors")
          .values({ id, rev: 1, ...anchorColumns(entry.after) })
          .execute();
        return;
    }
  }
  const rev = entry.base_rev + 1;
  let result: { numUpdatedRows: bigint };
  switch (entry.feature_type) {
    case "venue":
      // Never permission: the seed script owns it, and no diff carries it.
      result = await db
        .updateTable("venues")
        .set({ ...venueColumns(entry.after), updated_at: sql<Date>`now()`, rev })
        .where("id", "=", entry.id)
        .where("rev", "=", entry.base_rev)
        .executeTakeFirst();
      break;
    case "level":
      result = await db
        .updateTable("levels")
        .set({ ...levelColumns(entry.after), rev })
        .where("id", "=", entry.id)
        .where("rev", "=", entry.base_rev)
        .executeTakeFirst();
      break;
    case "space":
      result = await db
        .updateTable("spaces")
        .set({ ...spaceColumns(entry.after), rev })
        .where("id", "=", entry.id)
        .where("rev", "=", entry.base_rev)
        .executeTakeFirst();
      break;
    case "node":
      result = await db
        .updateTable("nodes")
        .set({ ...nodeColumns(entry.after), rev })
        .where("id", "=", entry.id)
        .where("rev", "=", entry.base_rev)
        .executeTakeFirst();
      break;
    case "edge":
      result = await db
        .updateTable("edges")
        .set({ ...edgeColumns(entry.after), rev })
        .where("id", "=", entry.id)
        .where("rev", "=", entry.base_rev)
        .executeTakeFirst();
      break;
    case "poi":
      result = await db
        .updateTable("pois")
        .set({ ...poiColumns(entry.after), rev })
        .where("id", "=", entry.id)
        .where("rev", "=", entry.base_rev)
        .executeTakeFirst();
      break;
    case "anchor":
      result = await db
        .updateTable("anchors")
        .set({ ...anchorColumns(entry.after), rev })
        .where("id", "=", entry.id)
        .where("rev", "=", entry.base_rev)
        .executeTakeFirst();
      break;
  }
  expectOne(result.numUpdatedRows, entry);
}
