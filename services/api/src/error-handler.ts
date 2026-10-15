// What a failed request sends back. A client error (4xx: an unknown route, a body too large) goes
// out as Fastify sends it. A server error never carries its cause: a database or S3 error message
// names hosts, ports, the database user and the store's own error text, and a contract violation
// names schema fields, so the body is the bare status and the details go to the log only. An error
// that says PostGIS or the object store can't be reached or timed out is 503, anything else 500.

import { STATUS_CODES } from "node:http";
import type { ErrorResponse } from "@usg/contracts";
import type { FastifyInstance } from "fastify";
import { classify } from "./routes/health.ts";

/** The status an error asks for, if it names one (Fastify's own errors, http-errors). */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { statusCode } = error as { statusCode?: unknown };
  return typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : undefined;
}

/** The body of a 5xx response: the status, nothing about the cause. */
export function serverErrorBody(statusCode: 500 | 503): ErrorResponse {
  const text = STATUS_CODES[statusCode] ?? "Internal Server Error";
  return { statusCode, error: text, message: text };
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const status = statusOf(error);
    if (status !== undefined && status < 500) {
      // Fastify's default handler takes it from here, as before.
      return reply.send(error);
    }
    const problem = classify(error);
    const statusCode = problem === "unreachable" || problem === "timeout" ? 503 : 500;
    const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
    request.log.error({ name, code, message, problem }, "request failed");
    // Headers a route set for the body it meant to send don't describe this one.
    for (const header of ["content-encoding", "etag", "last-modified"]) reply.removeHeader(header);
    return reply
      .code(statusCode)
      .header("Cache-Control", "no-store")
      .type("application/json; charset=utf-8")
      .send(JSON.stringify(serverErrorBody(statusCode)));
  });
}
