// Where `pnpm web` proxies /public, /api and /map: the API on this PC (services/api). The API
// reads API_PORT from the repo root's .env (default 28000) and serves the public bucket read-only
// at GET /public/<key>, the local stand-in for Cloudflare (docs/snapshot-format.md, "Layout"), so
// the proxy follows the same setting. VITE_API_URL overrides it, for an API elsewhere.

/** The API's port when API_PORT is unset: services/api's default. */
export const DEFAULT_API_PORT = 28000;

/**
 * The proxy's target: VITE_API_URL if set, else the API at 127.0.0.1 on API_PORT. The API listens
 * on 127.0.0.1 by default; the dev server reaches it there even when the API listens more widely.
 */
export function apiTarget(viteApiUrl: string | undefined, apiPort: string | undefined): string {
  const url = viteApiUrl?.trim();
  if (url) {
    if (!/^https?:\/\/[^/]+/.test(url)) {
      throw new Error("VITE_API_URL must be an http(s) URL such as http://127.0.0.1:28000");
    }
    return url;
  }
  const port = apiPort?.trim() || String(DEFAULT_API_PORT);
  const number = Number(port);
  if (!/^\d+$/.test(port) || number < 1 || number > 65_535) {
    throw new Error("API_PORT must be a port number from 1 to 65535");
  }
  return `http://127.0.0.1:${number}`;
}
