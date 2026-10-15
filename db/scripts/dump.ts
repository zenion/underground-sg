// Regenerates db/schema.sql: applies every migration to a scratch database, dumps its
// schema with pg_dump inside the PostGIS container, and drops it. `pnpm db dump`.

import { writeFileSync } from "node:fs";
import pg from "pg";
import { databaseUrl, SCHEMA_FILE, withDatabase } from "../src/config.ts";
import { normalizeDump, pgDumpInContainer } from "../src/dump.ts";
import { createMigratedScratch, dropScratch } from "../src/scratch.ts";

const url = databaseUrl();
const scratch = createMigratedScratch(url, "dump");
try {
  const client = new pg.Client({ connectionString: withDatabase(url, scratch).href });
  await client.connect();
  let versions: string[];
  try {
    const { rows } = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    versions = rows.map((row) => row.version);
  } finally {
    await client.end();
  }
  const raw = pgDumpInContainer(decodeURIComponent(url.username), scratch);
  writeFileSync(SCHEMA_FILE, normalizeDump(raw, versions));
  console.log(`wrote db/schema.sql (${versions.length} migrations)`);
} finally {
  await dropScratch(url, scratch);
}
