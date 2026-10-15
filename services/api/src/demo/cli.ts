// `pnpm demo` publishes the demo dataset to the local stack; `pnpm demo --reset` wipes it so the
// demo can run again. See demo.ts, and services/api/README.md ("The demo"). It reads only
// DATABASE_URL and S3_*, like `pnpm map`; API_HOST and API_PORT only for the URLs it prints, and
// leniently.

import { recreateLocalDatabase } from "@usg/db/local";
import { loadRootEnv } from "@usg/scripts/env";
import { unreachableMessage } from "@usg/scripts/errors";
import {
  apiAddressForDisplay,
  ConfigError,
  loadStackConfig,
  type StackConfig,
  stackServices,
} from "../config.ts";
import { createDatabase } from "../database.ts";
import { GatesRefusedError } from "../publish/gates.ts";
import { ReconcileError } from "../publish/pointer.ts";
import { PublishRefusedError } from "../publish/publish.ts";
import { createS3Storage } from "../storage.ts";
import { assertLocalStack, DemoRefusedError, resetDemo, runDemo } from "./demo.ts";

const USAGE = "usage: pnpm demo [--reset]";

loadRootEnv();
const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== "--reset");
if (unknown.length > 0) {
  console.error(`Unknown argument ${unknown[0]}. ${USAGE}`);
  process.exit(2);
}
const reset = args.includes("--reset");

let config: StackConfig | undefined;
try {
  config = loadStackConfig();
  assertLocalStack(config);
  if (reset) {
    const result = await resetDemo(config, recreateLocalDatabase);
    console.log("Demo reset: the local database was recreated from the migrations.");
    for (const key of result.deleted) console.log(`  deleted ${key}`);
    console.log("Run `pnpm demo` to publish it again.");
  } else {
    const db = createDatabase(config.databaseUrl, { maxConnections: 4 });
    const storage = createS3Storage(config.s3, config.buckets);
    try {
      const result = await runDemo(db, storage);
      for (const step of result.steps) console.log(`- ${step}`);
      const api = apiAddressForDisplay();
      console.log(
        [
          `Demo map version ${result.version} (snapshot ${result.snapshotSha256}).`,
          "With the API running (`pnpm api`):",
          `  ${api}/map/latest`,
          `  ${api}/public/latest.json`,
          `  ${api}/public/snapshots/${result.snapshotSha256}/indoor.json`,
          `  ${api}/public/snapshots/${result.snapshotSha256}/street.json`,
        ].join("\n"),
      );
    } finally {
      await db.destroy();
      storage.close();
    }
  }
} catch (error) {
  const unreachable =
    config === undefined ? undefined : unreachableMessage(error, stackServices(config));
  if (unreachable !== undefined) {
    console.error(unreachable);
    process.exitCode = 1;
  } else if (
    error instanceof ConfigError ||
    error instanceof DemoRefusedError ||
    error instanceof PublishRefusedError ||
    error instanceof GatesRefusedError ||
    error instanceof ReconcileError
  ) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
