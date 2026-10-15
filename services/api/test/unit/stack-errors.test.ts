// When the local stack isn't answering: the S3 client gives up rather than waiting for ever, and
// the CLIs' message for a refused connection names the service, its host and port, and the fix,
// never a credential (unreachableMessage from @usg/scripts/errors). Real sockets on this machine,
// no stack needed.

import { createServer, type Server, type Socket } from "node:net";
import { unreachableMessage } from "@usg/scripts/errors";
import { sql } from "kysely";
import { afterAll, describe, expect, test } from "vitest";
import { stackServices } from "../../src/config.ts";
import { createDatabase } from "../../src/database.ts";
import { classify } from "../../src/routes/health.ts";
import { createS3Storage } from "../../src/storage.ts";

const servers: Server[] = [];
const sockets: Socket[] = [];
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

/** A port on 127.0.0.1 where `server` listens, or where nothing does once it is closed. */
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const s3 = (endpoint: string) => ({
  endpoint,
  region: "us-east-1",
  accessKeyId: "usg-local",
  secretAccessKey: "s3-secret-never-shown",
});
const BUCKETS = { bundles: "b", exports: "e", public: "p" };

describe("the S3 client", () => {
  test("gives up on an endpoint that accepts connections and never answers", async () => {
    const server = createServer((socket) => {
      sockets.push(socket);
    });
    servers.push(server);
    const port = await listen(server);
    const storage = createS3Storage(s3(`http://127.0.0.1:${port}`), BUCKETS, {
      connectionMs: 500,
      requestMs: 300,
    });
    try {
      const started = Date.now();
      const error = await storage.buckets.public.get("latest.json").then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      expect(Date.now() - started).toBeLessThan(10_000);
      // What the API's error handler turns into a 503.
      expect(classify(error)).toBe("timeout");
    } finally {
      storage.close();
    }
  });
});

describe("unreachableMessage", () => {
  test("names PostGIS's host and port for a refused database connection, never the password", async () => {
    const [dbPort, s3Port] = [await closedPort(), await closedPort()];
    const config = {
      databaseUrl: `postgres://usg:db-secret-never-shown@127.0.0.1:${dbPort}/usg`,
      s3: s3(`http://127.0.0.1:${s3Port}`),
    };
    const db = createDatabase(config.databaseUrl, { maxConnections: 1 });
    try {
      const error = await sql`SELECT 1`.execute(db).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      const message = unreachableMessage(error, stackServices(config));
      expect(message).toBe(
        `Nothing is listening on 127.0.0.1:${dbPort} (PostGIS, DATABASE_URL). Start the local stack with \`docker compose up -d --wait\`.`,
      );
      expect(message).not.toContain("db-secret-never-shown");
    } finally {
      await db.destroy();
    }
  });

  test("names RustFS's for a refused S3 connection", async () => {
    const [dbPort, s3Port] = [await closedPort(), await closedPort()];
    const config = {
      databaseUrl: `postgres://usg:x@127.0.0.1:${dbPort}/usg`,
      s3: s3(`http://127.0.0.1:${s3Port}`),
    };
    const storage = createS3Storage(config.s3, BUCKETS);
    try {
      const error = await storage.buckets.public.get("latest.json").then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(unreachableMessage(error, stackServices(config))).toBe(
        `Nothing is listening on 127.0.0.1:${s3Port} (RustFS, S3_ENDPOINT). Start the local stack with \`docker compose up -d --wait\`.`,
      );
    } finally {
      storage.close();
    }
  });

  test("is undefined for any other error", () => {
    expect(unreachableMessage(new Error("syntax error"), [])).toBeUndefined();
  });
});
