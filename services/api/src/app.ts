// Builds the Fastify instance. server.ts listens with it; tests call `buildApp` and use
// `app.inject`. Every route is read-only and safe on the LAN: GET /health, GET /map/latest, the
// public files (GET /public/*), the glyphs (GET /glyphs/...) and the OpenAPI document
// (GET /openapi.json). Publishing is not an HTTP route: heavy work never runs in the API process
// (CLAUDE.md), and the publish runs as a library function from a CLI, later from a worker.

import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Kysely } from "kysely";
import packageJson from "../package.json" with { type: "json" };
import { contractSerializerCompiler } from "./contract-schemas.ts";
import type { Database } from "./database.ts";
import { installErrorHandler } from "./error-handler.ts";
import { GlyphIndex, mapStyleGlyphsDir } from "./glyphs.ts";
import { glyphRoutes } from "./routes/glyphs.ts";
import { healthRoutes } from "./routes/health.ts";
import { mapRoutes } from "./routes/map.ts";
import { PUBLIC_FILE_TIMEOUT_MS, publicRoutes } from "./routes/public.ts";
import type { Storage } from "./storage.ts";

export interface AppOptions {
  readonly db: Kysely<Database>;
  readonly storage: Storage;
  /** Origins allowed to read responses from a browser or WebView. */
  readonly corsOrigins: readonly string[];
  /** Where the public files are served (ending in /), or undefined for this API's /public/. */
  readonly publicFilesUrl?: string | undefined;
  /** The glyphs directory; @usg/map-style's by default. */
  readonly glyphsDir?: string;
  /**
   * How long GET /public/* waits for the object store to start answering before it gives up with
   * a 503; PUBLIC_FILE_TIMEOUT_MS by default.
   */
  readonly publicFileTimeoutMs?: number;
  /** Fastify's logger option: false (the default) in tests. */
  readonly logger?: FastifyServerOptions["logger"];
}

/**
 * The API, ready to listen or to `inject` requests into. The caller owns `db` and `storage` and
 * closes them after `app.close()`.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    // Requests carry no bodies (GET and HEAD only); refuse anything large early.
    bodyLimit: 1024,
    // Behind nothing on the owner's PC: never trust X-Forwarded-* headers.
    trustProxy: false,
  });
  app.setSerializerCompiler(contractSerializerCompiler());
  installErrorHandler(app);

  await app.register(cors, {
    origin: [...options.corsOrigins],
    methods: ["GET", "HEAD"],
    // Lets a page read the stored coding and the cache headers of the public files.
    exposedHeaders: ["Content-Encoding", "Cache-Control", "ETag"],
    maxAge: 600,
  });
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Underground SG API",
        description:
          "Read-only routes of services/api. Response bodies follow the JSON Schemas in packages/contracts (schemas/api/).",
        version: packageJson.version,
      },
      tags: [
        { name: "health", description: "Whether the API reaches its services" },
        { name: "map", description: "The published map, for the owner's tools on the LAN" },
        { name: "public files", description: "Local stand-in for the public files on Cloudflare" },
        { name: "map style", description: "Files the map style loads" },
      ],
    },
  });

  healthRoutes(app, { db: options.db, storage: options.storage });
  mapRoutes(app, { db: options.db, publicFilesUrl: options.publicFilesUrl });
  publicRoutes(app, {
    store: options.storage.buckets.public,
    timeoutMs: options.publicFileTimeoutMs ?? PUBLIC_FILE_TIMEOUT_MS,
  });
  glyphRoutes(app, { glyphs: new GlyphIndex(options.glyphsDir ?? mapStyleGlyphsDir()) });
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  return app;
}
