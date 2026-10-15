// Recreating the developer's local database from the migrations: what `pnpm demo --reset` does,
// since map_versions and moderation_events are write-once and map_head only moves forward, so no
// rule lets their rows be deleted. Only for a database on this machine.

import { databaseName, isLocalHost } from "./config.ts";

export { isLocalHost, isLoopbackHost } from "./config.ts";

import { dbmateOrThrow } from "./dbmate.ts";
import { withMaintenance } from "./scratch.ts";

/**
 * Drops the database `url` names (closing its connections) and creates it again with every
 * migration applied, empty but for the rows the migrations insert. Refuses a server that isn't on
 * this machine, and the server's own maintenance databases.
 */
export async function recreateLocalDatabase(url: URL): Promise<void> {
  if (!isLocalHost(url)) {
    throw new Error(
      `Refusing to recreate a database on ${url.hostname} (or one its query parameters name): only on this machine`,
    );
  }
  const name = databaseName(url);
  if (name === "" || ["postgres", "template0", "template1", "template_postgis"].includes(name)) {
    throw new Error(`Refusing to recreate the database ${JSON.stringify(name)}`);
  }
  await withMaintenance(url, async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`);
  });
  dbmateOrThrow(["up", "--strict"], url);
}
