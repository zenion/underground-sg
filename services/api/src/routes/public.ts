// GET /public/*: the local stand-in for Cloudflare, serving the public bucket read-only on the
// owner's PC (docs/snapshot-format.md, "Layout"). Only the documented files are served, with the
// Content-Type and Cache-Control the format gives them. Version files are stored brotli-compressed
// (Content-Encoding: br); a client that accepts br gets the stored bytes, any other gets them
// decompressed. No listing, no writes, no other keys. The store gets PUBLIC_FILE_TIMEOUT_MS to start
// answering; past that the request is a 503 rather than a wait without end.

import { pipeline, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip } from "node:zlib";
import type { ErrorResponse } from "@usg/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { responseSchema } from "../contract-schemas.ts";
import { acceptsEncoding, publicFile } from "../public-files.ts";
import type { ObjectMetadata, ObjectStore } from "../storage.ts";

/** How long the object store may take to start answering (its headers, not the whole body). */
export const PUBLIC_FILE_TIMEOUT_MS = 10_000;

/** The object store didn't start answering in time. */
export class StorageTimeoutError extends Error {
  override name = "TimeoutError";
}

/**
 * `run(signal)`, or a StorageTimeoutError after `ms`, aborting `signal` so the store can stop.
 * A late result is handed to `discard`, so a body that arrives after all is closed.
 */
async function beforeDeadline<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
  discard: (late: T) => void,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const running = run(controller.signal);
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const error = new StorageTimeoutError(`the object store did not answer within ${ms} ms`);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  running.then(
    (late) => {
      if (timedOut) discard(late);
    },
    () => {},
  );
  try {
    return await Promise.race([running, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Adds a header to Vary, keeping what is there (CORS's Origin). */
export function addVary(reply: FastifyReply, header: string): void {
  const current = reply.getHeader("vary");
  const values = (Array.isArray(current) ? current.join(",") : String(current ?? ""))
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (!values.some((value) => value.toLowerCase() === header.toLowerCase())) values.push(header);
  reply.header("Vary", values.join(", "));
}

/** Stored content codings this route can remove for a client that doesn't accept them. */
const DECODERS: Readonly<Record<string, () => Transform>> = {
  br: createBrotliDecompress,
  gzip: createGunzip,
};

function notFound(reply: FastifyReply): FastifyReply {
  const body: ErrorResponse = { statusCode: 404, error: "Not Found", message: "No such file" };
  return reply.code(404).send(body);
}

/** Whether If-None-Match names the entity tag (weak comparison, RFC 9110 section 13.1.2). */
export function etagMatches(ifNoneMatch: string | undefined, etag: string | undefined): boolean {
  if (ifNoneMatch === undefined || etag === undefined) return false;
  const strip = (tag: string) => tag.trim().replace(/^W\//, "");
  const wanted = strip(etag);
  return ifNoneMatch.split(",").some((tag) => tag.trim() === "*" || strip(tag) === wanted);
}

export function publicRoutes(
  app: FastifyInstance,
  deps: { store: ObjectStore; timeoutMs: number },
): void {
  app.route({
    method: ["GET", "HEAD"],
    url: "/public/*",
    schema: {
      summary: "The public map files (local stand-in for Cloudflare R2)",
      description:
        "latest.json, status.json and snapshots/<snapshot_sha256>/indoor.json or street.json, read-only. Version files are stored brotli-compressed: sent with Content-Encoding: br when the request accepts it, decompressed otherwise.",
      tags: ["public files"],
      response: {
        200: {
          description:
            "The file, as stored or decompressed (see Content-Encoding). Its format is in docs/snapshot-format.md and the schemas in packages/contracts/schemas/snapshot/.",
          content: {
            "application/json": {
              schema: { description: "latest.json or status.json" },
            },
            "application/geo+json": {
              schema: { description: "indoor.json or street.json of a version" },
            },
          },
        },
        304: { description: "Not modified (If-None-Match)", type: "null" },
        404: responseSchema("error"),
        406: responseSchema("error"),
      },
    },
    handler: async (request, reply) => {
      const path = (request.params as Record<string, string | undefined>)["*"] ?? "";
      const file = publicFile(path);
      if (file === undefined) return notFound(reply);

      const head = request.method === "HEAD";
      let meta: ObjectMetadata | undefined;
      let body: NodeJS.ReadableStream | undefined;
      if (head) {
        meta = await beforeDeadline(
          deps.timeoutMs,
          (signal) => deps.store.head(file.key, signal),
          () => {},
        );
      } else {
        const object = await beforeDeadline(
          deps.timeoutMs,
          (signal) => deps.store.get(file.key, signal),
          (late) => late?.body.destroy(),
        );
        meta = object;
        body = object?.body;
      }
      if (meta === undefined) return notFound(reply);
      const discard = () => (body as { destroy?: () => void } | undefined)?.destroy?.();

      const stored = meta.contentEncoding;
      const decoder = stored === undefined ? undefined : DECODERS[stored];
      const sendStored =
        stored === undefined || acceptsEncoding(request.headers["accept-encoding"], stored);
      if (!sendStored && decoder === undefined) {
        discard();
        const error: ErrorResponse = {
          statusCode: 406,
          error: "Not Acceptable",
          message: `The file is stored with Content-Encoding ${stored}, which the request does not accept`,
        };
        return reply.code(406).send(error);
      }

      reply
        .header("Content-Type", file.contentType)
        .header("Cache-Control", file.cacheControl)
        .header("X-Content-Type-Options", "nosniff");
      // Added to CORS's Vary: Origin, never in its place, or a cache could hand one origin's
      // response to another.
      if (stored !== undefined) addVary(reply, "Accept-Encoding");

      if (sendStored) {
        if (stored !== undefined) reply.header("Content-Encoding", stored);
        if (meta.etag !== undefined) reply.header("ETag", meta.etag);
        if (meta.lastModified !== undefined) {
          reply.header("Last-Modified", meta.lastModified.toUTCString());
        }
        if (etagMatches(request.headers["if-none-match"], meta.etag)) {
          discard();
          return reply.code(304).send();
        }
        if (meta.contentLength !== undefined) reply.header("Content-Length", meta.contentLength);
        return head ? reply.send() : reply.send(body);
      }

      // The client doesn't accept the stored coding: decode it here. The entity differs from the
      // stored one, so it gets no ETag and no Content-Length.
      if (head || body === undefined || decoder === undefined) return reply.send();
      const decoded = pipeline(body, decoder(), (error) => {
        if (error !== undefined && error !== null && error.code !== "ERR_STREAM_PREMATURE_CLOSE") {
          request.log.warn({ key: file.key, code: error.code }, "decoding a public file failed");
        }
      });
      return reply.send(decoded);
    },
  });
}
