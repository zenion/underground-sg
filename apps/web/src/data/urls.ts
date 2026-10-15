// Where the public map files are (docs/snapshot-format.md, "Layout"): latest.json and status.json
// at the root of the public files, and each version's files at the paths latest.json gives,
// relative to latest.json itself.

import type { LatestPointer } from "@usg/contracts";

/**
 * The default root of the public files. The API serves the public bucket under /public, and the
 * dev server proxies it there (or, in fixture mode, serves the demo snapshot there).
 */
export const DEFAULT_PUBLIC_BASE = "/public";

/**
 * The root of the public files as an absolute URL ending in "/": `base` (a path such as "/public",
 * or a URL such as "https://files.example.org/map") resolved against the page's URL.
 */
export function publicRoot(base: string | undefined, pageUrl: string): URL {
  const trimmed = base?.trim() || DEFAULT_PUBLIC_BASE;
  return new URL(trimmed.endsWith("/") ? trimmed : `${trimmed}/`, pageUrl);
}

/** latest.json's URL: the pointer to the current version. */
export function latestUrl(root: URL): string {
  return new URL("latest.json", root).href;
}

/** status.json's URL: the status overlay, which is never part of a version. */
export function statusUrl(root: URL): string {
  return new URL("status.json", root).href;
}

/** The URLs of a version's two files. */
export interface VersionFileUrls {
  readonly indoor: string;
  readonly street: string;
}

/**
 * The URLs of the version latest.json points to: its `files` paths, resolved against latest.json's
 * own URL. `latest` must have passed `parseLatest`, which checks that each path is the version's own
 * `snapshots/<snapshot_sha256>/<file>`, so these URLs stay under the root of the public files.
 */
export function versionFileUrls(latest: LatestPointer, latestJsonUrl: string): VersionFileUrls {
  return {
    indoor: new URL(latest.files.indoor.path, latestJsonUrl).href,
    street: new URL(latest.files.street.path, latestJsonUrl).href,
  };
}
