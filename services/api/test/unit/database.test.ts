// The Kysely table types follow db/schema.sql: TABLE_COLUMNS lists every interface column (a
// compile-time check in src/database.ts), and here it is compared with the generated schema.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { TABLE_COLUMNS } from "../../src/database.ts";

const schemaSql = readFileSync(new URL("../../../../db/schema.sql", import.meta.url), "utf8");

/** The column names of `CREATE TABLE public.<table> (...)` in db/schema.sql, in order. */
function sqlColumns(table: string): string[] {
  const match = new RegExp(`^CREATE TABLE public\\.${table} \\(\\n([\\s\\S]*?)\\n\\);$`, "m").exec(
    schemaSql,
  );
  if (match?.[1] === undefined) throw new Error(`db/schema.sql has no table ${table}`);
  // pg_dump writes the columns first, one per line, then the constraints (which can span lines).
  const columns: string[] = [];
  for (const line of match[1].split("\n")) {
    if (line.startsWith("    CONSTRAINT ")) break;
    const column = /^ {4}(\w+) /.exec(line)?.[1];
    if (column !== undefined) columns.push(column);
  }
  return columns;
}

describe("TABLE_COLUMNS matches db/schema.sql", () => {
  test("every table, dbmate's aside", () => {
    const tables = [...schemaSql.matchAll(/^CREATE TABLE public\.(\w+) \(/gm)].map((m) => m[1]);
    expect(tables.filter((t) => t !== "schema_migrations").sort()).toEqual(
      Object.keys(TABLE_COLUMNS).sort(),
    );
  });

  test.each(Object.entries(TABLE_COLUMNS))("%s", (table, columns) => {
    expect([...columns]).toEqual(sqlColumns(table));
  });
});
