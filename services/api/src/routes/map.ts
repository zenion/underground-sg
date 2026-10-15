// GET /map/latest: the version map_head points at and the URLs of its files, for the owner's tools
// on the LAN (MapLatestResponse in @usg/contracts). Public clients read latest.json, which can lag
// map_head until the reconcile job runs (docs/snapshot-format.md). Read-only, and nothing private:
// the publisher, the private export key and the note stay in the database. `demo: true` when the
// database holds the demo map (src/demo-flag.ts), as latest.json says.

import {
  type ErrorResponse,
  type MapLatestResponse,
  snapshotDirectory,
  type VersionFileName,
} from "@usg/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { responseSchema } from "../contract-schemas.ts";
import type { Database } from "../database.ts";
import { holdsDemo } from "../demo-flag.ts";
import { currentVersion } from "../map-head.ts";
import { singaporeDateTime } from "../time.ts";

/**
 * Where the public files are: `publicFilesUrl` when it is set, otherwise this API's /public/ at
 * the address the request came to, so a phone on the LAN gets URLs it can reach. Undefined when
 * the request's Host header doesn't make a URL.
 */
function publicBase(request: FastifyRequest, publicFilesUrl: string | undefined): URL | undefined {
  if (publicFilesUrl !== undefined) return new URL(publicFilesUrl);
  try {
    const base = new URL("/public/", `${request.protocol}://${request.host}`);
    return /^https?:$/.test(base.protocol) ? base : undefined;
  } catch {
    return undefined;
  }
}

export function mapRoutes(
  app: FastifyInstance,
  deps: { db: Kysely<Database>; publicFilesUrl: string | undefined },
): void {
  app.get(
    "/map/latest",
    {
      schema: {
        summary: "The current map version (map_head) and the URLs of its files",
        description:
          "For the owner's tools on the LAN. Public clients read latest.json, which can lag map_head until the reconcile job runs. 404 before the first publish. demo: true when the map is the demonstration data of pnpm demo.",
        tags: ["map"],
        response: {
          200: responseSchema("GET /map/latest"),
          400: responseSchema("error"),
          404: responseSchema("error"),
        },
      },
    },
    async (request, reply) => {
      const version = await currentVersion(deps.db);
      if (version === undefined) {
        const body: ErrorResponse = {
          statusCode: 404,
          error: "Not Found",
          message: "No map version has been published yet",
        };
        return reply.code(404).send(body);
      }
      const directory = snapshotDirectory(version.snapshot_sha256);
      if (version.snapshot_uri !== directory) {
        throw new Error(`map version ${version.id}: snapshot_uri does not match snapshot_sha256`);
      }
      const base = publicBase(request, deps.publicFilesUrl);
      if (base === undefined) {
        return reply.code(400).send({
          statusCode: 400,
          error: "Bad Request",
          message: "The Host header does not make a URL",
        } satisfies ErrorResponse);
      }
      const file = (name: VersionFileName) => {
        const path = `${directory}${name}`;
        return { path, url: new URL(path, base).href };
      };
      const body: MapLatestResponse = {
        version: version.id,
        published_at: singaporeDateTime(version.published_at),
        snapshot_sha256: version.snapshot_sha256,
        restores: version.restores,
        files: { indoor: file("indoor.json"), street: file("street.json") },
        ...((await holdsDemo(deps.db)) ? { demo: true as const } : {}),
      };
      reply.header("Cache-Control", "no-store");
      return body;
    },
  );
}
