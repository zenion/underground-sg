// The pure parts of `pnpm dev:phone` (dev-phone.ts): settings, the children's arguments,
// environments and ngrok configuration, reading what Docker, the API, ngrok and Expo answer, and
// which processes to stop. No side effects here, so test/dev-phone.test.ts can check all of it.

/** The API's default port (services/api). */
export const DEFAULT_API_PORT = 28000;
/** Metro's port: Expo's default, passed explicitly so the tunnel can forward to it. */
export const METRO_PORT = 8081;
/** The compose services the API needs (docker-compose.yml). */
export const STACK_SERVICES = ["postgis", "rustfs"] as const;

export class SetupError extends Error {
  override name = "SetupError";
}

/**
 * NGROK_DOMAIN as a host name: the owner's reserved ngrok domain, such as example.ngrok.app. An
 * https:// prefix and a trailing slash are forgiven; a path, a port or anything else is refused.
 */
export function ngrokDomain(value: string | undefined): string {
  const text = value?.trim() ?? "";
  if (text === "") {
    throw new SetupError(
      [
        "NGROK_DOMAIN is not set.",
        "Add your reserved ngrok domain to .env at the repo root, for example:",
        "",
        "  NGROK_DOMAIN=example.ngrok.app",
        "",
        "It is on https://dashboard.ngrok.com under Domains. The authtoken stays in ngrok's own",
        "config (`ngrok config add-authtoken <token>`), never in .env.",
      ].join("\n"),
    );
  }
  const host = text.replace(/^https:\/\//i, "").replace(/\/$/, "");
  if (
    !/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host) ||
    host.toLowerCase().endsWith(".exp.direct")
  ) {
    throw new SetupError(
      "NGROK_DOMAIN must be a domain name such as example.ngrok.app, without a path or port.",
    );
  }
  return host.toLowerCase();
}

/** The API's port: API_PORT, or 28000. */
export function apiPort(value: string | undefined): number {
  const text = value?.trim() ?? "";
  if (text === "") return DEFAULT_API_PORT;
  const port = Number(text);
  if (!/^\d+$/.test(text) || port < 1 || port > 65_535) {
    throw new SetupError("API_PORT must be a port number from 1 to 65535.");
  }
  return port;
}

/** The https origin the phone uses for the webapp, the public files and the API. */
export function publicOrigin(domain: string): string {
  return `https://${domain}`;
}

/** The names of the ngrok endpoints in the configuration dev-phone.ts writes. */
export const ENDPOINTS = { api: "api", metro: "metro" } as const;

/**
 * Metro's endpoints that only the PC may use, refused at ngrok's edge: the debugger and its page
 * list (with them, anyone could run JavaScript in the app on the phone), DevTools, opening files in
 * the PC's editor, symbolication (code frames from any file Metro watches), the event stream (the
 * app's console output), the status check (the PC's paths) and Expo's dev pages and plugins.
 * Through a tunnel every request reaches Metro from loopback, which Metro and Expo CLI trust as
 * the PC itself. Matched case-insensitively, as Expo's connect routes are.
 */
export const METRO_LOCAL_ONLY_PATHS = [
  "/json",
  "/inspector/debug",
  "/inspector/network",
  "/open-debugger",
  "/debugger-frontend",
  "/open-stack-frame",
  "/symbolicate",
  "/events",
  "/status",
  "/_expo/debugger",
  "/_expo/error-overlay-meta",
  "/_expo/touch",
  "/_expo/open",
  "/_expo/plugins",
  "/_expo/atlas",
  "/_expo/loading",
  "/_expo/link",
] as const;

/** An RE2 pattern for ngrok's Traffic Policy: any of `paths` as a prefix, ignoring case. */
export function pathPrefixPattern(paths: readonly string[]): string {
  const escaped = paths.map((path) =>
    path.replace(/^\/+/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return `(?i)^/+(${escaped.join("|")})`;
}

/**
 * The configuration dev-phone.ts gives ngrok beside the owner's own (which holds the authtoken,
 * never read here): one agent, request inspection and its local web interface off (the inspector
 * keeps request bodies, which must never hold a locate photo), and two endpoints:
 *
 * - `api`: the reserved domain, to the API on loopback.
 * - `metro` (when Metro runs): a random ngrok address for this run, to Metro on loopback, with a
 *   Traffic Policy at ngrok's edge: GET and HEAD only, Metro's local-only endpoints refused, and
 *   the Origin of Metro's message socket replaced, so no client through the tunnel counts as the
 *   PC for its reload and dev-menu broadcasts.
 *
 * YAML is written with JSON's quoting, which YAML reads as the same strings.
 */
export function ngrokConfig(options: { domain: string; apiPort: number; metro: boolean }): string {
  const q = (value: string | number): string => JSON.stringify(value);
  const lines = [
    "# Written by pnpm dev:phone (scripts/dev-phone.ts) for each run. No secrets: ngrok reads its",
    "# authtoken from its own config, which is passed first.",
    'version: "3"',
    "agent:",
    "  web_addr: false",
    "  inspect_db_size: -1",
    "endpoints:",
    `  - name: ${ENDPOINTS.api}`,
    `    url: ${q(publicOrigin(options.domain))}`,
    "    upstream:",
    `      url: ${q(`http://127.0.0.1:${options.apiPort}`)}`,
  ];
  if (options.metro) {
    const localOnly = pathPrefixPattern(METRO_LOCAL_ONLY_PATHS);
    lines.push(
      `  - name: ${ENDPOINTS.metro}`,
      "    upstream:",
      // Metro listens on loopback as `localhost`, which is ::1 or 127.0.0.1; ngrok tries both.
      `      url: ${q(`http://localhost:${METRO_PORT}`)}`,
      "    traffic_policy:",
      "      on_http_request:",
      "        - expressions:",
      `            - ${q("!(req.method in ['GET', 'HEAD'])")}`,
      "          actions:",
      "            - type: deny",
      "              config:",
      "                status_code: 405",
      "        - expressions:",
      `            - ${q(`req.url.path.matches(${q(localOnly)}) || req.url.raw_path.matches(${q(localOnly)})`)}`,
      "          actions:",
      "            - type: deny",
      "              config:",
      "                status_code: 403",
      "        - expressions:",
      `            - ${q("req.url.path == '/message'")}`,
      "          actions:",
      "            - type: remove-headers",
      "              config:",
      "                headers: [origin]",
      "            - type: add-headers",
      "              config:",
      "                headers:",
      `                  origin: ${q("null")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The path of ngrok's own configuration, from `ngrok config check`, or undefined. */
export function ngrokConfigPath(checkOutput: string): string | undefined {
  const match = /^Valid configuration file at (.+?)\s*$/m.exec(checkOutput);
  return match?.[1];
}

/**
 * ngrok's arguments: dev:phone's endpoints, by name, in one agent session (as ngrok advises; plans
 * count agent sessions), and never an endpoint of the owner's own config. The log goes to stdout,
 * which dev-phone.ts filters (ngrokLogLine) into a git-ignored file; info level, for the "started
 * tunnel" lines that give the Metro endpoint's random address.
 */
export function ngrokArgs(
  ownConfig: string,
  devPhoneConfig: string,
  endpoints: readonly string[],
): string[] {
  return [
    "start",
    "--config",
    ownConfig,
    "--config",
    devPhoneConfig,
    "--log",
    "stdout",
    "--log-format",
    "logfmt",
    "--log-level",
    "info",
    ...endpoints,
  ];
}

/**
 * The API's environment: loopback only, the webapp's build at /, and /map/latest's file URLs on
 * the tunnel's https origin.
 */
export function apiEnv(
  base: NodeJS.ProcessEnv,
  options: { port: number; webDist: string; domain: string },
): NodeJS.ProcessEnv {
  return {
    ...base,
    API_HOST: "127.0.0.1",
    API_PORT: String(options.port),
    API_WEB_DIST: options.webDist,
    API_PUBLIC_FILES_URL: `${publicOrigin(options.domain)}/public/`,
    LOG_LEVEL: base["LOG_LEVEL"] || "info",
  };
}

/**
 * Expo CLI's arguments: Metro for Expo Go, or for the installed development build with
 * `devClient`, listening on loopback only (`--localhost`); the phone reaches it through ngrok's
 * Metro endpoint (EXPO_PACKAGER_PROXY_URL).
 */
export function expoArgs(options: { clear?: boolean; devClient?: boolean } = {}): string[] {
  return [
    "start",
    options.devClient ? "--dev-client" : "--go",
    "--localhost",
    "--port",
    String(METRO_PORT),
    ...(options.clear ? ["--clear"] : []),
  ];
}

/**
 * Metro's environment: the manifest and the bundle URLs on the Metro endpoint's https address
 * (EXPO_PACKAGER_PROXY_URL), the app's API on the reserved domain (EXPO_PUBLIC_API_URL), and no QR
 * code or "choose an app" page from Expo CLI: its QR code would hold an exp:// (http) URL, so
 * dev-phone.ts prints one for exps:// instead.
 */
export function expoEnv(
  base: NodeJS.ProcessEnv,
  options: { domain: string; metroUrl: string },
): NodeJS.ProcessEnv {
  return {
    ...base,
    EXPO_PUBLIC_API_URL: publicOrigin(options.domain),
    EXPO_PACKAGER_PROXY_URL: options.metroUrl,
    EXPO_NO_QR_CODE: "1",
    EXPO_NO_REDIRECT_PAGE: "1",
  };
}

export interface Options {
  /** Pass --clear to Metro (a stale shared cache). */
  readonly clear: boolean;
  /** Serve the installed development build instead of Expo Go. */
  readonly devClient: boolean;
  /** Don't publish the demo map when nothing is published. */
  readonly noDemo: boolean;
  readonly help: boolean;
}

export const USAGE = "usage: pnpm dev:phone [--dev-client] [--clear] [--no-demo]";

export function parseOptions(args: readonly string[]): Options {
  const known = new Set(["--dev-client", "--clear", "--no-demo", "--help", "-h"]);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length > 0) throw new SetupError(`Unknown argument ${unknown[0]}. ${USAGE}`);
  return {
    clear: args.includes("--clear"),
    devClient: args.includes("--dev-client"),
    noDemo: args.includes("--no-demo"),
    help: args.includes("--help") || args.includes("-h"),
  };
}

export interface ComposeService {
  readonly service: string;
  readonly state: string;
  /** "healthy", "starting", "unhealthy", or "" when the service has no health check. */
  readonly health: string;
}

/**
 * `docker compose ps --all --format json`: one JSON object per line (Compose 2.21 and later), or
 * one array (earlier).
 */
export function parseComposePs(stdout: string): ComposeService[] {
  const text = stdout.trim();
  if (text === "") return [];
  const items: unknown[] = text.startsWith("[")
    ? (JSON.parse(text) as unknown[])
    : text.split(/\r?\n/).map((line) => JSON.parse(line) as unknown);
  return items.map((item) => {
    const row = item as Record<string, unknown>;
    return {
      service: String(row["Service"] ?? ""),
      state: String(row["State"] ?? ""),
      health: String(row["Health"] ?? ""),
    };
  });
}

/** The services of `required` that aren't running and healthy (or running without a check). */
export function servicesNotReady(
  services: readonly ComposeService[],
  required: readonly string[] = STACK_SERVICES,
): string[] {
  return required.filter((name) => {
    const service = services.find((s) => s.service === name);
    return !(
      service !== undefined &&
      service.state === "running" &&
      (service.health === "" || service.health === "healthy")
    );
  });
}

function loopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127(\.\d{1,3}){3}$/.test(bare);
}

/**
 * Whether the database and the object store are on this machine, as `pnpm demo` requires (it
 * checks again itself). A DATABASE_URL whose query names another host, host address or service is
 * not local: the drivers would connect there instead.
 */
export function isLocalStack(env: NodeJS.ProcessEnv): boolean {
  try {
    const database = new URL(env["DATABASE_URL"] ?? "");
    const s3 = new URL(env["S3_ENDPOINT"] ?? "");
    const redirected = ["host", "hostaddr", "service"].some((name) =>
      database.searchParams.has(name),
    );
    return !redirected && loopback(database.hostname) && loopback(s3.hostname);
  } catch {
    return false;
  }
}

/** What latest.json says, for the summary, or undefined when it isn't a pointer. */
export function publishedVersion(body: string): { version: number; demo: boolean } | undefined {
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    if (!Number.isInteger(value["version"])) return undefined;
    return { version: value["version"] as number, demo: value["demo"] === true };
  } catch {
    return undefined;
  }
}

export type HealthAnswer =
  /** The API answered, and reaches PostGIS and every bucket. */
  | { readonly kind: "ok" }
  /** The API answered 503: it runs, but PostGIS or RustFS isn't reachable. */
  | { readonly kind: "unhealthy"; readonly detail: string }
  /** ngrok answered for the API: the endpoint isn't online yet, or the agent can't reach it. */
  | { readonly kind: "ngrok"; readonly code: string }
  | { readonly kind: "other"; readonly status: number };

/** Reads an answer to GET /health, through the tunnel or directly. */
export function classifyHealth(answer: {
  status: number;
  ngrokErrorCode?: string | null | undefined;
  body: string;
}): HealthAnswer {
  if (answer.ngrokErrorCode) return { kind: "ngrok", code: answer.ngrokErrorCode };
  let body: Record<string, unknown> | undefined;
  try {
    body = JSON.parse(answer.body) as Record<string, unknown>;
  } catch {
    body = undefined;
  }
  if (body === undefined || typeof body["status"] !== "string") {
    return { kind: "other", status: answer.status };
  }
  if (answer.status === 200) return { kind: "ok" };
  const problems = ["database", "storage"].flatMap((part) => {
    const check = body[part] as { ok?: unknown; problem?: unknown } | undefined;
    return check?.ok === false ? [`${part}: ${String(check.problem)}`] : [];
  });
  return { kind: "unhealthy", detail: problems.join(", ") || `HTTP ${answer.status}` };
}

/** Removes ANSI colour codes (Expo CLI colours its output when it thinks it may). */
function plain(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character starts the codes.
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** What `expo whoami` said. */
export type WhoamiAnswer =
  | { readonly kind: "signed-in"; readonly user: string }
  | { readonly kind: "not-signed-in" }
  /** It couldn't tell: offline, a DNS failure, Expo's API down, EXPO_OFFLINE set… */
  | { readonly kind: "failed"; readonly detail: string };

/**
 * Reads `expo whoami`: it prints the user and exits 0, or prints "Not logged in" on stderr and
 * exits 1. It asks Expo's API, so any other failure means it couldn't check, not that nobody is
 * signed in; the first line of its output says why (redacted, shortened). With EXPO_OFFLINE set
 * (`offline`) it says "Not logged in" without asking.
 */
export function parseWhoami(
  result: { status: number | null; stdout: string; stderr: string },
  offline = false,
): WhoamiAnswer {
  const lines = (text: string) =>
    plain(text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
  const out = lines(result.stdout);
  const err = lines(result.stderr);
  if ([...out, ...err].some((line) => /^not logged in\b/i.test(line))) {
    return offline
      ? { kind: "failed", detail: "EXPO_OFFLINE is set, so Expo CLI doesn't ask Expo's API" }
      : { kind: "not-signed-in" };
  }
  const user = out[0];
  if (result.status === 0 && user !== undefined && /^[\w.@+-]{1,64}$/.test(user)) {
    return { kind: "signed-in", user };
  }
  const first = err[0] ?? out[0];
  const detail =
    first === undefined
      ? `expo whoami exited with code ${result.status ?? "none"}`
      : redact(first).slice(0, 200);
  return { kind: "failed", detail };
}

/**
 * The development build's URL scheme: expo-dev-client registers `exp+` and the slug with
 * characters outside [A-Za-z0-9+.-] removed, lowercased (its getDefaultScheme). The slug is
 * "underground-sg" (apps/mapper/app.config.ts; a test keeps the two in step).
 */
export const DEV_CLIENT_SCHEME = "exp+underground-sg";

/**
 * The deep link that opens the installed development build on Metro's https address, as Expo
 * CLI builds it for `--dev-client` (UrlCreator.constructDevClientUrl).
 */
export function devClientUrl(metroUrl: string): string {
  const origin = new URL(metroUrl).origin;
  return `${DEV_CLIENT_SCHEME}://expo-development-client/?url=${encodeURIComponent(origin)}`;
}

/** The exps:// URL Expo Go opens for Metro's https address: exps:// is exp:// over https. */
export function expoGoUrl(metroUrl: string): string {
  return `exps://${new URL(metroUrl).host}`;
}

/**
 * Checks the manifest Metro served through the tunnel: Expo Go loads the JavaScript from
 * `launchAsset.url`, which has to be on the Metro endpoint's address and https (an on-path
 * attacker could rewrite plain HTTP). Gives the problem, or undefined when it is right.
 */
export function manifestProblem(manifest: string, metroUrl: string): string | undefined {
  let launch: unknown;
  try {
    launch = (JSON.parse(manifest) as { launchAsset?: { url?: unknown } }).launchAsset?.url;
  } catch {
    return "Metro's manifest isn't JSON";
  }
  if (typeof launch !== "string") return "Metro's manifest has no launchAsset.url";
  let url: URL;
  try {
    url = new URL(launch);
  } catch {
    return "Metro's manifest has a launchAsset.url that isn't a URL";
  }
  const expected = new URL(metroUrl);
  if (url.protocol !== "https:") return `the app's JavaScript would load over ${url.protocol}`;
  if (url.host !== expected.host) return `the app's JavaScript would load from ${url.host}`;
  return undefined;
}

/** Masks anything that looks like a credential: long runs of token characters. */
export function redact(line: string): string {
  return line.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]");
}

/**
 * A problem in one line of ngrok's logfmt log (`lvl=eror` or `lvl=crit`, with `err=`), redacted,
 * or undefined for any other line.
 */
export function ngrokProblem(line: string): string | undefined {
  if (!/\blvl=(eror|crit)\b/.test(line)) return undefined;
  const err = /\berr="((?:[^"\\]|\\.)*)"/.exec(line)?.[1] ?? /\berr=(\S+)/.exec(line)?.[1];
  const msg = /\bmsg="((?:[^"\\]|\\.)*)"/.exec(line)?.[1];
  const text = (err ?? msg ?? line).replace(/\\n/g, " ").replace(/\\"/g, '"');
  return redact(text.trim());
}

/** An endpoint ngrok started, from its "started tunnel" log line: its name and public URL. */
export function ngrokStarted(line: string): { name: string; url: string } | undefined {
  if (!/\bmsg="started tunnel"/.test(line)) return undefined;
  const name = /\bname=(\S+)/.exec(line)?.[1];
  const url = /\burl=(https:\/\/[a-z0-9.-]+)(?=\s|$)/i.exec(line)?.[1];
  return name === undefined || url === undefined ? undefined : { name, url: url.toLowerCase() };
}

/**
 * What of one ngrok log line goes to the log file, or undefined to leave it out. At info level
 * ngrok logs every connection with the visitor's IP address and port ("join connections", `r=`):
 * personal data the log has no use for, so those lines are dropped and any `r=` field removed.
 */
export function ngrokLogLine(line: string): string | undefined {
  if (/\bmsg="join connections"|\bobj=join\b/.test(line)) return undefined;
  return redact(line.replace(/\s+r=\S+/g, ""));
}

/** A row of the process table: Windows' Win32_Process, creation time in ms since 1970. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly created: number;
}

/** A process dev-phone.ts started, with when (and whether) it ended. */
export interface StartedProcess {
  readonly pid: number;
  readonly startedAt: number;
  readonly exitedAt?: number | undefined;
}

/** Windows FILETIME (100 ns since 1601) to ms since 1970. */
export function fromFileTime(fileTime: number): number {
  return fileTime / 10_000 - 11_644_473_600_000;
}

/** Lines of "<pid> <ppid> <creation FILETIME>", as dev-phone.ts asks PowerShell for them. */
export function parseProcessTable(stdout: string): ProcessRow[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (match === null) return [];
    return [
      { pid: Number(match[1]), ppid: Number(match[2]), created: fromFileTime(Number(match[3])) },
    ];
  });
}

/** Windows reports creation times finer than Date.now() ticks; allow for the difference. */
const CLOCK_SLACK_MS = 1_000;

/**
 * The processes to stop: the started processes still running, and every descendant of any of them
 * (also of one that has exited, whose children Windows doesn't move to another parent). A process
 * counts as a child only if it was created while its parent ran, so a process that took a reused
 * PID, or the children of one, is never included: nothing the owner runs elsewhere is touched.
 */
export function processesToStop(
  table: readonly ProcessRow[],
  started: readonly StartedProcess[],
): number[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of table) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const stop = new Set<number>();
  const visit = (pid: number, from: number, until: number | undefined): void => {
    for (const child of children.get(pid) ?? []) {
      if (stop.has(child.pid) || child.pid === pid) continue;
      if (child.created < from - CLOCK_SLACK_MS) continue;
      if (until !== undefined && child.created > until + CLOCK_SLACK_MS) continue;
      stop.add(child.pid);
      visit(child.pid, child.created, undefined);
    }
  };
  for (const process of started) {
    const self = table.find((row) => row.pid === process.pid);
    const ours =
      self !== undefined &&
      process.exitedAt === undefined &&
      self.created >= process.startedAt - CLOCK_SLACK_MS;
    if (ours) stop.add(process.pid);
    visit(process.pid, process.startedAt, process.exitedAt);
  }
  return [...stop].sort((a, b) => a - b);
}

/** A network interface address, as `os.networkInterfaces()` lists them. */
export interface InterfaceAddress {
  readonly address: string;
  readonly family: string | number;
  readonly internal: boolean;
}

/**
 * This PC's addresses on its networks, where nothing dev:phone starts may answer: every
 * non-loopback IPv4 address, and IPv6 ones except link-local (which need a zone to connect to).
 */
export function lanAddresses(
  interfaces: Readonly<Record<string, readonly InterfaceAddress[] | undefined>>,
): string[] {
  const addresses = Object.values(interfaces).flatMap((list) => list ?? []);
  return [
    ...new Set(
      addresses
        .filter((entry) => !entry.internal)
        .filter((entry) => {
          const v6 = entry.family === "IPv6" || entry.family === 6;
          return !v6 || !/^fe[89ab]/i.test(entry.address);
        })
        .map((entry) => entry.address),
    ),
  ];
}

/**
 * A QR code for the terminal, from its modules (row by row, 1 for dark, `size` x `size`), as
 * toqr encodes it: two rows per line with half blocks, light on dark like Expo CLI's, with a
 * quiet zone of one module.
 */
export function qrText(modules: Uint8Array, size: number): string {
  const dark = (row: number, col: number): boolean =>
    row >= 0 && row < size && col >= 0 && col < size && modules[row * size + col] === 1;
  const lines: string[] = [];
  for (let row = -1; row < size + 1; row += 2) {
    let line = "";
    for (let col = -1; col < size + 1; col++) {
      // The terminal's glyph draws light: a dark module is a gap.
      const top = !dark(row, col);
      const bottom = !dark(row + 1, col) && row + 1 < size + 1;
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** How the phone opens the mapper app, or why Metro isn't running. */
export type MetroState =
  | {
      readonly kind: "running";
      /** Expo Go (exps:// URL, needs the same Expo account) or the installed development build. */
      readonly client: "expo-go" | "dev-client";
      /** The Expo account on this PC, when known (Expo Go needs it). */
      readonly user?: string | undefined;
      /** The exps:// URL (Expo Go) or the exp+underground-sg:// deep link (development build). */
      readonly url: string;
      /** Metro's https address, which the development build's launcher also accepts. */
      readonly metroUrl?: string | undefined;
      /** Its QR code (qrText), when one could be made. */
      readonly qr?: string | undefined;
    }
  | { readonly kind: "not-signed-in" }
  | { readonly kind: "whoami-failed"; readonly detail: string };

/** The summary dev-phone.ts prints once everything runs. */
export function summary(options: {
  domain: string;
  published: { version: number; demo: boolean } | undefined;
  metro: MetroState;
  logs: string;
}): string {
  const origin = publicOrigin(options.domain);
  const map =
    options.published === undefined
      ? "no map is published yet (Safari shows the street map only)"
      : `map version ${options.published.version}${options.published.demo ? " (the demo map)" : ""}`;
  const lines = ["", "Ready to test on the iPhone", "", `  Safari:   ${origin}   (${map})`];
  const { metro } = options;
  if (metro.kind === "running" && metro.client === "dev-client") {
    lines.push(
      "  Dev build: open the installed Underground SG Mapper (the development build, not Expo Go).",
      metro.qr === undefined
        ? "            In its launcher, tap Enter URL manually and type"
        : "            Scan this QR code with the iPhone's Camera app, or in its launcher tap Enter URL manually and type",
      `            ${metro.metroUrl ?? metro.url}`,
      "            (https; a new address each run.)",
      `            The app reaches the API at ${origin}.`,
    );
    if (metro.qr !== undefined) lines.push("", metro.qr);
  } else if (metro.kind === "running") {
    lines.push(
      `  Expo Go:  signed in as ${metro.user ?? "(unknown)"} on this PC; sign in to the same account in Expo Go.`,
      metro.qr === undefined
        ? "            In Expo Go, tap Enter URL manually and type"
        : "            Scan this QR code with the iPhone's Camera app, or in Expo Go enter",
      `            ${metro.url}`,
      "            (https; a new address each run. Not Metro's exp:// address above: that is http.)",
      `            The app reaches the API at ${origin}.`,
    );
    if (metro.qr !== undefined) lines.push("", metro.qr);
  } else if (metro.kind === "not-signed-in") {
    lines.push(
      "  Expo Go:  Metro isn't running: Expo CLI isn't signed in. Run",
      "            pnpm --filter @usg/mapper exec expo login",
      "            with the account Expo Go on the phone uses, then start pnpm dev:phone again.",
    );
  } else {
    lines.push(
      `  Expo Go:  Metro isn't running: couldn't check the Expo sign-in: ${metro.detail}`,
      "            Safari works; check the connection and start pnpm dev:phone again later.",
    );
  }
  lines.push(
    `  Logs:     ${options.logs}`,
    "  Stop:     Ctrl+C here. It stops Metro, the tunnel and the API this started, nothing else.",
    "",
  );
  return lines.join("\n");
}
