// The webapp's build, served by the API for testing through one tunnel (API_WEB_DIST; see
// src/web-dist.ts and docs/phone-testing.md). GET and HEAD of `/` give index.html, and each file of
// the build listed at start-up has a route of its own; nothing else is looked up. A GET for any
// other path that asks for HTML (a reload of a page URL) gets index.html too, so the single-page
// app can take it from there, except under the API's own paths. Everything else is the usual 404.
// The routes are hidden from the OpenAPI document: they are not part of the API.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { acceptsEncoding } from "../public-files.ts";
import {
  acceptsHtml,
  HTML_HEADERS,
  isApiPath,
  requestPath,
  type WebDist,
  type WebFile,
} from "../web-dist.ts";
import { addVary, etagMatches } from "./public.ts";

function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  file: WebFile,
  html: boolean,
): FastifyReply {
  const br = file.brotli !== undefined && acceptsEncoding(request.headers["accept-encoding"], "br");
  const body = br && file.brotli !== undefined ? file.brotli : file.body;
  const etag = br ? file.etagBr : file.etag;
  reply
    .header("Content-Type", file.contentType)
    .header("Cache-Control", file.cacheControl)
    .header("X-Content-Type-Options", "nosniff")
    .header("ETag", etag);
  if (html) for (const [name, value] of Object.entries(HTML_HEADERS)) reply.header(name, value);
  if (file.brotli !== undefined) addVary(reply, "Accept-Encoding");
  if (br) reply.header("Content-Encoding", "br");
  if (etagMatches(request.headers["if-none-match"], etag)) return reply.code(304).send();
  reply.header("Content-Length", body.byteLength);
  return request.method === "HEAD" ? reply.send() : reply.send(body);
}

export function webRoutes(app: FastifyInstance, deps: { dist: WebDist }): void {
  const { dist } = deps;
  app.route({
    method: ["GET", "HEAD"],
    url: "/",
    schema: { hide: true },
    handler: async (request, reply) => sendFile(request, reply, dist.index, true),
  });
  for (const file of dist.files.values()) {
    app.route({
      method: ["GET", "HEAD"],
      url: file.urlPath,
      schema: { hide: true },
      handler: async (request, reply) =>
        sendFile(request, reply, file, file.contentType.startsWith("text/html")),
    });
  }
  app.setNotFoundHandler(async (request, reply) => {
    if (
      request.method === "GET" &&
      acceptsHtml(request.headers.accept) &&
      !isApiPath(requestPath(request.url))
    ) {
      return sendFile(request, reply, dist.index, true);
    }
    // What Fastify's own 404 handler sends.
    return reply.code(404).send({
      message: `Route ${request.method}:${request.url} not found`,
      error: "Not Found",
      statusCode: 404,
    });
  });
}
