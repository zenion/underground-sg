// GET /glyphs/:fontstack/:range.pbf: the glyph PBFs of @usg/map-style, so the mapper app's
// WebView (and the webapp in development) can load them over the LAN with the style's
// `glyphs: "<api>/glyphs/{fontstack}/{range}.pbf"`. Only files listed at start-up are served
// (GlyphIndex): the request's font stack and file name are looked up, never joined into a path.

import { readFile } from "node:fs/promises";
import type { ErrorResponse } from "@usg/contracts";
import type { FastifyInstance } from "fastify";
import { responseSchema } from "../contract-schemas.ts";
import type { GlyphIndex } from "../glyphs.ts";

/** The files change only with the package, but a day keeps a newly added range from hiding. */
export const GLYPH_CACHE_CONTROL = "public, max-age=86400";

export function glyphRoutes(app: FastifyInstance, deps: { glyphs: GlyphIndex }): void {
  app.get(
    "/glyphs/:fontstack/:file",
    {
      schema: {
        summary: "Glyph PBFs for MapLibre text layers (@usg/map-style)",
        description:
          "For example /glyphs/Noto%20Sans%20Regular/0-255.pbf. Only the font stacks and 256-code-point ranges that @usg/map-style ships.",
        tags: ["map style"],
        params: {
          type: "object",
          properties: {
            fontstack: { type: "string", description: "A font stack, such as Noto Sans Regular" },
            file: { type: "string", description: "A range file, such as 0-255.pbf" },
          },
          required: ["fontstack", "file"],
        },
        response: {
          200: {
            description: "The glyph PBF: a protocol buffer of signed distance field glyphs",
            content: {
              "application/x-protobuf": {
                schema: { description: "Binary (protocol buffer)" },
              },
            },
          },
          404: responseSchema("error"),
        },
      },
    },
    async (request, reply) => {
      const { fontstack, file } = request.params as { fontstack: string; file: string };
      const path = deps.glyphs.path(fontstack, file);
      if (path === undefined) {
        const body: ErrorResponse = {
          statusCode: 404,
          error: "Not Found",
          message: "No such glyphs",
        };
        return reply.code(404).send(body);
      }
      const bytes = await readFile(path);
      return reply
        .header("Content-Type", "application/x-protobuf")
        .header("Cache-Control", GLYPH_CACHE_CONTROL)
        .header("X-Content-Type-Options", "nosniff")
        .send(bytes);
    },
  );
}
