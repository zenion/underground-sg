// Metro's configuration: Expo's defaults (expo/metro-config), narrowed to what the app bundles.
//
// Metro bundles, and its /symbolicate reads, any file it can see, for whoever reaches it: through
// `pnpm dev:phone`'s tunnel that is anyone with the address. Expo's monorepo defaults let it see
// every workspace (services/api, db/, scripts/, apps/web), and Expo CLI 57's on-demand file
// system lets it read any other file under the repo root as well. So:
//
// - Only the app, the workspace packages it imports and the root node_modules are watched, and
//   every other path under the repo root is blocked, which also stops the on-demand reads.
// - Wherever they are, files that hold settings, credentials or private data are blocked: `.env`
//   files, signing files, `.data/` (Docker volumes, venue fixtures, dev:phone's logs),
//   `db/private/` (restricted-zone outlines) and Turborepo's logs. Expo still loads the app's
//   `.env` files itself; Metro then doesn't watch them, so restart Metro after changing one.
// - The cache key includes the EXPO_PUBLIC_ variables: a production bundle (`expo export`) inlines
//   their values, and Metro's cache key otherwise doesn't change with them, so an export after
//   changing one would reuse code with the old value.

const { createHash } = require("node:crypto");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const root = path.resolve(__dirname, "../..");
/** What the app's code comes from, relative to the repo root. */
const SOURCES = ["apps/mapper", "packages/contracts", "packages/floorplan", "packages/map-style"];

const config = getDefaultConfig(__dirname);

config.watchFolders = [
  path.join(root, "node_modules"),
  ...SOURCES.filter((source) => source !== "apps/mapper").map((source) => path.join(root, source)),
];

/** `text` as a regular expression source, either separator, letters in either case (Windows). */
function pathPattern(text) {
  return text
    .split(/[\\/]+/)
    .map((part) =>
      [...part]
        .map((char) =>
          /[a-z]/i.test(char)
            ? `[${char.toLowerCase()}${char.toUpperCase()}]`
            : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join(""),
    )
    .join("[\\\\/]");
}

/** The folders on the way to the sources (apps, packages), which the on-demand reads walk through. */
const ANCESTORS = [
  ...new Set(
    SOURCES.flatMap((source) =>
      source
        .split("/")
        .slice(0, -1)
        .map((_, i, parts) => parts.slice(0, i + 1).join("/")),
    ),
  ),
];
const outsideSources = new RegExp(
  `^${pathPattern(root)}[\\\\/](?!(?:${[...SOURCES, "node_modules"].map(pathPattern).join("|")})(?:[\\\\/]|$)|(?:${ANCESTORS.map(pathPattern).join("|")})$)`,
);
const PRIVATE = [
  /[\\/]\.env(\.[^\\/]*)?$/,
  /[\\/]credentials\.json$/,
  /\.(p8|p12|mobileprovision|jks|keystore)$/,
  /[\\/]\.data[\\/]/,
  /[\\/]db[\\/]private[\\/]/,
  /[\\/]\.turbo[\\/]/,
];
config.resolver.blockList = [
  ...[config.resolver.blockList ?? []].flat(),
  outsideSources,
  ...PRIVATE,
];

const publicEnv = Object.keys(process.env)
  .filter((name) => name.startsWith("EXPO_PUBLIC_"))
  .sort()
  .map((name) => `${name}=${process.env[name]}`)
  .join("\n");
config.cacheVersion = `${config.cacheVersion ?? ""}+env-${createHash("sha256").update(publicEnv).digest("hex").slice(0, 16)}`;

module.exports = config;
