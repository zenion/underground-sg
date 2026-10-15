// The public files (docs/snapshot-format.md) as GET /public/* serves them: which keys exist, and
// the headers each kind gets. In production Cloudflare serves the same files from R2; this route
// stands in for it on the owner's PC.

import { CACHE_CONTROL, VERSION_FILES } from "@usg/contracts";

export type PublicFileKind = "version" | "latest" | "status";

export interface PublicFile {
  readonly key: string;
  readonly kind: PublicFileKind;
  readonly contentType: string;
  readonly cacheControl: string;
}

const VERSION_FILE_KEY = new RegExp(
  `^snapshots/[0-9a-f]{64}/(?:${VERSION_FILES.map((file) => file.replace(".", "\\.")).join("|")})$`,
);

/**
 * The public file a request path names, or undefined for anything else. Only the documented files
 * exist: `latest.json`, `status.json` and `snapshots/<64 hex>/indoor.json` or `street.json`. So
 * nothing can be listed, and no path segment such as `..` or a percent-escape can reach another
 * key.
 */
export function publicFile(path: string): PublicFile | undefined {
  if (path === "latest.json") {
    return {
      key: path,
      kind: "latest",
      contentType: "application/json",
      cacheControl: CACHE_CONTROL.latest,
    };
  }
  if (path === "status.json") {
    return {
      key: path,
      kind: "status",
      contentType: "application/json",
      cacheControl: CACHE_CONTROL.status,
    };
  }
  if (VERSION_FILE_KEY.test(path)) {
    return {
      key: path,
      kind: "version",
      contentType: "application/geo+json",
      cacheControl: CACHE_CONTROL.version,
    };
  }
  return undefined;
}

/**
 * Whether an `Accept-Encoding` header accepts a content coding (RFC 9110, section 12.5.3): named
 * with a q-value above 0, or covered by `*` with one and not named with q=0. A request without the
 * header gets the identity coding, as most servers send, rather than "anything".
 */
export function acceptsEncoding(header: string | undefined, coding: string): boolean {
  if (header === undefined) return false;
  let named: number | undefined;
  let wildcard: number | undefined;
  for (const item of header.split(",")) {
    const [rawName = "", ...params] = item.split(";");
    const name = rawName.trim().toLowerCase();
    if (name === "") continue;
    let q = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
      if (match?.[1] !== undefined) q = Number(match[1]);
    }
    if (!Number.isFinite(q)) q = 0;
    if (name === coding.toLowerCase()) named = q;
    else if (name === "*") wildcard = q;
  }
  if (named !== undefined) return named > 0;
  return wildcard !== undefined && wildcard > 0;
}
