// Serves @usg/map-style's glyph PBFs at /glyphs/ (packages/map-style/glyphs/README.md, "Serving
// them"): from the package directory in the dev server, and copied into the build output, so the
// style's text layers render with the package's glyphs and no third-party glyph server. The font's
// licence (OFL.txt) ships with the glyphs.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Connect, Plugin } from "vite";

/** Where the app serves the glyphs: the style's URL template is `/glyphs/{fontstack}/{range}.pbf`. */
export const GLYPHS_PATH = "glyphs";

/** The package's glyphs directory, found through its `./glyphs/*` export. */
export function glyphsDirectory(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("@usg/map-style/glyphs/OFL.txt"));
}

/** The font stack directories in the glyphs directory and their PBF files. */
export function glyphFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of readdirSync(join(directory, entry.name))) {
      if (file.endsWith(".pbf")) files.push(`${entry.name}/${file}`);
    }
  }
  return files.sort();
}

const FONT_STACK = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;
const RANGE = /^\d+-\d+\.pbf$/;

/**
 * The file a request below /glyphs/ names, relative to the glyphs directory, or undefined for
 * anything that isn't `<font stack>/<start>-<end>.pbf` or `OFL.txt`. Font stack names are plain
 * words, so a request can't climb out of the directory.
 */
export function glyphRequestFile(urlPath: string): string | undefined {
  const path = urlPath.split(/[?#]/)[0] ?? "";
  let segments: string[];
  try {
    segments = path.replace(/^\/+/, "").split("/").map(decodeURIComponent);
  } catch {
    return undefined;
  }
  if (segments.length === 1 && segments[0] === "OFL.txt") return "OFL.txt";
  const [fontStack, range] = segments;
  if (segments.length !== 2 || fontStack === undefined || range === undefined) return undefined;
  return FONT_STACK.test(fontStack) && RANGE.test(range) ? `${fontStack}/${range}` : undefined;
}

function contentType(file: string): string {
  return file.endsWith(".pbf") ? "application/x-protobuf" : "text/plain; charset=utf-8";
}

/** Connect middleware for /glyphs/: the package's files, or 404. */
export function glyphsMiddleware(directory: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const file = glyphRequestFile(req.url ?? "");
    const path = file === undefined ? undefined : join(directory, file);
    if (path === undefined || !statSync(path, { throwIfNoEntry: false })?.isFile()) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("No such glyph range\n");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType(path));
    res.setHeader("Cache-Control", "no-cache");
    res.end(req.method === "HEAD" ? undefined : readFileSync(path));
  };
}

/** The Vite plugin: /glyphs/ in the dev and preview servers, and glyphs/ in the build output. */
export function mapGlyphs(): Plugin {
  const directory = glyphsDirectory();
  return {
    name: "usg:map-glyphs",
    configureServer(server) {
      server.middlewares.use(`/${GLYPHS_PATH}`, glyphsMiddleware(directory));
    },
    generateBundle() {
      for (const file of [...glyphFiles(directory), "OFL.txt"]) {
        this.emitFile({
          type: "asset",
          fileName: `${GLYPHS_PATH}/${file}`,
          source: readFileSync(join(directory, file)),
        });
      }
    },
  };
}
