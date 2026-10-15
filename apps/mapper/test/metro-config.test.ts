// metro.config.js: what Metro watches and may read (and so bundles and symbolicates, also for
// whoever reaches it through `pnpm dev:phone`'s tunnel), what it never reads, and its cache key. Each case loads
// the config in a fresh Node process, as Expo CLI does, with the environment it is given.

import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const APP = fileURLToPath(new URL("../", import.meta.url));
const ROOT = resolve(APP, "../..");

interface Loaded {
  readonly watchFolders: string[];
  readonly blockList: { source: string; flags: string }[];
  readonly cacheVersion: string;
}

const SCRIPT = `
const config = require("./metro.config.js");
const blockList = [config.resolver.blockList].flat().map((r) => ({ source: r.source, flags: r.flags }));
process.stdout.write("\\n" + JSON.stringify({ watchFolders: config.watchFolders, blockList, cacheVersion: config.cacheVersion }));
`;

function load(env: Record<string, string> = {}): Loaded {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("EXPO_PUBLIC_")),
  );
  const out = execFileSync(process.execPath, ["-e", SCRIPT], {
    cwd: APP,
    // Expo's types make NODE_ENV required; a child process doesn't need it.
    env: { ...base, ...env } as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").at(-1) ?? "") as Loaded;
}

function blocked(config: Loaded, file: string): boolean {
  return config.blockList.some(({ source, flags }) => new RegExp(source, flags).test(file));
}

describe("metro.config.js", () => {
  const config = load();

  test("watches the app's packages and node_modules, not the API, db/, scripts/ or the webapp", () => {
    expect([...config.watchFolders].sort()).toEqual(
      [
        join(ROOT, "node_modules"),
        join(ROOT, "packages", "contracts"),
        join(ROOT, "packages", "floorplan"),
        join(ROOT, "packages", "map-style"),
      ].sort(),
    );
    for (const outside of ["services", "db", "scripts", join("apps", "web")]) {
      expect(
        config.watchFolders.some((folder) => folder.startsWith(join(ROOT, outside))),
        outside,
      ).toBe(false);
    }
  });

  test.each([
    // Under the repo root but outside the app's sources: Expo's on-demand file system would read
    // them otherwise.
    join(ROOT, "package.json"),
    join(ROOT, "db", "package.json"),
    join(ROOT, "services", "api", "src", "config.ts"),
    join(ROOT, "scripts", "dev-phone-lib.ts"),
    join(ROOT, "apps", "web", "src", "main.tsx"),
    join(ROOT, "captures", "c1", "keyframes", "0001.jpg"),
    join(ROOT, "apps", "mapper-old", "x.ts"),
    join(ROOT, "apps", "web"),
    join(ROOT, "packages", "routing", "src", "index.ts"),
    // Settings, credentials and private data, wherever they are.
    join(ROOT, "db", "private", "restricted-zones.geojson"),
    join(APP, "credentials.json"),
    join(APP, "certs", "dist.p12"),
    join(APP, ".env"),
    join(APP, ".env.local"),
    join(APP, ".env.development"),
    join(ROOT, "packages", "map-style", ".env.production.local"),
    join(ROOT, ".data", "fixtures", "funan-b2.json"),
    join(ROOT, ".data", "dev-phone", "ngrok.log"),
    join(APP, ".turbo", "turbo-build.log"),
    "/home/ci/usg/db/private/zones.json",
    "/home/ci/usg/apps/mapper/.env.local",
  ])("never reads %s", (file) => {
    expect(blocked(config, file)).toBe(true);
  });

  test.each([
    // The folders on the way, which Expo's on-demand reads walk through in an export.
    join(ROOT, "apps"),
    join(ROOT, "packages"),
    join(APP, "src", "map", "draw-map.tsx"),
    join(APP, "src", "config.ts"),
    join(APP, "src", "environment.ts"),
    join(ROOT, "packages", "map-style", "src", "index.ts"),
    join(ROOT, "packages", "contracts", "schemas", "api", "health.schema.json"),
    join(APP, "node_modules", "expo-router", "entry.js"),
    join(
      ROOT,
      "node_modules",
      ".pnpm",
      "maplibre-gl@6.14.0",
      "node_modules",
      "maplibre-gl",
      "dist",
      "maplibre-gl.js",
    ),
    "/home/ci/usg/apps/mapper/src/map/draw-map.tsx",
  ])("still bundles %s", (file) => {
    expect(blocked(config, file)).toBe(false);
  });

  test("the repo root is matched whatever the case of its letters (Windows)", () => {
    const upper = join(ROOT.toUpperCase(), "services", "api", "src", "config.ts");
    expect(blocked(config, upper)).toBe(true);
    const lower = join(APP.toLowerCase(), "src", "map", "draw-map.tsx");
    expect(blocked(config, lower)).toBe(false);
  });

  test("the cache key follows the EXPO_PUBLIC_ variables, which an export inlines", () => {
    const tunnel = load({ EXPO_PUBLIC_API_URL: "https://example.ngrok.app" });
    const lan = load({ EXPO_PUBLIC_API_URL: "http://192.168.1.20:28000" });
    expect(tunnel.cacheVersion).not.toBe(config.cacheVersion);
    expect(tunnel.cacheVersion).not.toBe(lan.cacheVersion);
    expect(load({ EXPO_PUBLIC_API_URL: "https://example.ngrok.app" }).cacheVersion).toBe(
      tunnel.cacheVersion,
    );
    // Other variables don't touch it.
    expect(load({ DATABASE_URL: "postgres://elsewhere" }).cacheVersion).toBe(config.cacheVersion);
  });
}, 120_000);
