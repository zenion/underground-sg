// Throwaway databases for the schema dump and the rule tests. They live on the same server
// as DATABASE_URL, are named usg_scratch_<epoch ms>_<label>_<random>, and are dropped when
// done. The developer's own database is never opened.

import { randomBytes } from "node:crypto";
import pg from "pg";
import { withDatabase } from "./config.ts";
import { dbmateOrThrow } from "./dbmate.ts";

export const SCRATCH_PREFIX = "usg_scratch_";

/** Scratch databases older than this are left over from a run that crashed; the next run drops them. */
const STALE_AFTER_MS = 60 * 60 * 1000;

/** A new scratch database name. `label` is lower-case letters and digits. */
export function scratchName(label: string): string {
  return `${SCRATCH_PREFIX}${Date.now()}_${label}_${randomBytes(4).toString("hex")}`;
}

/** Quotes a scratch database name, refusing anything else. */
function scratchIdent(name: string): string {
  if (!new RegExp(`^${SCRATCH_PREFIX}[0-9]+_[a-z0-9]+_[0-9a-f]+$`).test(name)) {
    throw new Error(`not a scratch database name: ${name}`);
  }
  return `"${name}"`;
}

/** Runs `fn` on a connection to the server's `postgres` maintenance database. */
export async function withMaintenance<T>(
  url: URL,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: withDatabase(url, "postgres").href });
  try {
    await client.connect();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw error;
    throw new Error(
      `Nothing is listening on ${url.host}. Start the local stack with \`docker compose up -d --wait\`.`,
      { cause: error },
    );
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Creates a scratch database and applies every migration with dbmate. Returns its name. */
export function createMigratedScratch(url: URL, label: string): string {
  const name = scratchName(label);
  // `dbmate up` creates the database (from template1, so it holds only what the
  // migrations create) and applies the migrations.
  dbmateOrThrow(["up", "--strict"], withDatabase(url, name));
  return name;
}

/** Creates a scratch database as a copy of `template`. Returns its name. */
export async function createScratchFromTemplate(
  url: URL,
  template: string,
  label: string,
): Promise<string> {
  const name = scratchName(label);
  await withMaintenance(url, (client) =>
    client.query(`CREATE DATABASE ${scratchIdent(name)} TEMPLATE ${scratchIdent(template)}`),
  );
  return name;
}

/** Drops a scratch database, closing any connections still open to it. */
export async function dropScratch(url: URL, name: string): Promise<void> {
  await withMaintenance(url, (client) =>
    client.query(`DROP DATABASE IF EXISTS ${scratchIdent(name)} WITH (FORCE)`),
  );
}

/** Drops scratch databases left behind by runs that crashed more than an hour ago. */
export async function dropStaleScratches(url: URL): Promise<string[]> {
  return withMaintenance(url, async (client) => {
    const { rows } = await client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE starts_with(datname, $1)",
      [SCRATCH_PREFIX],
    );
    const dropped: string[] = [];
    for (const { datname } of rows) {
      const created = Number(datname.slice(SCRATCH_PREFIX.length).split("_")[0]);
      if (Number.isFinite(created) && Date.now() - created > STALE_AFTER_MS) {
        await client.query(`DROP DATABASE IF EXISTS ${scratchIdent(datname)} WITH (FORCE)`);
        dropped.push(datname);
      }
    }
    return dropped;
  });
}
