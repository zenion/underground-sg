// The API process: `pnpm --filter @usg/api start` (node src/server.ts). Settings come from the
// root .env (copy .env.example) or the environment; see services/api/README.md.

import { loadRootEnv } from "@usg/scripts/env";
import { buildApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createDatabase } from "./database.ts";
import { createS3Storage } from "./storage.ts";

loadRootEnv();
let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}

const db = createDatabase(config.databaseUrl);
const storage = createS3Storage(config.s3, config.buckets);
const app = await buildApp({
  db,
  storage,
  corsOrigins: config.corsOrigins,
  publicFilesUrl: config.publicFilesUrl,
  logger: { level: process.env["LOG_LEVEL"] ?? "info" },
});
app.addHook("onClose", async () => {
  await db.destroy();
  storage.close();
});

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "shutting down");
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error(error, "shutdown failed");
        process.exit(1);
      },
    );
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
  if (!["127.0.0.1", "::1", "localhost"].includes(config.host)) {
    app.log.warn(
      { host: config.host },
      "listening beyond this machine: anyone on the network can read /health, /map/latest, /public and /glyphs",
    );
  }
} catch (error) {
  app.log.error(error, "could not start");
  await app.close();
  process.exit(1);
}
