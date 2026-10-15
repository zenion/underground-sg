// The webapp's build served by the API (API_WEB_DIST, for testing through one tunnel): the files
// listed at start-up and nothing else, traversal attempts, the SPA fallback's rules, caching and the
// page's security headers. The build here is a small stand-in written to a temporary directory; the
// last tests check the real apps/web/dist when it has been built.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import { ONEMAP_ATTRIBUTION, oneMapTiles } from "@usg/map-style";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildApp } from "../../src/app.ts";
import { createDatabase } from "../../src/database.ts";
import { createMemoryStorage, type MemoryObjectStore } from "../../src/storage.ts";
import {
  acceptsHtml,
  contentSecurityPolicy,
  IMMUTABLE,
  isApiPath,
  loadWebDist,
  NO_CACHE,
  ONEMAP_ORIGIN,
  requestPath,
  WebDistError,
} from "../../src/web-dist.ts";

const UNREACHABLE_DB = "postgres://usg:hunter2@127.0.0.1:1/usg";
const SECRET = "secret-outside-the-build-7f3a";

const INDEX = `<!doctype html><html lang="en-SG"><head><meta charset="utf-8" /><title>Underground SG</title><script type="module" crossorigin src="/assets/index-AbCd1234.js"></script><link rel="stylesheet" crossorigin href="/assets/index-QwEr_678.css"></head><body><div id="root"></div>${"<!-- padding so the page compresses -->".repeat(30)}</body></html>`;
const SCRIPT = `console.log("the app");\n${"export const x = 1;\n".repeat(200)}`;
const WORKER = `self.onmessage = () => {};\n${"// worker\n".repeat(100)}`;
const CSS = `.map { position: absolute; }\n${".x { color: red; }\n".repeat(50)}`;

let root: string;
let dist: string;
const storage = createMemoryStorage();
const db = createDatabase(UNREACHABLE_DB, { maxConnections: 1 });
let app: FastifyInstance;

function write(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "usg-web-dist-"));
  dist = join(root, "dist");
  write(join(root, "secret.txt"), SECRET);
  write(join(root, "package.json"), `{"name":"${SECRET}"}`);
  write(join(dist, "index.html"), INDEX);
  write(join(dist, "assets", "index-AbCd1234.js"), SCRIPT);
  write(join(dist, "assets", "maplibre-gl-worker-Xy-z9876.mjs"), WORKER);
  write(join(dist, "assets", "index-QwEr_678.css"), CSS);
  write(join(dist, "assets", "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  write(join(dist, "robots.txt"), "User-agent: *\n");
  // Not served: under API paths, hidden, an unknown type, a name with a space.
  write(join(dist, "glyphs", "OFL.txt"), SECRET);
  write(join(dist, "glyphs", "Noto Sans Regular", "0-255.pbf"), SECRET);
  write(join(dist, "public", "latest.json"), `{"from":"${SECRET}"}`);
  write(join(dist, ".env"), `TOKEN=${SECRET}`);
  write(join(dist, "notes.md"), SECRET);
  write(join(dist, "my page.html"), SECRET);

  const store = storage.buckets.public as MemoryObjectStore;
  await store.put("latest.json", new TextEncoder().encode('{"schema_version":1}'), {
    contentType: "application/json",
  });
  app = await buildApp({
    db,
    storage,
    corsOrigins: ["http://localhost:5173"],
    webDist: loadWebDist(dist),
  });
});

afterAll(async () => {
  await app.close();
  await db.destroy();
  rmSync(root, { recursive: true, force: true });
});

const HTML = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

function expectPage(response: {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
}): void {
  expect(response.statusCode).toBe(200);
  expect(response.headers).toMatchObject({
    "content-type": "text/html; charset=utf-8",
    "cache-control": NO_CACHE,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "content-security-policy": contentSecurityPolicy(),
  });
  expect(response.body).toBe(INDEX);
}

describe("loadWebDist", () => {
  test("lists the build's files, read once, and nothing it shouldn't serve", () => {
    const loaded = loadWebDist(dist);
    expect([...loaded.files.keys()].sort()).toEqual([
      "/assets/index-AbCd1234.js",
      "/assets/index-QwEr_678.css",
      "/assets/logo.svg",
      "/assets/maplibre-gl-worker-Xy-z9876.mjs",
      "/robots.txt",
    ]);
    expect(loaded.index.urlPath).toBe("/");
    expect(loaded.index.body.toString()).toBe(INDEX);
  });

  test("refuses a directory without index.html, or none at all", () => {
    expect(() => loadWebDist(join(dist, "assets"))).toThrow(WebDistError);
    expect(() => loadWebDist(join(root, "missing"))).toThrow(WebDistError);
    expect(() => loadWebDist(join(root, "missing"))).toThrow(/API_WEB_DIST/);
  });
});

describe("GET and HEAD /", () => {
  test("index.html with the page's security headers, revalidated on every use", async () => {
    const response = await app.inject({ url: "/", headers: { accept: HTML } });
    expectPage(response);
    expect(response.headers["etag"]).toMatch(/^"[0-9a-f]{32}"$/);
    expect(response.headers["content-encoding"]).toBeUndefined();
  });

  test("brotli to a client that accepts it, with its own ETag", async () => {
    const plain = await app.inject({ url: "/" });
    const response = await app.inject({ url: "/", headers: { "accept-encoding": "gzip, br" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("br");
    expect(response.headers["vary"]).toContain("Accept-Encoding");
    expect(response.headers["etag"]).not.toBe(plain.headers["etag"]);
    expect(brotliDecompressSync(response.rawPayload).toString()).toBe(INDEX);
  });

  test("HEAD: the headers, no body", async () => {
    const response = await app.inject({ method: "HEAD", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-length"]).toBe(String(Buffer.byteLength(INDEX)));
    expect(response.headers["content-security-policy"]).toBe(contentSecurityPolicy());
    expect(response.body).toBe("");
  });

  test("If-None-Match with the ETag gives 304", async () => {
    const first = await app.inject({ url: "/" });
    const second = await app.inject({
      url: "/",
      headers: { "if-none-match": String(first.headers["etag"]) },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
  });
});

describe("the build's files", () => {
  test("hashed assets are cached for good; no page headers on them", async () => {
    for (const [url, type] of [
      ["/assets/index-AbCd1234.js", "text/javascript; charset=utf-8"],
      ["/assets/maplibre-gl-worker-Xy-z9876.mjs", "text/javascript; charset=utf-8"],
      ["/assets/index-QwEr_678.css", "text/css; charset=utf-8"],
    ] as const) {
      const response = await app.inject({ url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers).toMatchObject({
        "content-type": type,
        "cache-control": IMMUTABLE,
        "x-content-type-options": "nosniff",
      });
      expect(response.headers["content-security-policy"]).toBeUndefined();
    }
    const script = await app.inject({ url: "/assets/index-AbCd1234.js?v=2" });
    expect(script.body).toBe(SCRIPT);
  });

  test("unhashed files are revalidated", async () => {
    for (const url of ["/assets/logo.svg", "/robots.txt"]) {
      const response = await app.inject({ url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers["cache-control"], url).toBe(NO_CACHE);
    }
  });

  test("brotli where it helps, decoded otherwise", async () => {
    const br = await app.inject({
      url: "/assets/index-AbCd1234.js",
      headers: { "accept-encoding": "br" },
    });
    expect(br.headers["content-encoding"]).toBe("br");
    expect(brotliDecompressSync(br.rawPayload).toString()).toBe(SCRIPT);
    const identity = await app.inject({
      url: "/assets/index-AbCd1234.js",
      headers: { "accept-encoding": "gzip" },
    });
    expect(identity.headers["content-encoding"]).toBeUndefined();
    expect(identity.body).toBe(SCRIPT);
    // Too small to be worth it: never compressed, so nothing varies.
    const robots = await app.inject({ url: "/robots.txt", headers: { "accept-encoding": "br" } });
    expect(robots.headers["content-encoding"]).toBeUndefined();
    expect(String(robots.headers["vary"] ?? "")).not.toContain("Accept-Encoding");
  });

  test("files it doesn't list are 404, and the API's paths stay the API's", async () => {
    for (const url of ["/notes.md", "/.env", "/my%20page.html", "/index.html", "/assets/"]) {
      const response = await app.inject({ url });
      expect(response.statusCode, url).toBe(404);
      expect(response.body, url).not.toContain(SECRET);
    }
    // The glyph route answers /glyphs: OFL.txt isn't a range file, and the build's copy is unused.
    const ofl = await app.inject({ url: "/glyphs/OFL.txt" });
    expect(ofl.statusCode).toBe(404);
    const glyph = await app.inject({ url: "/glyphs/Noto%20Sans%20Regular/0-255.pbf" });
    expect(glyph.statusCode).toBe(200);
    expect(glyph.body).not.toContain(SECRET);
    // The public bucket's latest.json, not a file of the same name in the build.
    const latest = await app.inject({ url: "/public/latest.json" });
    expect(latest.body).toBe('{"schema_version":1}');
  });
});

describe("no request text becomes a path", () => {
  const attempts = [
    "/../secret.txt",
    "/assets/../../secret.txt",
    "/%2e%2e/secret.txt",
    "/%2E%2E/%2E%2E/secret.txt",
    "/assets/..%2F..%2Fsecret.txt",
    "/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
    "/..%5Csecret.txt",
    "/assets\\..\\..\\secret.txt",
    "/assets/index-AbCd1234.js%00",
    "/assets/index-AbCd1234.js/../../secret.txt",
    "/ASSETS/INDEX-ABCD1234.JS",
    "//secret.txt",
    "/package.json",
    "/%2fetc%2fpasswd",
    "/C:/Windows/win.ini",
  ];

  test.each(attempts)("%s is 404 for a script or a fetch", async (url) => {
    for (const accept of [undefined, "*/*", "application/json"]) {
      const response = await app.inject({
        url,
        headers: accept === undefined ? {} : { accept },
      });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(SECRET);
    }
  });

  test.each(attempts)("%s, asked for as a page, is only ever index.html", async (url) => {
    const response = await app.inject({ url, headers: { accept: HTML } });
    expect(response.body).not.toContain(SECRET);
    if (response.statusCode === 200) expectPage(response);
    else expect(response.statusCode).toBe(404);
  });
});

describe("the SPA fallback", () => {
  test("a GET that asks for HTML gets index.html, with the page's headers", async () => {
    for (const url of ["/some/page", "/mapper", "/route?from=a&to=b", "/publicity"]) {
      expectPage(await app.inject({ url, headers: { accept: HTML } }));
    }
  });

  test("only for GET, only when HTML is asked for", async () => {
    const cases: { method: "GET" | "HEAD" | "POST" | "DELETE"; accept?: string }[] = [
      { method: "GET" },
      { method: "GET", accept: "*/*" },
      { method: "GET", accept: "application/json" },
      { method: "GET", accept: "text/html;q=0" },
      { method: "GET", accept: "text/plain, application/xhtml+xml" },
      { method: "HEAD", accept: HTML },
      { method: "POST", accept: HTML },
      { method: "DELETE", accept: HTML },
    ];
    for (const { method, accept } of cases) {
      const response = await app.inject({
        method,
        url: "/some/page",
        headers: accept === undefined ? {} : { accept },
      });
      expect(response.statusCode, `${method} ${accept}`).toBe(404);
      expect(response.headers["content-type"]).toMatch(/^application\/json/);
      expect(response.json()).toEqual({
        message: `Route ${method}:/some/page not found`,
        error: "Not Found",
        statusCode: 404,
      });
    }
  });

  test("never under the API's paths", async () => {
    for (const url of [
      "/public/nothing.json",
      "/public",
      "/%70ublic/nothing.json",
      "/map/whatever",
      "/map",
      "/health/x",
      "/glyphs/x",
      "/glyphs",
      "/openapi.json/x",
    ]) {
      const response = await app.inject({ url, headers: { accept: HTML } });
      expect(response.statusCode, url).toBe(404);
      expect(response.headers["content-type"], url).toMatch(/^application\/json/);
    }
    const openapi = await app.inject({ url: "/openapi.json", headers: { accept: HTML } });
    expect(openapi.headers["content-type"]).toMatch(/^application\/json/);
  });
});

describe("the API with the build", () => {
  test("the build's routes are not in the OpenAPI document", async () => {
    const doc = (await app.inject({ url: "/openapi.json" })).json() as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/glyphs/{fontstack}/{file}",
      "/health",
      "/map/latest",
      "/public/{*}",
    ]);
  });

  test("still only GET, HEAD and OPTIONS", () => {
    const routes = app.printRoutes({ commonPrefix: false });
    expect(routes).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
  });

  test("without API_WEB_DIST there is no page", async () => {
    const plain = await buildApp({ db, storage, corsOrigins: [] });
    try {
      const response = await plain.inject({ url: "/", headers: { accept: HTML } });
      expect(response.statusCode).toBe(404);
      const fallback = await plain.inject({ url: "/some/page", headers: { accept: HTML } });
      expect(fallback.statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });
});

describe("the page's Content-Security-Policy", () => {
  const csp = contentSecurityPolicy();
  const directive = (name: string) =>
    csp
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .find(([key]) => key === name)
      ?.slice(1);

  test("OneMap's tiles and logo are allowed, from the origin the style uses", () => {
    expect(ONEMAP_ORIGIN).toBe("https://www.onemap.gov.sg");
    for (const basemap of ["Grey", "Default"] as const) {
      for (const hd of [true, false]) {
        expect(new URL(oneMapTiles(basemap, hd)).origin).toBe(ONEMAP_ORIGIN);
      }
    }
    const logo = /<img[^>]*\bsrc="([^"]+)"/.exec(ONEMAP_ATTRIBUTION)?.[1];
    expect(logo).toBeDefined();
    expect(new URL(String(logo)).origin).toBe(ONEMAP_ORIGIN);
    expect(directive("img-src")).toEqual(["'self'", "data:", "blob:", ONEMAP_ORIGIN]);
    expect(directive("connect-src")).toEqual(["'self'", ONEMAP_ORIGIN]);
  });

  test("workers from this origin or blob:, scripts and styles from this origin only", () => {
    expect(directive("worker-src")).toEqual(["'self'", "blob:"]);
    expect(directive("script-src")).toEqual(["'self'"]);
    expect(directive("style-src")).toEqual(["'self'"]);
    expect(directive("default-src")).toEqual(["'self'"]);
    expect(directive("object-src")).toEqual(["'none'"]);
    expect(directive("frame-ancestors")).toEqual(["'none'"]);
    expect(csp).not.toContain("unsafe");
  });
});

describe("helpers", () => {
  test("acceptsHtml: text/html named with q above 0", () => {
    expect(acceptsHtml(HTML)).toBe(true);
    expect(acceptsHtml("text/html")).toBe(true);
    expect(acceptsHtml("TEXT/HTML; q=0.5")).toBe(true);
    expect(acceptsHtml(undefined)).toBe(false);
    expect(acceptsHtml("*/*")).toBe(false);
    expect(acceptsHtml("text/*")).toBe(false);
    expect(acceptsHtml("application/json")).toBe(false);
    expect(acceptsHtml("text/html;q=0")).toBe(false);
    expect(acceptsHtml("text/html;q=0.0, */*")).toBe(false);
  });

  test("isApiPath: the API's prefixes at a path boundary", () => {
    for (const path of ["/public", "/public/x", "/map", "/map/latest", "/health", "/glyphs/a/b"]) {
      expect(isApiPath(path), path).toBe(true);
    }
    expect(isApiPath("/openapi.json")).toBe(true);
    for (const path of ["/", "/mapper", "/publicity", "/healthy", "/openapi.jsonx", "/assets/x"]) {
      expect(isApiPath(path), path).toBe(false);
    }
  });

  test("requestPath: no query, percent-decoded, left alone when it doesn't decode", () => {
    expect(requestPath("/a/b?c=d")).toBe("/a/b");
    expect(requestPath("/%70ublic/x")).toBe("/public/x");
    expect(requestPath("/%E0%A4%A")).toBe("/%E0%A4%A");
  });
});

const REAL_DIST = fileURLToPath(new URL("../../../../apps/web/dist", import.meta.url));

describe.skipIf(!existsSync(join(REAL_DIST, "index.html")))("the real apps/web/dist", () => {
  test("every script and stylesheet index.html names is served, and nothing is inline", () => {
    const loaded = loadWebDist(REAL_DIST);
    const index = readFileSync(join(REAL_DIST, "index.html"), "utf8");
    const referenced = [...index.matchAll(/\b(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const path of referenced) expect(loaded.files.has(String(path)), path).toBe(true);
    // The CSP allows no inline script or style.
    expect(index).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(index).not.toMatch(/<style\b/);
    expect(index).not.toMatch(/\sstyle="/);
    expect(index).not.toMatch(/\son[a-z]+="/);
    for (const file of loaded.files.values()) {
      if (file.urlPath.startsWith("/assets/") && /\.(m?js|css)$/.test(file.urlPath)) {
        expect(file.cacheControl, file.urlPath).toBe(IMMUTABLE);
      }
    }
  });
});
