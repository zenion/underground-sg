// The HTTP API's documents (services/api/README.md): the response bodies of services/api's
// routes, described by the schemas in schemas/api/. Environment-neutral: the mapper app and the
// webapp read these types too.

import type { HealthProblem } from "./generated/contracts.ts";
import { SCHEMA_BASE_URL } from "./schema-ids.ts";

/** Base of the API schemas' `$id`s. */
export const API_SCHEMA_BASE_URL = `${SCHEMA_BASE_URL}api/`;

/**
 * The schema file of each API document, keyed by the route it answers (`error` is the body of
 * every 4xx and 5xx response).
 */
export const API_SCHEMA_FILES = {
  "GET /health": "health.schema.json",
  "GET /map/latest": "map-latest.schema.json",
  error: "error.schema.json",
} as const;

/** An API document that has a schema. */
export type ApiDocumentName = keyof typeof API_SCHEMA_FILES;

/** Why a `GET /health` check failed (`HealthProblem`). */
export const HEALTH_PROBLEMS = [
  "unreachable",
  "timeout",
  "access_denied",
  "not_migrated",
  "missing_bucket",
  "error",
] as const satisfies readonly HealthProblem[];
