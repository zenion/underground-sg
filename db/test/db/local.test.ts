// recreateLocalDatabase (src/local.ts), what `pnpm demo --reset` runs: it empties a database by
// dropping and migrating it again, since map_versions and moderation_events refuse deletes; and it
// refuses a server elsewhere or a maintenance database. Run on a scratch database of its own,
// never the developer's.

import pg from "pg";
import { afterAll, describe, expect, inject, test } from "vitest";
import { withDatabase } from "../../src/config.ts";
import { recreateLocalDatabase } from "../../src/local.ts";
import { createMigratedScratch, dropScratch } from "../../src/scratch.ts";

const server = new URL(inject("serverUrl"));
const scratch = createMigratedScratch(server, "recreate");
afterAll(() => dropScratch(server, scratch));

async function query<R extends pg.QueryResultRow>(sql: string): Promise<R[]> {
  const client = new pg.Client({ connectionString: withDatabase(server, scratch).href });
  await client.connect();
  try {
    return (await client.query<R>(sql)).rows;
  } finally {
    await client.end();
  }
}

describe("recreateLocalDatabase", () => {
  test("leaves the database migrated and empty, write-once rows included", async () => {
    await query(
      `WITH c AS (INSERT INTO contributors (display_name, trust_tier) VALUES ('Owner', 'owner') RETURNING id),
            cs AS (INSERT INTO change_sets (contributor_id, track, diff)
                   SELECT id, 'structural', '[{"op":"add"}]' FROM c RETURNING id)
       INSERT INTO moderation_events (change_set_id, action) SELECT id, 'gates_passed' FROM cs`,
    );
    expect(await query("SELECT count(*)::int AS n FROM moderation_events")).toEqual([{ n: 1 }]);

    await recreateLocalDatabase(withDatabase(server, scratch));

    expect(await query("SELECT count(*)::int AS n FROM moderation_events")).toEqual([{ n: 0 }]);
    expect(await query("SELECT count(*)::int AS n FROM contributors")).toEqual([{ n: 0 }]);
    expect(await query("SELECT version_id FROM map_head")).toEqual([{ version_id: null }]);
    const migrations = await query<{ version: string }>("SELECT version FROM schema_migrations");
    expect(migrations.length).toBeGreaterThan(1);
  });

  test("refuses a server elsewhere, and the maintenance databases", async () => {
    await expect(
      recreateLocalDatabase(new URL("postgres://usg:x@db.example.com:5432/usg")),
    ).rejects.toThrow(/only on this machine/);
    // node-postgres and dbmate would connect to the server a query parameter names.
    for (const parameter of ["host=db.example.com", "hostaddr=10.0.0.1"]) {
      const url = withDatabase(server, scratch);
      url.search = parameter;
      await expect(recreateLocalDatabase(url)).rejects.toThrow(/only on this machine/);
    }
    for (const name of ["postgres", "template1"]) {
      await expect(recreateLocalDatabase(withDatabase(server, name))).rejects.toThrow(/Refusing/);
    }
  });
});
