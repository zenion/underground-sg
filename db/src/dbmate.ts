// Runs the dbmate binary (from the dbmate npm package) with this repo's settings.

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { resolveBinary } from "dbmate";
import { MIGRATIONS_DIR, SCHEMA_FILE } from "./config.ts";

export interface DbmateOptions {
  /** The database to work on; dbmate reads it from DATABASE_URL. Not needed for `new`. */
  url?: URL;
  /** Capture output instead of printing it. */
  quiet?: boolean;
}

/**
 * Runs `dbmate <args>` on the migrations in db/migrations. dbmate never writes db/schema.sql
 * itself (DBMATE_NO_DUMP_SCHEMA): its dump needs a pg_dump on the host that matches the
 * server, so `pnpm db dump` runs pg_dump inside the PostGIS container instead.
 */
export function dbmate(
  args: readonly string[],
  options: DbmateOptions = {},
): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DBMATE_MIGRATIONS_DIR: MIGRATIONS_DIR,
    DBMATE_SCHEMA_FILE: SCHEMA_FILE,
    DBMATE_NO_DUMP_SCHEMA: "true",
  };
  if (options.url !== undefined) env["DATABASE_URL"] = options.url.href;
  const result = spawnSync(resolveBinary(), args, {
    env,
    encoding: "utf8",
    stdio: options.quiet === true ? "pipe" : "inherit",
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

/** Runs dbmate quietly and throws with its output if it fails. */
export function dbmateOrThrow(args: readonly string[], url: URL): void {
  const result = dbmate(args, { url, quiet: true });
  if (result.status !== 0) {
    throw new Error(`dbmate ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  }
}
