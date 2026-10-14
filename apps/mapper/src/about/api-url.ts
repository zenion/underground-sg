// The API base URL the app uses. Through Phase 3 the API runs on the owner's PC and the phone
// reaches it over the home LAN (ADR 0009), so by default the app takes the host it loaded its
// JavaScript from (Expo's dev server, the same PC) and the API's port. EXPO_PUBLIC_API_URL
// overrides that, for a tunnel, another machine or a build without a dev server.

/** The API's default port on the owner's PC. EXPO_PUBLIC_API_PORT overrides it. */
export const DEFAULT_API_PORT = 28000;

export interface ApiUrlInput {
  /** EXPO_PUBLIC_API_URL: used as given (an http or https URL) when set. */
  readonly explicitUrl?: string | undefined;
  /** EXPO_PUBLIC_API_PORT: default 28000. */
  readonly port?: string | undefined;
  /** The dev server's host and port, such as "192.168.1.20:8081" (expo-constants `hostUri`). */
  readonly hostUri?: string | null | undefined;
}

export type ApiUrl =
  | { readonly url: string; readonly source: "EXPO_PUBLIC_API_URL" | "dev server" }
  | { readonly url: null; readonly problem: string };

/** Hosts of Expo's tunnel (`expo start --tunnel`), which forwards only Metro's port. */
const TUNNEL_HOST = /\.exp\.direct$|\.ngrok(?:-free)?\.(?:io|app|dev)$/i;

export function apiBaseUrl({ explicitUrl, port, hostUri }: ApiUrlInput): ApiUrl {
  const explicit = explicitUrl?.trim();
  if (explicit) {
    let parsed: URL;
    try {
      parsed = new URL(explicit);
    } catch {
      return { url: null, problem: `EXPO_PUBLIC_API_URL is not a URL: "${explicit}".` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { url: null, problem: `EXPO_PUBLIC_API_URL must be http or https: "${explicit}".` };
    }
    return { url: explicit.replace(/\/+$/, ""), source: "EXPO_PUBLIC_API_URL" };
  }

  const portText = port?.trim() || String(DEFAULT_API_PORT);
  const portNumber = Number(portText);
  if (!(/^\d+$/.test(portText) && portNumber >= 1 && portNumber <= 65535)) {
    return { url: null, problem: `EXPO_PUBLIC_API_PORT must be a port number: "${portText}".` };
  }

  const host = hostOf(hostUri);
  if (!host) {
    return {
      url: null,
      problem: "No dev-server host to derive it from. Set EXPO_PUBLIC_API_URL.",
    };
  }
  if (TUNNEL_HOST.test(host)) {
    return {
      url: null,
      problem: "Metro runs through a tunnel, which doesn't reach the API. Set EXPO_PUBLIC_API_URL.",
    };
  }
  return { url: `http://${host}:${portNumber}`, source: "dev server" };
}

/** The host part of "host:port", "[ipv6]:port" or "host:port/path", keeping IPv6 brackets. */
export function hostOf(hostUri: string | null | undefined): string | null {
  const text = hostUri?.trim().replace(/^[a-z][a-z\d+.-]*:\/\//i, "");
  if (!text) return null;
  const authority = text.split(/[/?#]/, 1)[0] ?? "";
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    return end > 1 ? authority.slice(0, end + 1) : null;
  }
  const host = authority.split(":", 1)[0] ?? "";
  return host.length > 0 ? host : null;
}
