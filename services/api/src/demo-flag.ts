// Whether the map is the demo (`pnpm demo`, src/demo/): the database holds the demo's owner
// contributor (@usg/db/demo). Every version in such a database is demo data, since the seed script
// and the publish refuse to put real data beside the demo and only `pnpm demo --reset`, which
// recreates the database, removes it. latest.json's `demo` and GET /map/latest's follow this, so a
// pointer rewritten by the reconcile job keeps the banner and a real map never gets it.

import { DEMO_OWNER } from "@usg/db/demo";
import type { Kysely } from "kysely";
import type { Database } from "./database.ts";

/** Whether the database holds the demo map. */
export async function holdsDemo(db: Kysely<Database>): Promise<boolean> {
  const row = await db
    .selectFrom("contributors")
    .select("id")
    .where("id", "=", DEMO_OWNER)
    .executeTakeFirst();
  return row !== undefined;
}
