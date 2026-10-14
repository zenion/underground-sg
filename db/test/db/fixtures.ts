// Synthetic fixtures at real City Hall cluster coordinates (WGS84 lon/lat): Funan's B2 near
// the underground link to City Hall MRT, Raffles City, and street exits on North Bridge Road
// and at City Hall exit A. Restricted zones in the tests are made up, never a real
// back-of-house outline.

import type { TestDb } from "./harness.ts";

export const CONTRIBUTOR = {
  owner: "00000000-0000-0000-0000-00000000000a",
  moderator: "00000000-0000-0000-0000-00000000000b",
  trusted: "00000000-0000-0000-0000-00000000000c",
  newcomer: "00000000-0000-0000-0000-00000000000d",
  secondModerator: "00000000-0000-0000-0000-00000000000e",
} as const;

export const VENUE = {
  funan: "10000000-0000-0000-0000-000000000001",
  rafflesCity: "10000000-0000-0000-0000-000000000002",
} as const;

export const LEVEL = {
  funanB2: "20000000-0000-0000-0000-000000000001",
  funanB1: "20000000-0000-0000-0000-000000000002",
  /** A mezzanine sharing B1's display band. */
  funanB1M: "20000000-0000-0000-0000-000000000003",
  rafflesCityB1: "20000000-0000-0000-0000-000000000004",
} as const;

export const NODE = {
  /** Escalator landings on Funan B2 and B1, one physical escalator. */
  funanB2Escalator: "30000000-0000-0000-0000-000000000001",
  funanB1Escalator: "30000000-0000-0000-0000-000000000002",
  /** A street exit outside any venue. */
  northBridgeRoadExit: "30000000-0000-0000-0000-000000000003",
} as const;

/** Lon/lat pairs in the cluster. */
export const AT = {
  funanB2Escalator: [103.8499, 1.2913],
  funanB1Escalator: [103.84995, 1.29135],
  northBridgeRoadExit: [103.8506, 1.2928],
  northBridgeRoadVertex: [103.8507, 1.29285],
  cityHallExitA: [103.8523, 1.2931],
  rafflesCity: [103.8531, 1.2937],
} as const satisfies Record<string, readonly [number, number]>;

/** A point as EWKT, for a `$n::geometry` parameter. */
export function point([lon, lat]: readonly [number, number]): string {
  return `SRID=4326;POINT(${lon} ${lat})`;
}

/** A line through the given points, as EWKT. */
export function line(...points: (readonly [number, number])[]): string {
  return `SRID=4326;LINESTRING(${points.map(([lon, lat]) => `${lon} ${lat}`).join(", ")})`;
}

/** An axis-aligned rectangle, as EWKT. */
export function box(west: number, south: number, east: number, north: number): string {
  return `SRID=4326;POLYGON((${west} ${south}, ${east} ${south}, ${east} ${north}, ${west} ${north}, ${west} ${south}))`;
}

/** Contributors of every tier, two venues, four levels (two sharing a band), three nodes. */
export async function seedCluster(db: TestDb): Promise<void> {
  await db.query(
    `INSERT INTO contributors (id, display_name, trust_tier) VALUES
         ($1, 'Owner', 'owner'), ($2, 'Moderator', 'moderator'), ($3, 'Trusted', 'trusted'),
         ($4, 'Newcomer', 'new'), ($5, 'Second moderator', 'moderator')`,
    [
      CONTRIBUTOR.owner,
      CONTRIBUTOR.moderator,
      CONTRIBUTOR.trusted,
      CONTRIBUTOR.newcomer,
      CONTRIBUTOR.secondModerator,
    ],
  );
  await db.query(
    `INSERT INTO venues (id, name, kind, operator) VALUES
         ($1, 'Funan', 'mall', 'landlord'), ($2, 'Raffles City', 'mall', 'landlord')`,
    [VENUE.funan, VENUE.rafflesCity],
  );
  await db.query(
    `INSERT INTO levels (id, venue_id, ordinal, name, elevation_m, sort_key) VALUES
         ($1, $5, -2, 'B2', -9.5, 0), ($2, $5, -1, 'B1', -4.5, 0), ($3, $5, -1, 'B1M', -3.0, 1),
         ($4, $6, -1, 'B1', NULL, 0)`,
    [
      LEVEL.funanB2,
      LEVEL.funanB1,
      LEVEL.funanB1M,
      LEVEL.rafflesCityB1,
      VENUE.funan,
      VENUE.rafflesCity,
    ],
  );
  await db.query(
    `INSERT INTO nodes (id, level_id, kind, name, street_name, geom) VALUES
         ($1, $4, 'escalator', 'Funan B2 escalator', NULL, $5::geometry),
         ($2, $6, 'escalator', 'Funan B1 escalator', NULL, $7::geometry),
         ($3, NULL, 'exit', NULL, 'North Bridge Road', $8::geometry)`,
    [
      NODE.funanB2Escalator,
      NODE.funanB1Escalator,
      NODE.northBridgeRoadExit,
      LEVEL.funanB2,
      point(AT.funanB2Escalator),
      LEVEL.funanB1,
      point(AT.funanB1Escalator),
      point(AT.northBridgeRoadExit),
    ],
  );
}

// ---------------------------------------------------------------- change sets

export type Track = "structural" | "status";
export type PublishPath = "moderator_review" | "owner_mapper" | "trusted_status_auto";

/** Inserts a pending change set and returns its id. */
export async function pendingChangeSet(
  db: TestDb,
  contributor: string,
  track: Track,
  diff = "[]",
): Promise<string> {
  return db.value<string>(
    "INSERT INTO change_sets (contributor_id, track, diff) VALUES ($1, $2, $3::jsonb) RETURNING id",
    [contributor, track, diff],
  );
}

/** Records an automated-gates result (actor NULL: the gates are automated). */
export async function recordGates(
  db: TestDb,
  changeSet: string,
  action: "gates_passed" | "gates_failed",
): Promise<void> {
  await db.query("INSERT INTO moderation_events (change_set_id, action) VALUES ($1, $2)", [
    changeSet,
    action,
  ]);
}

/** Inserts a map version (not a rollback) and returns its id. */
export async function newVersion(db: TestDb, restores: number | null = null): Promise<number> {
  return db.value<number>(
    `INSERT INTO map_versions (published_by, snapshot_uri, snapshot_sha256, private_export_uri, restores)
     VALUES ($1, 'versions/' || gen_random_uuid(), md5(random()::text), 'exports/' || gen_random_uuid(), $2)
     RETURNING id`,
    [CONTRIBUTOR.owner, restores],
  );
}

/** The SQL that publishes a change set through a path, and its parameters. */
export function publishStatement(
  changeSet: string,
  path: PublishPath,
  options: { reviewer?: string | null; version?: number | null } = {},
): [string, unknown[]] {
  return [
    `UPDATE change_sets
        SET decision = $2, publish_path = $3, reviewer_id = $4, map_version_id = $5,
            reviewed_at = CASE WHEN $4::uuid IS NULL THEN NULL ELSE now() END
      WHERE id = $1`,
    [
      changeSet,
      path === "moderator_review" ? "approved" : "auto_published",
      path,
      options.reviewer ?? null,
      options.version ?? null,
    ],
  ];
}

/**
 * Publishes a change set as the approval transaction would: a new version for a structural
 * change set (status edits get none), the change set pointed at it, map_head moved on.
 */
export async function publish(
  db: TestDb,
  changeSet: string,
  path: PublishPath,
  reviewer: string | null = null,
): Promise<number | null> {
  const track = await db.value<Track>("SELECT track FROM change_sets WHERE id = $1", [changeSet]);
  const version = track === "structural" ? await newVersion(db) : null;
  const [sql, params] = publishStatement(changeSet, path, { reviewer, version });
  await db.query(sql, params);
  if (version !== null) await db.query("UPDATE map_head SET version_id = $1", [version]);
  return version;
}

/** Inserts a capture by the owner and returns its id. */
export async function capture(
  db: TestDb,
  options: { status?: string; privacyFlagged?: boolean } = {},
): Promise<string> {
  return db.value<string>(
    `INSERT INTO captures (id, contributor_id, status, privacy_flagged, device_model, os_version,
                           app_version, captured_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'iPhone 17 Pro Max', '26.6.1', '0.1.0', now())
     RETURNING id`,
    [CONTRIBUTOR.owner, options.status ?? "ready_for_review", options.privacyFlagged ?? false],
  );
}

/** Links a capture to a change set. */
export async function link(db: TestDb, changeSet: string, captureId: string): Promise<void> {
  await db.query("INSERT INTO change_set_captures (change_set_id, capture_id) VALUES ($1, $2)", [
    changeSet,
    captureId,
  ]);
}

/**
 * A second pending change set (the owner's, structural) in the same transaction, with its
 * own capture and gates result, recorded in that order. It shows that a publish rule reads
 * only the change set being published: another change set's gates_passed must not unlock
 * it, and another's gates_failed or privacy-flagged capture must not block it.
 */
export async function decoyChangeSet(
  db: TestDb,
  options: {
    gates?: "gates_passed" | "gates_failed";
    capture?: { status?: string; privacyFlagged?: boolean };
  },
): Promise<string> {
  const id = await pendingChangeSet(db, CONTRIBUTOR.owner, "structural");
  if (options.capture !== undefined) await link(db, id, await capture(db, options.capture));
  if (options.gates !== undefined) await recordGates(db, id, options.gates);
  return id;
}

/** Adds a status report (node closed) to a status change set; returns its id. */
export async function statusReport(
  db: TestDb,
  changeSet: string,
  validUntil: "4 hours" | null = "4 hours",
): Promise<string> {
  return db.value<string>(
    `INSERT INTO status_reports (feature_type, feature_id, is_open, valid_from, valid_until, change_set_id)
     VALUES ('node', $1, false, now(), now() + $2::interval, $3)
     RETURNING id`,
    [NODE.northBridgeRoadExit, validUntil, changeSet],
  );
}
