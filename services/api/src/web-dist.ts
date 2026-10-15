// The webapp's build (apps/web/dist), which the API serves when API_WEB_DIST names it: for testing
// on a phone through one tunnel to the API (docs/phone-testing.md), so Safari, the public files and
// the mapper app share one https origin. In production Cloudflare Pages serves the build instead
// (docs/decisions/0009-hosting-and-budget.md). The files are listed and read once at start-up, like
// the glyphs: a request is answered only by looking its path up in that list, so no part of a
// request ever becomes part of a file path.

import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants as zlib } from "node:zlib";
import { oneMapTiles } from "@usg/map-style";

/**
 * Paths the API's own routes answer. The webapp's files never take them (the build's glyphs/ is the
 * same files as GET /glyphs), and the SPA fallback never answers them with the page.
 */
export const API_PREFIXES = ["/public", "/map", "/health", "/glyphs", "/openapi.json"] as const;

/** Whether a request path (without its query) is one of the API's, at a path-segment boundary. */
export function isApiPath(path: string): boolean {
  return API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * The path of a request URL, without its query, percent-decoded as the router decodes it (so
 * `/%70ublic/...` counts as `/public/...`). Left as it is when it doesn't decode.
 */
export function requestPath(url: string): string {
  const raw = url.split(/[?#]/, 1)[0] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Whether an Accept header names text/html with a q-value above 0. `*\/*` alone doesn't count: a
 * script's fetch for a file that doesn't exist must get a 404, not the page.
 */
export function acceptsHtml(header: string | undefined): boolean {
  if (header === undefined) return false;
  return header.split(",").some((item) => {
    const [type = "", ...params] = item.split(";");
    if (type.trim().toLowerCase() !== "text/html") return false;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
      if (match?.[1] !== undefined) return Number(match[1]) > 0;
    }
    return true;
  });
}

/** OneMap's origin, which serves the basemap tiles and the logo in its attribution. */
export const ONEMAP_ORIGIN = new URL(oneMapTiles("Grey", true)).origin;

/**
 * The page's Content-Security-Policy: what MapLibre GL JS and OneMap need, and nothing else. Scripts,
 * styles and the map worker come from this origin (MapLibre may also start its worker from a blob:
 * URL); tiles are fetched from OneMap and decoded as images (blob: or bitmaps); the logo is
 * OneMap's; MapLibre's CSS draws its control icons as data: SVGs; the map files and glyphs are
 * this origin's. No inline script or style, no plugins, no framing.
 */
export function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src 'self' data: blob: ${ONEMAP_ORIGIN}`,
    `connect-src 'self' ${ONEMAP_ORIGIN}`,
    "worker-src 'self' blob:",
    // Safari before 15.5 checks workers against child-src.
    "child-src 'self' blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Headers for the page itself (index.html, also as the SPA fallback). */
export const HTML_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": contentSecurityPolicy(),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/** Vite's hashed output: `assets/<name>-<8 character hash>.<ext>`, safe to cache for good. */
const HASHED_ASSET = /^\/assets\/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;

export const IMMUTABLE = "public, max-age=31536000, immutable";
/** Revalidate on every use (with the ETag): index.html and anything unhashed. */
export const NO_CACHE = "no-cache";

/** The file types the build has; a file of any other type is not served. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  map: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
  webmanifest: "application/manifest+json",
};

/** Types worth compressing: text. Images and fonts are compressed already. */
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json)|image\/svg\+xml)/;

/** A path segment the build may have: letters, digits, dot, dash, underscore; not hidden. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** Stops a wrong API_WEB_DIST (a home directory, say) from being read into memory. */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface WebFile {
  /** The URL path it is served at, such as /assets/index-CmYQp6-y.js. */
  readonly urlPath: string;
  readonly contentType: string;
  readonly cacheControl: string;
  readonly body: Buffer;
  /** A strong entity tag for `body`; the brotli representation has its own (`etagBr`). */
  readonly etag: string;
  /** The body brotli-compressed, when that saves at least a tenth. */
  readonly brotli: Buffer | undefined;
  readonly etagBr: string;
}

export class WebDistError extends Error {
  override name = "WebDistError";
}

/** The build: index.html (served at /) and every other file it may serve, by URL path. */
export interface WebDist {
  readonly index: WebFile;
  readonly files: ReadonlyMap<string, WebFile>;
}

function webFile(
  urlPath: string,
  body: Buffer,
  contentType: string,
  cacheControl: string,
): WebFile {
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 32);
  let brotli: Buffer | undefined;
  if (COMPRESSIBLE.test(contentType) && body.byteLength > 512) {
    const compressed = brotliCompressSync(body, {
      params: {
        // Quality 9 compresses about as well as 11 for this kind of file, many times faster, so
        // start-up stays quick.
        [zlib.BROTLI_PARAM_QUALITY]: 9,
        [zlib.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
      },
    });
    if (compressed.byteLength <= body.byteLength * 0.9) brotli = compressed;
  }
  return {
    urlPath,
    contentType,
    cacheControl,
    body,
    etag: `"${hash}"`,
    brotli,
    etagBr: `"${hash}-br"`,
  };
}

/**
 * Lists and reads the build in `dir` (apps/web/dist). Skips what it won't serve: hidden files,
 * names with other characters, symbolic links, unknown types, and anything under an API path.
 * Throws WebDistError when there is no index.html, or the directory holds far more than a build.
 */
export function loadWebDist(dir: string): WebDist {
  const root = resolve(dir);
  const files = new Map<string, WebFile>();
  let total = 0;
  let index: WebFile | undefined;

  const visit = (directory: string, segments: readonly string[]): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new WebDistError(
        `API_WEB_DIST must name the webapp's build directory (${(error as NodeJS.ErrnoException).code ?? "unreadable"})`,
      );
    }
    for (const entry of entries) {
      if (!SAFE_SEGMENT.test(entry.name)) continue;
      const path = [...segments, entry.name];
      const urlPath = `/${path.join("/")}`;
      if (isApiPath(urlPath)) continue;
      if (entry.isDirectory()) {
        visit(join(directory, entry.name), path);
        continue;
      }
      // Dirent.isFile() is false for a symbolic link, which is never followed.
      if (!entry.isFile()) continue;
      const extension = entry.name.includes(".") ? entry.name.split(".").pop() : undefined;
      const contentType = extension === undefined ? undefined : CONTENT_TYPES[extension];
      if (contentType === undefined) continue;
      const body = readFileSync(join(directory, entry.name));
      total += body.byteLength;
      if (total > MAX_TOTAL_BYTES) {
        throw new WebDistError(
          `API_WEB_DIST holds more than ${MAX_TOTAL_BYTES / 1024 / 1024} MB of files: is it the webapp's build directory?`,
        );
      }
      if (urlPath === "/index.html") {
        index = webFile("/", body, contentType, NO_CACHE);
        continue;
      }
      const cacheControl = HASHED_ASSET.test(urlPath) ? IMMUTABLE : NO_CACHE;
      files.set(urlPath, webFile(urlPath, body, contentType, cacheControl));
    }
  };

  visit(root, []);
  if (index === undefined) {
    throw new WebDistError(
      "API_WEB_DIST must name the webapp's build directory, with index.html: build it with `pnpm --filter @usg/web build`",
    );
  }
  return { index, files };
}
