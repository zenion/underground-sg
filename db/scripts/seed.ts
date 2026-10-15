// `pnpm db seed`: loads the core venues (db/seed/core-venues.ts) into HEAD on DATABASE_URL's
// database (the root .env). Safe to run again: it adds missing rows, writes only permission on
// existing venues, and reports where HEAD differs from the dataset without changing it. It refuses a
// database that holds the demo map: run `pnpm demo --reset` first.

import { unreachableMessage } from "@usg/scripts/errors";
import pg from "pg";
import { coreVenues } from "../seed/core-venues.ts";
import { databaseName, databaseUrl } from "../src/config.ts";
import { SeedError, seed } from "../src/seed.ts";

const url = databaseUrl();
const client = new pg.Client({ connectionString: url.href });
try {
  await client.connect();
  const report = await seed(client, coreVenues);
  const lines = [
    `Seeded ${coreVenues.name} into ${databaseName(url)}:`,
    `  venues added: ${report.insertedVenues.length}, levels added: ${report.insertedLevels.length}`,
    `  permission updated: ${report.permissionUpdated.length}`,
    `  venues removed: ${report.removedVenues.length}, levels removed: ${report.removedLevels.length}`,
    ...report.differences.map((line) => `  differs: ${line}`),
  ];
  console.log(lines.join("\n"));
  console.log(
    "Seeded rows reach the public files only inside a version that publishes a change set.",
  );
} catch (error) {
  const unreachable = unreachableMessage(error, [
    { name: "PostGIS", variable: "DATABASE_URL", url: url.href },
  ]);
  if (unreachable !== undefined) console.error(unreachable);
  else if (error instanceof SeedError) console.error(error.message);
  else throw error;
  process.exitCode = 1;
} finally {
  await client.end();
}
