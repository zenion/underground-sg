// Vite config for @usg/web. Development modes:
//
//   pnpm web                 the dev server on port 5173, proxying /public, /api and /map to the
//                            API: http://127.0.0.1 on API_PORT from the repo root's .env (28000
//                            by default), or VITE_API_URL
//   pnpm web:fixtures        fixture mode: /public is the built-in demo snapshot, no API needed
//
// VITE_HOST (or --host) makes the server listen beyond localhost, for a phone on the LAN. Both
// variables can also go in apps/web/.env.local (git-ignored). See README.md.

import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import { apiTarget } from "./plugins/api.ts";
import { demoFixtures } from "./plugins/fixtures.ts";
import { mapGlyphs } from "./plugins/glyphs.ts";

/** The repo root, whose .env (git-ignored) holds the API's settings. */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const fixtures = mode === "fixtures";
  // "true" listens on every address; an address listens on that one.
  const host = env["VITE_HOST"] === "true" ? true : env["VITE_HOST"] || undefined;
  // The dev server and preview proxy to the API, except in fixture mode; a build needs no target.
  const target =
    fixtures || command !== "serve"
      ? undefined
      : apiTarget(env["VITE_API_URL"], loadEnv(mode, REPO_ROOT, "API_")["API_PORT"]);
  // Prefix matches with a path boundary, so /mapper or /publications never reach the API.
  const proxy: Record<string, ProxyOptions> | undefined =
    target === undefined
      ? undefined
      : {
          "^/public/": { target },
          "^/api(/|$)": { target },
          "^/map(/|$)": { target },
        };
  return {
    // No static public/ directory: /public/ is the map data's path (the API's, or the fixtures').
    publicDir: false,
    plugins: [react(), mapGlyphs(), fixtures ? demoFixtures(env["WEB_FIXTURE"]) : undefined],
    server: { port: 5173, strictPort: true, host, proxy },
    preview: { port: 4173, strictPort: true, host, proxy },
    build: {
      // MapLibre GL JS alone is about 1.05 MB minified (290 kB gzipped).
      chunkSizeWarningLimit: 1200,
      rolldownOptions: {
        output: {
          // MapLibre in a chunk of its own, so a change to the app doesn't invalidate it in caches.
          codeSplitting: { groups: [{ name: "maplibre", test: /[\\/]maplibre-gl[\\/]/ }] },
        },
      },
    },
  };
});
