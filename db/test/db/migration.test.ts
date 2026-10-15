// The migrations give an empty, valid database, and their down sections, run newest first, drop
// everything the up sections created.

import { readdirSync } from "node:fs";
import { describe, expect, inject, test } from "vitest";
import { MIGRATIONS_DIR, withDatabase } from "../../src/config.ts";
import { dbmateOrThrow } from "../../src/dbmate.ts";
import { useDatabase } from "./harness.ts";

const db = useDatabase();

interface Objects {
  extensions: string[];
  tables: string[];
  types: string[];
  functions: string[];
}

/** What a migration could have created in the database, as sorted lists. */
async function objects(): Promise<Objects> {
  const list = async (sql: string) =>
    (await db.query<{ name: string }>(sql)).map((row) => row.name).sort();
  return {
    extensions: await list("SELECT extname AS name FROM pg_extension"),
    tables: await list(
      `SELECT relname AS name FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v', 'm')`,
    ),
    types: await list(
      `SELECT typname AS name FROM pg_type
        WHERE typnamespace = 'public'::regnamespace AND typtype = 'e'`,
    ),
    functions: await list(
      `SELECT p.proname AS name FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND NOT EXISTS (SELECT 1 FROM pg_depend d
                           WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`,
    ),
  };
}

describe("the migrated database", () => {
  test("is empty apart from the map_head row, which points at no version yet", async () => {
    const counts = await db.query<{ table_name: string; rows: number }>(
      `SELECT table_name, (xpath('/row/n/text()',
                 query_to_xml(format('SELECT count(*) AS n FROM %I', table_name), false, true, '')))[1]::text::int AS rows
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          AND table_name NOT IN ('spatial_ref_sys', 'schema_migrations', 'map_head')`,
    );
    expect(counts.length).toBeGreaterThan(15);
    expect(counts.filter((row) => row.rows !== 0)).toEqual([]);
    expect(await db.query("SELECT id, version_id FROM map_head")).toEqual([
      { id: true, version_id: null },
    ]);
  });

  test("has PostGIS with SVY21 (EPSG:3414)", async () => {
    expect(await db.value("SELECT count(*)::int FROM spatial_ref_sys WHERE srid = 3414")).toBe(1);
  });
});

describe("rolling back every migration", () => {
  test("drops everything they created, and migrating again restores it", async () => {
    const migrated = await objects();
    expect(migrated.extensions).toEqual(["plpgsql", "postgis"]);
    expect(migrated.types).toContain("publish_path");
    expect(migrated.functions).toContain("change_sets_guard");

    const url = withDatabase(
      new URL(inject("serverUrl")),
      await db.value<string>("SELECT current_database()"),
    );
    // dbmate rolls back one migration at a time, newest first.
    const migrations = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql"));
    expect(migrations.length).toBeGreaterThan(0);
    for (const _ of migrations) dbmateOrThrow(["rollback"], url);
    expect(await objects()).toEqual({
      extensions: ["plpgsql"],
      tables: ["schema_migrations"],
      types: [],
      functions: [],
    });

    dbmateOrThrow(["up", "--strict"], url);
    expect(await objects()).toEqual(migrated);
    expect(await db.value<number>("SELECT count(*)::int FROM map_head")).toBe(1);
  });
});
