// `pnpm demo`: publishes the demo dataset (dataset.ts) through the real path, on the owner's PC
// only: the demo owner, the seed mechanism for venues and levels, synthetic footpaths, one
// owner_mapper change set, the gates, the publish transaction, latest.json with `demo: true`.
// `pnpm demo --reset` recreates the local database from the migrations and removes the demo's
// latest.json, status.json, version directories and private exports, so the demo can run again and
// nothing of it is left in the public bucket for a later upload to R2 to pick up.
//
// Both refuse unless DATABASE_URL and S3_ENDPOINT are on this machine, so demo data never reaches
// anything but the local PostGIS and RustFS; and both refuse when the database holds anything that
// isn't the demo's (a real seed, a capture, a restricted zone, a non-demo version), so neither mixes
// demo data into a real map nor wipes one. The other way round, the demo's owner contributor marks
// a database that holds the demo (@usg/db/demo): `pnpm db seed` and the publish refuse real data
// there, and latest.json says `demo: true` for as long as it is there.

import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { snapshotFilePath, VERSION_FILES } from "@usg/contracts";
import { validateChangeSetDiff } from "@usg/contracts/validators";
import { isLocalHost } from "@usg/db/local";
import { type Queryable, seed } from "@usg/db/seed";
import { CompiledQuery, type Kysely, sql } from "kysely";
import { isLoopbackHost, type StackConfig } from "../config.ts";
import { createDatabase, type Database } from "../database.ts";
import { runGates } from "../publish/gates.ts";
import { LATEST_KEY, readLatest, reconcileLatest, STATUS_KEY } from "../publish/pointer.ts";
import { publish } from "../publish/publish.ts";
import { createS3Client, S3ObjectStore, type Storage } from "../storage.ts";
import {
  DEMO_CHANGE_SET,
  DEMO_IDS,
  DEMO_NOTE,
  DEMO_OWNER,
  DEMO_OWNER_NAME,
  DEMO_SEED,
  DEMO_STREET,
  demoDiff,
  demoEdgeLines,
} from "./dataset.ts";

/** The demo can't run here, or can't run on what the database holds. Nothing was changed. */
export class DemoRefusedError extends Error {
  override name = "DemoRefusedError";
}

/**
 * Refuses a database or S3 endpoint that isn't on this machine. The database URL is read as the
 * drivers read it (isLocalHost from @usg/db): a `host`, `hostaddr` or `service` query parameter,
 * which node-postgres or dbmate would connect to instead of the URL's host, is refused outright.
 */
export function assertLocalStack(config: Pick<StackConfig, "databaseUrl" | "s3">): void {
  const problems: string[] = [];
  let database: URL | undefined;
  try {
    database = new URL(config.databaseUrl);
  } catch {
    problems.push("DATABASE_URL is not a URL");
  }
  if (database !== undefined && !isLocalHost(database)) {
    problems.push(
      isLoopbackHost(database.hostname)
        ? "DATABASE_URL has a query parameter naming another server (host, hostaddr or service)"
        : `DATABASE_URL points at ${database.hostname}, not this machine`,
    );
  }
  let endpoint: URL | undefined;
  try {
    endpoint = new URL(config.s3.endpoint);
  } catch {
    problems.push("S3_ENDPOINT is not a URL");
  }
  if (endpoint !== undefined && !isLoopbackHost(endpoint.hostname)) {
    problems.push(`S3_ENDPOINT points at ${endpoint.hostname}, not this machine`);
  }
  if (problems.length > 0) {
    throw new DemoRefusedError(
      `The demo runs only on the local stack: ${problems.join("; ")}. Demo data never leaves this PC.`,
    );
  }
}

/**
 * What the database holds besides the demo's rows ("2 venues", ...); empty when it holds only
 * demo data, or nothing.
 */
export async function nonDemoData(db: Kysely<Database>): Promise<string[]> {
  const counts = await sql<Record<string, number>>`
    SELECT
      (SELECT count(*)::int FROM contributors WHERE id <> ${DEMO_OWNER}) AS contributors,
      (SELECT count(*)::int FROM venues WHERE id <> ALL(${DEMO_IDS.venues}::uuid[])) AS venues,
      (SELECT count(*)::int FROM levels WHERE id <> ALL(${DEMO_IDS.levels}::uuid[])) AS levels,
      (SELECT count(*)::int FROM spaces WHERE id <> ALL(${DEMO_IDS.spaces}::uuid[])) AS spaces,
      (SELECT count(*)::int FROM nodes WHERE id <> ALL(${DEMO_IDS.nodes}::uuid[])) AS nodes,
      (SELECT count(*)::int FROM edges WHERE id <> ALL(${DEMO_IDS.edges}::uuid[])) AS edges,
      (SELECT count(*)::int FROM pois WHERE id <> ALL(${DEMO_IDS.pois}::uuid[])) AS pois,
      (SELECT count(*)::int FROM anchors) AS anchors,
      (SELECT count(*)::int FROM restricted_zones) AS restricted_zones,
      (SELECT count(*)::int FROM street_nodes
        WHERE osm_node_id <> ALL(${DEMO_STREET.nodes.map((n) => n.id)}::bigint[])) AS street_nodes,
      (SELECT count(*)::int FROM street_edges
        WHERE osm_way_id <> ALL(${DEMO_STREET.edges.map((e) => e.way)}::bigint[])) AS street_edges,
      (SELECT count(*)::int FROM captures) AS captures,
      (SELECT count(*)::int FROM segment_alignments) AS segment_alignments,
      (SELECT count(*)::int FROM change_sets WHERE id <> ${DEMO_CHANGE_SET}) AS change_sets,
      (SELECT count(*)::int FROM status_reports) AS status_reports,
      (SELECT count(*)::int FROM map_versions v
        WHERE NOT EXISTS (SELECT 1 FROM change_sets c
                           WHERE c.map_version_id = v.id AND c.id = ${DEMO_CHANGE_SET}))
        AS map_versions`.execute(db);
  const row = counts.rows[0] ?? {};
  return Object.entries(row)
    .filter(([, count]) => count > 0)
    .map(([table, count]) => `${count} ${table.replaceAll("_", " ")}`);
}

/** The seed's connection interface over one Kysely connection. */
function queryable(connection: Kysely<Database>): Queryable {
  return {
    query: async <R extends Record<string, unknown>>(text: string, values: unknown[] = []) => {
      const result = await connection.executeQuery<R>(CompiledQuery.raw(text, values));
      return { rows: [...result.rows] };
    },
  };
}

export interface DemoResult {
  /** True when the demo was published before this run, which then only checked latest.json. */
  readonly alreadyPublished: boolean;
  readonly version: number;
  readonly snapshotSha256: string;
  /** What the run did, for the CLI to print. */
  readonly steps: readonly string[];
}

/**
 * Publishes the demo, or carries on from wherever an earlier run stopped. Running it again once
 * the demo is published changes nothing but a missing or stale latest.json.
 */
export async function runDemo(db: Kysely<Database>, storage: Storage): Promise<DemoResult> {
  const foreign = await nonDemoData(db);
  if (foreign.length > 0) {
    throw new DemoRefusedError(
      `The database holds data that isn't the demo's (${foreign.join(", ")}). The demo runs only on a local database that holds nothing else; it won't mix demo data into a real map.`,
    );
  }
  const steps: string[] = [];

  await db
    .insertInto("contributors")
    .values({ id: DEMO_OWNER, display_name: DEMO_OWNER_NAME, trust_tier: "owner" })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();

  const seeded = await db
    .connection()
    .execute((connection) => seed(queryable(connection), DEMO_SEED, { demo: true }));
  steps.push(
    `seeded venues and levels: ${seeded.insertedVenues.length} venues and ${seeded.insertedLevels.length} levels added`,
  );

  const streetAdded = await insertStreet(db);
  steps.push(`street footpaths: ${streetAdded} added`);

  let changeSet = await db
    .selectFrom("change_sets")
    .select(["decision", "map_version_id"])
    .where("id", "=", DEMO_CHANGE_SET)
    .executeTakeFirst();
  if (changeSet === undefined) {
    const diff = demoDiff(await edgeLengths(db));
    const validation = validateChangeSetDiff(diff, "structural");
    if (!validation.valid)
      throw new Error(`The demo diff is invalid: ${validation.problems.join("; ")}`);
    const head = await db.selectFrom("map_head").select("version_id").executeTakeFirstOrThrow();
    await db
      .insertInto("change_sets")
      .values({
        id: DEMO_CHANGE_SET,
        contributor_id: DEMO_OWNER,
        track: "structural",
        base_version_id: head.version_id,
        diff: JSON.stringify(diff),
        note: DEMO_NOTE,
      })
      .execute();
    steps.push(
      `change set ${DEMO_CHANGE_SET}: ${diff.length} entries (a manual edit, no captures)`,
    );
    changeSet = { decision: "pending", map_version_id: null };
  }

  if (changeSet.decision === "auto_published" && changeSet.map_version_id !== null) {
    const reconciled = await reconcileLatest(db, storage);
    const version = await db
      .selectFrom("map_versions")
      .select("snapshot_sha256")
      .where("id", "=", changeSet.map_version_id)
      .executeTakeFirstOrThrow();
    steps.push(
      reconciled.action === "repaired"
        ? "already published; latest.json repaired"
        : "already published; latest.json is current",
    );
    return {
      alreadyPublished: true,
      version: changeSet.map_version_id,
      snapshotSha256: version.snapshot_sha256,
      steps,
    };
  }
  if (changeSet.decision !== "pending") {
    throw new DemoRefusedError(
      `The demo change set is ${changeSet.decision}. Start again with \`pnpm demo --reset\`.`,
    );
  }

  const gates = await runGates(db, DEMO_CHANGE_SET);
  steps.push(
    `gates ${gates.passed ? "passed" : "failed"}: ${gates.gates.map((g) => `${g.gate} ${g.result}`).join(", ")}`,
  );
  if (!gates.passed) {
    throw new Error(`The demo change set failed its gates: ${JSON.stringify(gates.gates)}`);
  }

  const published = await publish(db, storage, {
    changeSetIds: [DEMO_CHANGE_SET],
    publishedBy: DEMO_OWNER,
    note: DEMO_NOTE,
    demo: true,
  });
  if (published.version === null) {
    throw new Error(
      `The demo change set needs a rebase: ${published.needsRebase.flatMap((n) => n.reasons).join("; ")}`,
    );
  }
  steps.push(
    `published version ${published.version.id}: ${published.version.uploaded.length} files uploaded, ${published.version.reused.length} already there`,
  );
  if (!published.pointer.updated && published.pointer.superseded !== true) {
    await reconcileLatest(db, storage);
    steps.push("latest.json failed to update and was repaired");
  }
  return {
    alreadyPublished: false,
    version: published.version.id,
    snapshotSha256: published.version.snapshotSha256,
    steps,
  };
}

/** The synthetic footpaths; rows already there are left. Returns how many rows it added. */
async function insertStreet(db: Kysely<Database>): Promise<number> {
  let added = 0;
  for (const node of DEMO_STREET.nodes) {
    const result = await sql`
      INSERT INTO street_nodes (osm_node_id, geom)
      VALUES (${node.id}, ST_SetSRID(ST_MakePoint(${node.at[0]}, ${node.at[1]}), 4326))
      ON CONFLICT (osm_node_id) DO NOTHING`.execute(db);
    added += Number(result.numAffectedRows ?? 0n);
  }
  for (const edge of DEMO_STREET.edges) {
    const result = await sql`
      INSERT INTO street_edges (osm_way_id, from_osm_node, to_osm_node, tags, covered, length_m, geom)
      SELECT ${edge.way}, f.osm_node_id, t.osm_node_id, ${JSON.stringify(edge.tags)}::jsonb,
             ${edge.covered}, ST_Length(ST_Transform(ST_MakeLine(f.geom, t.geom), 3414)),
             ST_MakeLine(f.geom, t.geom)
        FROM street_nodes f, street_nodes t
       WHERE f.osm_node_id = ${edge.from} AND t.osm_node_id = ${edge.to}
         AND NOT EXISTS (SELECT 1 FROM street_edges e
                          WHERE e.osm_way_id = ${edge.way} AND e.from_osm_node = ${edge.from}
                            AND e.to_osm_node = ${edge.to})`.execute(db);
    added += Number(result.numAffectedRows ?? 0n);
  }
  return added;
}

/** Each demo edge's length in metres, measured in SVY21 (never in degrees), to 2 decimals. */
async function edgeLengths(db: Kysely<Database>): Promise<Map<string, number>> {
  const lines = [...demoEdgeLines()].map(([id, geom]) => ({ id, geom: JSON.stringify(geom) }));
  const result = await sql<{ id: string; length_m: number }>`
    SELECT r.id,
           round(ST_Length(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(r.geom), 4326), 3414))::numeric, 2)::float8
             AS length_m
      FROM jsonb_to_recordset(${JSON.stringify(lines)}::jsonb) AS r(id text, geom text)`.execute(
    db,
  );
  return new Map(result.rows.map((row) => [row.id, row.length_m]));
}

export interface ResetResult {
  /** The objects deleted, as bucket/key. */
  readonly deleted: readonly string[];
}

/**
 * `pnpm demo --reset`: refuses unless the stack is local, the database holds only demo data and
 * latest.json (if any) is the demo's; then recreates the database from the migrations
 * (`recreate`: recreateLocalDatabase from @usg/db) and deletes the demo's latest.json, status.json,
 * version directories and private exports. A version's directory is otherwise never deleted; the
 * demo's are local, hold only demo data, and belong to versions the recreate has just removed, so
 * nothing of the demo stays in the public bucket for an upload to R2 to find.
 */
export async function resetDemo(
  config: StackConfig,
  recreate: (url: URL) => Promise<void>,
): Promise<ResetResult> {
  assertLocalStack(config);
  const db = createDatabase(config.databaseUrl, { maxConnections: 2 });
  let exportKeys: string[];
  let snapshotKeys: string[];
  try {
    const foreign = await nonDemoData(db);
    if (foreign.length > 0) {
      throw new DemoRefusedError(
        `The database holds data that isn't the demo's (${foreign.join(", ")}), so --reset won't wipe it.`,
      );
    }
    const versions = await db
      .selectFrom("map_versions")
      .select(["private_export_uri", "snapshot_sha256"])
      .orderBy("id")
      .execute();
    exportKeys = versions.map((row) => row.private_export_uri);
    snapshotKeys = [...new Set(versions.map((row) => row.snapshot_sha256))].flatMap((sha) =>
      VERSION_FILES.map((name) => snapshotFilePath(sha, name)),
    );
  } finally {
    await db.destroy();
  }

  const client = createS3Client(config.s3);
  try {
    const latest = await readLatest(new S3ObjectStore(client, config.buckets.public));
    if (latest !== undefined && latest.demo !== true) {
      throw new DemoRefusedError(
        `${config.buckets.public}/${LATEST_KEY} points at a map that isn't the demo, so --reset leaves the buckets and the database alone.`,
      );
    }
    await recreate(new URL(config.databaseUrl));

    const deleted: string[] = [];
    const remove = async (bucket: string, key: string) => {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      deleted.push(`${bucket}/${key}`);
    };
    for (const key of latest === undefined ? [] : [LATEST_KEY, STATUS_KEY]) {
      await remove(config.buckets.public, key);
    }
    for (const key of snapshotKeys) await remove(config.buckets.public, key);
    for (const key of exportKeys) await remove(config.buckets.exports, key);
    return { deleted };
  } finally {
    client.destroy();
  }
}
