// The version map_head points at: what GET /map/latest serves and the reconcile job repairs
// latest.json from.

import type { Kysely } from "kysely";
import type { Database } from "./database.ts";

/** The version map_head points at, or undefined before the first publish. */
export async function currentVersion(db: Kysely<Database>) {
  return db
    .selectFrom("map_head")
    .innerJoin("map_versions", "map_versions.id", "map_head.version_id")
    .select([
      "map_versions.id",
      "map_versions.published_at",
      "map_versions.snapshot_sha256",
      "map_versions.snapshot_uri",
      "map_versions.restores",
    ])
    .executeTakeFirst();
}
