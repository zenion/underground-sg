// GET /health: whether the API reaches PostGIS and the object store, with the versions it runs
// with (HealthResponse in @usg/contracts). A failed check reports only a problem code; the details
// go to the log, so the response never carries a connection string, a credential or an endpoint.

import {
  type HealthDatabase,
  type HealthProblem,
  type HealthResponse,
  type HealthStorage,
  SNAPSHOT_SCHEMA_VERSION,
} from "@usg/contracts";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { type Kysely, sql } from "kysely";
import packageJson from "../../package.json" with { type: "json" };
import { responseSchema } from "../contract-schemas.ts";
import type { Database } from "../database.ts";
import type { Storage } from "../storage.ts";

/** How long each check may take before it counts as failed. */
export const HEALTH_CHECK_TIMEOUT_MS = 3_000;

class CheckTimeout extends Error {
  override name = "CheckTimeout";
}

/** `promise`, or a CheckTimeout after `ms`. A late rejection is swallowed. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  promise.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CheckTimeout()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The codes of an error and the errors it wraps (AggregateError, `cause`). */
function errorCodes(error: unknown, depth = 0): string[] {
  if (typeof error !== "object" || error === null || depth > 5) return [];
  const { code, name, errors, cause } = error as {
    code?: unknown;
    name?: unknown;
    errors?: unknown;
    cause?: unknown;
  };
  const codes = [code, name].filter((value): value is string => typeof value === "string");
  if (Array.isArray(errors)) codes.push(...errors.flatMap((e) => errorCodes(e, depth + 1)));
  codes.push(...errorCodes(cause, depth + 1));
  return codes;
}

const TIMED_OUT = ["TimeoutError", "ETIMEDOUT"];
const UNREACHABLE = ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET", "EAI_AGAIN"];
/**
 * PostgreSQL's invalid_password and invalid_authorization_specification; S3's refusals of a key
 * or a signature.
 */
const DENIED = [
  "28P01",
  "28000",
  "AccessDenied",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "Forbidden",
];

/** A problem code for a failed check, from the error's codes (and those of errors it wraps). */
export function classify(error: unknown): HealthProblem {
  const codes = errorCodes(error);
  const any = (list: readonly string[]) => codes.some((code) => list.includes(code));
  if (error instanceof CheckTimeout || any(TIMED_OUT)) return "timeout";
  if (any(UNREACHABLE)) return "unreachable";
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  if (any(DENIED) || status === 403) return "access_denied";
  // invalid_catalog_name: the database doesn't exist, so `pnpm migrate` hasn't run.
  if (codes.includes("3D000")) return "not_migrated";
  // node-postgres's pool reports its connection timeout only in the message.
  if (error instanceof Error && /timeout/i.test(error.message)) return "timeout";
  return "error";
}

function logFailure(log: FastifyBaseLogger, check: string, error: unknown): void {
  const { name, code, message } = (error ?? {}) as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };
  log.warn({ check, name, code, message }, "health check failed");
}

export async function checkDatabase(
  db: Kysely<Database>,
  log: FastifyBaseLogger,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
): Promise<HealthDatabase> {
  try {
    return await within(
      (async (): Promise<HealthDatabase> => {
        const { rows } = await sql<{
          postgres: string;
          postgis: string | null;
          migrated: boolean;
        }>`SELECT current_setting('server_version') AS postgres,
                  (SELECT extversion FROM pg_extension WHERE extname = 'postgis') AS postgis,
                  to_regclass('public.schema_migrations') IS NOT NULL AS migrated`.execute(db);
        const row = rows[0];
        if (row === undefined) throw new Error("no row");
        let migration: string | null = null;
        if (row.migrated) {
          const latest = await sql<{
            version: string | null;
          }>`SELECT max(version) AS version FROM schema_migrations`.execute(db);
          migration = latest.rows[0]?.version ?? null;
        }
        const ok = migration !== null && row.postgis !== null;
        return {
          ok,
          problem: ok ? null : "not_migrated",
          postgres: row.postgres,
          postgis: row.postgis,
          migration,
        };
      })(),
      timeoutMs,
    );
  } catch (error) {
    logFailure(log, "database", error);
    return { ok: false, problem: classify(error), postgres: null, postgis: null, migration: null };
  }
}

export async function checkStorage(
  storage: Storage,
  log: FastifyBaseLogger,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
): Promise<HealthStorage> {
  const signal = AbortSignal.timeout(timeoutMs);
  const [server, ...results] = await Promise.all([
    within(storage.serverVersion(signal), timeoutMs).catch(() => undefined),
    ...(["bundles", "exports", "public"] as const).map((role) =>
      within(storage.buckets[role].exists(signal), timeoutMs).then(
        (exists) => ({ role, exists, error: undefined }),
        (error: unknown) => ({ role, exists: false, error }),
      ),
    ),
  ]);
  const buckets = { bundles: false, exports: false, public: false };
  let problem: HealthProblem | null = null;
  for (const result of results) {
    buckets[result.role] = result.exists;
    if (result.error !== undefined) {
      logFailure(log, `storage.${result.role}`, result.error);
      problem ??= classify(result.error);
    }
  }
  if (problem === null && results.some((result) => !result.exists)) problem = "missing_bucket";
  return { ok: problem === null, problem, server: server ?? null, buckets };
}

export function healthRoutes(
  app: FastifyInstance,
  deps: { db: Kysely<Database>; storage: Storage },
): void {
  app.get(
    "/health",
    {
      schema: {
        summary: "Whether the API reaches PostGIS and the object store",
        description:
          "200 when every check passes, 503 otherwise, with the same body. Never carries credentials, connection strings or bucket names.",
        tags: ["health"],
        response: { 200: responseSchema("GET /health"), 503: responseSchema("GET /health") },
      },
    },
    async (request, reply) => {
      const [database, storage] = await Promise.all([
        checkDatabase(deps.db, request.log),
        checkStorage(deps.storage, request.log),
      ]);
      const ok = database.ok && storage.ok;
      const body: HealthResponse = {
        status: ok ? "ok" : "unavailable",
        api: {
          version: packageJson.version,
          node: process.version,
          snapshot_schema_version: SNAPSHOT_SCHEMA_VERSION,
        },
        database,
        storage,
      };
      reply.header("Cache-Control", "no-store");
      return reply.code(ok ? 200 : 503).send(body);
    },
  );
}
