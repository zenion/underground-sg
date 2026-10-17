import { readFileSync } from "node:fs";
// The pure parts of `pnpm dev:phone` (dev-phone-lib.ts): settings, the children's arguments,
// environments and ngrok configuration, reading Docker's, the API's, ngrok's and Expo's answers,
// the summary and its QR code, and which processes it stops.

import { describe, expect, test } from "vitest";
import {
  apiEnv,
  apiPort,
  classifyHealth,
  DEFAULT_API_PORT,
  DEV_CLIENT_SCHEME,
  devClientUrl,
  expoArgs,
  expoEnv,
  expoGoUrl,
  fromFileTime,
  isLocalStack,
  lanAddresses,
  METRO_LOCAL_ONLY_PATHS,
  METRO_PORT,
  manifestProblem,
  ngrokArgs,
  ngrokConfig,
  ngrokConfigPath,
  ngrokDomain,
  ngrokLogLine,
  ngrokProblem,
  ngrokStarted,
  parseComposePs,
  parseOptions,
  parseProcessTable,
  parseWhoami,
  pathPrefixPattern,
  processesToStop,
  publicOrigin,
  publishedVersion,
  qrText,
  redact,
  SetupError,
  servicesNotReady,
  summary,
} from "../dev-phone-lib.ts";

describe("settings", () => {
  test("NGROK_DOMAIN: a host name, forgiving https:// and a trailing slash", () => {
    expect(ngrokDomain("example.ngrok.app")).toBe("example.ngrok.app");
    expect(ngrokDomain(" https://Example.ngrok.app/ ")).toBe("example.ngrok.app");
    expect(publicOrigin("example.ngrok.app")).toBe("https://example.ngrok.app");
  });

  test("NGROK_DOMAIN unset: says what to set, and that the authtoken stays out of .env", () => {
    for (const value of [undefined, "", "  "]) {
      expect(() => ngrokDomain(value)).toThrow(SetupError);
    }
    expect(() => ngrokDomain(undefined)).toThrow(/NGROK_DOMAIN=example\.ngrok\.app/);
    expect(() => ngrokDomain(undefined)).toThrow(/ngrok config add-authtoken/);
  });

  test.each([
    "example.ngrok.app/path",
    "example.ngrok.app:443",
    "http://example.ngrok.app",
    "localhost",
    "exa mple.ngrok.app",
    "abc-xennion-8081.exp.direct",
    "-bad.ngrok.app",
  ])("NGROK_DOMAIN %s is refused", (value) => {
    expect(() => ngrokDomain(value)).toThrow(/must be a domain name/);
  });

  test("API_PORT, 28000 by default", () => {
    expect(apiPort(undefined)).toBe(DEFAULT_API_PORT);
    expect(apiPort("")).toBe(28000);
    expect(apiPort("28010")).toBe(28010);
    for (const value of ["0", "65536", "28000x", "-1"]) {
      expect(() => apiPort(value), value).toThrow(SetupError);
    }
  });

  test("options", () => {
    expect(parseOptions([])).toEqual({
      clear: false,
      devClient: false,
      noDemo: false,
      help: false,
    });
    expect(parseOptions(["--clear", "--no-demo"])).toEqual({
      clear: true,
      devClient: false,
      noDemo: true,
      help: false,
    });
    expect(parseOptions(["--dev-client"]).devClient).toBe(true);
    expect(parseOptions(["-h"]).help).toBe(true);
    expect(() => parseOptions(["--tunnel"])).toThrow(/Unknown argument --tunnel/);
  });
});

describe("the children's arguments, environments and ngrok configuration", () => {
  test("ngrok: dev:phone's endpoints by name, in one agent, with its own config for the token", () => {
    const args = ngrokArgs(
      "C:\\Users\\o\\AppData\\Local\\ngrok\\ngrok.yml",
      "C:\\repo\\ngrok.yml",
      ["api", "metro"],
    );
    expect(args).toEqual([
      "start",
      "--config",
      "C:\\Users\\o\\AppData\\Local\\ngrok\\ngrok.yml",
      "--config",
      "C:\\repo\\ngrok.yml",
      "--log",
      "stdout",
      "--log-format",
      "logfmt",
      "--log-level",
      "info",
      "api",
      "metro",
    ]);
    // Not --all: an endpoint the owner defined in ngrok's own config never starts.
    expect(args).not.toContain("--all");
    // Never an authtoken on the command line (process lists show it): ngrok reads its own config.
    expect(args.join(" ")).not.toMatch(/authtoken/i);
  });

  test("ngrok's own config path, from ngrok config check", () => {
    expect(
      ngrokConfigPath(
        "Valid configuration file at C:\\Users\\o\\AppData\\Local\\ngrok\\ngrok.yml\r\n",
      ),
    ).toBe("C:\\Users\\o\\AppData\\Local\\ngrok\\ngrok.yml");
    expect(ngrokConfigPath("Valid configuration file at /home/o/.config/ngrok/ngrok.yml\n")).toBe(
      "/home/o/.config/ngrok/ngrok.yml",
    );
    expect(ngrokConfigPath("ERROR: authentication failed")).toBeUndefined();
  });

  test("dev:phone's ngrok config: inspection and the web interface off, the API on the domain", () => {
    const config = ngrokConfig({ domain: "example.ngrok.app", apiPort: 28000, metro: false });
    expect(config).toContain('version: "3"');
    expect(config).toContain("  web_addr: false\n  inspect_db_size: -1\n");
    expect(config).toContain(
      '  - name: api\n    url: "https://example.ngrok.app"\n    upstream:\n      url: "http://127.0.0.1:28000"\n',
    );
    expect(config).not.toContain("name: metro");
    // No credentials: ngrok reads them from its own config.
    expect(config).not.toMatch(/^s*(authtoken|api_key)s*:/m);
  });

  test("dev:phone's ngrok config: Metro on a random address, behind a Traffic Policy", () => {
    const config = ngrokConfig({ domain: "example.ngrok.app", apiPort: 28000, metro: true });
    const metro = config.slice(config.indexOf("  - name: metro"));
    // No url: ngrok gives the endpoint a random address for the run.
    expect(metro).not.toMatch(/^ {4}url:/m);
    expect(metro).toContain('      url: "http://localhost:8081"');
    expect(metro).toContain(`"!(req.method in ['GET', 'HEAD'])"`);
    expect(metro).toContain("status_code: 405");
    expect(metro).toContain("status_code: 403");
    // The pattern is a CEL string inside a YAML string.
    const cel = JSON.stringify(pathPrefixPattern(METRO_LOCAL_ONLY_PATHS));
    expect(metro).toContain(`req.url.path.matches(${JSON.stringify(cel).slice(1, -1)})`);
    expect(metro).toContain("req.url.raw_path.matches(");
    expect(metro).toMatch(
      /- type: remove-headers\n {14}config:\n {16}headers: \[origin\]\n {12}- type: add-headers\n {14}config:\n {16}headers:\n {18}origin: "null"/,
    );
  });

  test("the local-only pattern catches Metro's debugger, whatever the case or slashes", () => {
    const pattern = pathPrefixPattern(METRO_LOCAL_ONLY_PATHS);
    expect(pattern.startsWith("(?i)^/+(")).toBe(true);
    // RE2's (?i) is JavaScript's i flag.
    const regex = new RegExp(pattern.replace("(?i)", ""), "i");
    for (const path of [
      "/json",
      "/json/list",
      "/json/version",
      "/JSON/version",
      "//json/list",
      "/inspector/debug",
      "/inspector/network",
      "/open-debugger",
      "/debugger-frontend/rn_fusebox.html",
      "/open-stack-frame",
      "/symbolicate",
      "/events",
      "/status",
      "/STATUS",
      "/_expo/debugger",
      "/_EXPO/Debugger/x",
      "/_expo/error-overlay-meta",
      "/_expo/touch",
      "/_expo/open",
      "/_expo/plugins/expo-x/ws",
      "/_expo/atlas",
      "/_expo/loading",
      "/_expo/link",
    ]) {
      expect(regex.test(path), path).toBe(true);
    }
    // What Expo Go needs: the manifest, the bundles, assets, the DOM component, HMR, the message
    // socket and the phone's own inspector connection.
    for (const path of [
      "/",
      "/apps/mapper/node_modules/expo-router/entry.bundle",
      "/assets/apps/mapper/assets/icon.png",
      "/_expo/@dom/draw-map.tsx",
      "/hot",
      "/message",
      "/inspector/device",
      "/public/json",
    ]) {
      expect(regex.test(path), path).toBe(false);
    }
  });

  test("the API: loopback only, the webapp's build, file URLs on the tunnel's origin", () => {
    const env = apiEnv(
      { PATH: "x", API_HOST: "0.0.0.0", LOG_LEVEL: "" },
      { port: 28000, webDist: "C:\\repo\\apps\\web\\dist", domain: "example.ngrok.app" },
    );
    expect(env).toMatchObject({
      PATH: "x",
      API_HOST: "127.0.0.1",
      API_PORT: "28000",
      API_WEB_DIST: "C:\\repo\\apps\\web\\dist",
      API_PUBLIC_FILES_URL: "https://example.ngrok.app/public/",
      LOG_LEVEL: "info",
    });
    expect(
      apiEnv({ LOG_LEVEL: "debug" }, { port: 1, webDist: "d", domain: "a.b.co" }),
    ).toMatchObject({ LOG_LEVEL: "debug" });
  });

  test("Metro: Expo Go on loopback, a fixed port, no Expo tunnel", () => {
    expect(expoArgs()).toEqual(["start", "--go", "--localhost", "--port", String(METRO_PORT)]);
    expect(expoArgs({ clear: true })).toContain("--clear");
    expect(expoArgs()).not.toContain("--tunnel");
    // The installed development build instead of Expo Go: same loopback-only Metro.
    expect(expoArgs({ devClient: true })).toEqual([
      "start",
      "--dev-client",
      "--localhost",
      "--port",
      String(METRO_PORT),
    ]);
  });

  test("Metro: URLs on the Metro endpoint's https address, the API on the domain, no QR", () => {
    expect(
      expoEnv({ PATH: "x" }, { domain: "example.ngrok.app", metroUrl: "https://ab12.ngrok.app" }),
    ).toEqual({
      PATH: "x",
      EXPO_PUBLIC_API_URL: "https://example.ngrok.app",
      EXPO_PACKAGER_PROXY_URL: "https://ab12.ngrok.app",
      EXPO_NO_QR_CODE: "1",
      EXPO_NO_REDIRECT_PAGE: "1",
    });
  });
});

describe("state checks", () => {
  const line = (service: string, state: string, health: string) =>
    JSON.stringify({ Service: service, State: state, Health: health, Name: `usg-${service}-1` });

  test("docker compose ps: JSON lines or an array", () => {
    const lines = [line("postgis", "running", "healthy"), line("rustfs", "running", "healthy")];
    expect(parseComposePs(lines.join("\n"))).toEqual([
      { service: "postgis", state: "running", health: "healthy" },
      { service: "rustfs", state: "running", health: "healthy" },
    ]);
    expect(parseComposePs(`[${lines.join(",")}]`)).toHaveLength(2);
    expect(parseComposePs("")).toEqual([]);
  });

  test("which services still need docker compose up", () => {
    const ps = (...rows: string[]) => parseComposePs(rows.join("\r\n"));
    expect(
      servicesNotReady(ps(line("postgis", "running", "healthy"), line("rustfs", "running", ""))),
    ).toEqual([]);
    expect(
      servicesNotReady(
        ps(line("postgis", "running", "starting"), line("rustfs", "exited", "unhealthy")),
      ),
    ).toEqual(["postgis", "rustfs"]);
    expect(servicesNotReady(ps(line("postgis", "running", "healthy")))).toEqual(["rustfs"]);
    expect(servicesNotReady([])).toEqual(["postgis", "rustfs"]);
  });

  test("a local stack: the database and S3 on loopback, no redirecting query", () => {
    const local = {
      DATABASE_URL: "postgres://usg:usg-local-only@localhost:25432/usg?sslmode=disable",
      S3_ENDPOINT: "http://localhost:29000",
    };
    expect(isLocalStack(local)).toBe(true);
    expect(isLocalStack({ ...local, S3_ENDPOINT: "http://127.0.0.1:29000" })).toBe(true);
    expect(isLocalStack({ ...local, DATABASE_URL: "postgres://u:p@[::1]:5432/usg" })).toBe(true);
    expect(isLocalStack({ ...local, DATABASE_URL: "postgres://u:p@db.example.com/usg" })).toBe(
      false,
    );
    expect(
      isLocalStack({ ...local, DATABASE_URL: `${local.DATABASE_URL}&host=db.example.com` }),
    ).toBe(false);
    expect(isLocalStack({ ...local, S3_ENDPOINT: "https://s3.ap-southeast-1.amazonaws.com" })).toBe(
      false,
    );
    expect(isLocalStack({})).toBe(false);
  });

  test("latest.json: the version and the demo flag, or nothing", () => {
    expect(publishedVersion('{"schema_version":1,"version":3,"demo":true}')).toEqual({
      version: 3,
      demo: true,
    });
    expect(publishedVersion('{"version":4}')).toEqual({ version: 4, demo: false });
    expect(publishedVersion('{"statusCode":404}')).toBeUndefined();
    expect(publishedVersion("<html>")).toBeUndefined();
  });

  test("GET /health: the API's answer, ngrok's, or something else", () => {
    const ok = JSON.stringify({ status: "ok", database: { ok: true }, storage: { ok: true } });
    expect(classifyHealth({ status: 200, body: ok })).toEqual({ kind: "ok" });
    const down = JSON.stringify({
      status: "unavailable",
      database: { ok: false, problem: "unreachable" },
      storage: { ok: true, problem: null },
    });
    expect(classifyHealth({ status: 503, body: down })).toEqual({
      kind: "unhealthy",
      detail: "database: unreachable",
    });
    expect(
      classifyHealth({
        status: 404,
        ngrokErrorCode: "ERR_NGROK_3200",
        body: "<html>offline</html>",
      }),
    ).toEqual({ kind: "ngrok", code: "ERR_NGROK_3200" });
    expect(classifyHealth({ status: 502, body: "<html>" })).toEqual({ kind: "other", status: 502 });
    expect(classifyHealth({ status: 200, body: '{"hello":1}' })).toEqual({
      kind: "other",
      status: 200,
    });
  });

  test("expo whoami: the user", () => {
    expect(parseWhoami({ status: 0, stdout: "xennion\n", stderr: "" })).toEqual({
      kind: "signed-in",
      user: "xennion",
    });
    expect(
      parseWhoami({ status: 0, stdout: "\n  \u001b[32mxennion\u001b[39m  \r\n", stderr: "" }),
    ).toEqual({ kind: "signed-in", user: "xennion" });
  });

  test("expo whoami: not signed in only when it says so", () => {
    // Expo CLI 57 prints it on stderr and exits 1.
    expect(parseWhoami({ status: 1, stdout: "", stderr: "Not logged in\n" })).toEqual({
      kind: "not-signed-in",
    });
    expect(parseWhoami({ status: 0, stdout: "Not logged in\n", stderr: "" })).toEqual({
      kind: "not-signed-in",
    });
  });

  test("expo whoami: any other failure is a failed check, with its first line", () => {
    // Offline, with credentials saved: getUserAsync asks Expo's API, which throws. (Expo CLI
    // 57's output when nothing answers.)
    expect(
      parseWhoami({
        status: 1,
        stdout: "",
        stderr:
          "UnexpectedServerError: connect ECONNREFUSED 127.0.0.1:1\nUnexpectedServerError: connect ECONNREFUSED 127.0.0.1:1\n    at request (C:\\x\\client.js:197:34)\n",
      }),
    ).toEqual({
      kind: "failed",
      detail: "UnexpectedServerError: connect ECONNREFUSED 127.0.0.1:1",
    });
    // EXPO_OFFLINE: Expo CLI says "Not logged in" without asking.
    expect(parseWhoami({ status: 1, stdout: "", stderr: "Not logged in\n" }, true)).toEqual({
      kind: "failed",
      detail: "EXPO_OFFLINE is set, so Expo CLI doesn't ask Expo's API",
    });
    expect(parseWhoami({ status: null, stdout: "", stderr: "" })).toEqual({
      kind: "failed",
      detail: "expo whoami exited with code none",
    });
    expect(
      parseWhoami({ status: 1, stdout: "", stderr: `Error: token ${"A1b2".repeat(10)} refused` }),
    ).toEqual({ kind: "failed", detail: "Error: token [redacted] refused" });
    // Something that isn't a user name, even with exit code 0.
    expect(
      parseWhoami({ status: 0, stdout: "Something went wrong: try again", stderr: "" }).kind,
    ).toBe("failed");
  });

  test("the exps:// URL Expo Go opens: the Metro endpoint over https", () => {
    expect(expoGoUrl("https://ab12cd34ef56.ngrok.app")).toBe("exps://ab12cd34ef56.ngrok.app");
  });

  test("the manifest through the tunnel has to load the app over https from the endpoint", () => {
    const metroUrl = "https://ab12cd34ef56.ngrok.app";
    const manifest = (url: unknown) =>
      JSON.stringify({ id: "x", launchAsset: { key: "bundle", url }, extra: {} });
    const bundle = "/apps/mapper/node_modules/expo-router/entry.bundle?platform=ios&dev=true";
    expect(manifestProblem(manifest(`https://ab12cd34ef56.ngrok.app:443${bundle}`), metroUrl)).toBe(
      undefined,
    );
    expect(manifestProblem(manifest(`https://ab12cd34ef56.ngrok.app${bundle}`), metroUrl)).toBe(
      undefined,
    );
    expect(manifestProblem(manifest(`http://ab12cd34ef56.ngrok.app${bundle}`), metroUrl)).toBe(
      "the app's JavaScript would load over http:",
    );
    expect(manifestProblem(manifest(`https://127.0.0.1:8081${bundle}`), metroUrl)).toBe(
      "the app's JavaScript would load from 127.0.0.1:8081",
    );
    expect(manifestProblem(manifest(undefined), metroUrl)).toBe(
      "Metro's manifest has no launchAsset.url",
    );
    expect(manifestProblem("--abc--\r\ncontent-type: multipart", metroUrl)).toBe(
      "Metro's manifest isn't JSON",
    );
  });

  test("this PC's network addresses: not loopback, not IPv6 link-local", () => {
    expect(
      lanAddresses({
        "Loopback Pseudo-Interface 1": [
          { address: "127.0.0.1", family: "IPv4", internal: true },
          { address: "::1", family: "IPv6", internal: true },
        ],
        "Wi-Fi": [
          { address: "192.168.1.20", family: "IPv4", internal: false },
          { address: "fe80::1c2d:3e4f:5a6b:7c8d", family: "IPv6", internal: false },
          { address: "2001:db8::20", family: "IPv6", internal: false },
        ],
        "vEthernet (WSL)": [{ address: "172.20.0.1", family: 4, internal: false }],
        Down: undefined,
      }),
    ).toEqual(["192.168.1.20", "2001:db8::20", "172.20.0.1"]);
  });
});

describe("ngrok's log", () => {
  test("the endpoints ngrok started, by name", () => {
    expect(
      ngrokStarted(
        't=2026-10-15T20:48:48+0800 lvl=info msg="started tunnel" obj=tunnels name=metro addr=http://localhost:8081 url=https://EAAA788E7AE9.ngrok.app',
      ),
    ).toEqual({ name: "metro", url: "https://eaaa788e7ae9.ngrok.app" });
    expect(
      ngrokStarted(
        'lvl=info msg="started tunnel" obj=tunnels name=api addr=http://127.0.0.1:28000 url=https://example.ngrok.app',
      ),
    ).toEqual({ name: "api", url: "https://example.ngrok.app" });
    expect(ngrokStarted('lvl=info msg="tunnel session started" obj=tunnels.session')).toBe(
      undefined,
    );
  });

  test("the log file keeps no visitor's IP address", () => {
    expect(
      ngrokLogLine(
        't=2026-10-15T20:17:13+0800 lvl=info msg="join connections" obj=join id=5b1c l=127.0.0.1:28000 r=203.0.113.7:50980',
      ),
    ).toBeUndefined();
    expect(ngrokLogLine("lvl=dbug msg=x obj=join id=1 r=[2001:db8::7]:443")).toBeUndefined();
    expect(ngrokLogLine('lvl=warn msg="slow" l=127.0.0.1:8081 r=203.0.113.7:50980 x=1')).toBe(
      'lvl=warn msg="slow" l=127.0.0.1:8081 x=1',
    );
    expect(ngrokLogLine('lvl=info msg="client session established" obj=tunnels.session')).toBe(
      'lvl=info msg="client session established" obj=tunnels.session',
    );
  });

  test("errors are picked out of logfmt lines, redacted", () => {
    expect(
      ngrokProblem(
        't=2026-10-15T20:00:00+0800 lvl=eror msg="failed to reconnect session" obj=tunnels.session err="ERR_NGROK_334: The endpoint \\"https://example.ngrok.app\\" is already online."',
      ),
    ).toBe('ERR_NGROK_334: The endpoint "https://example.ngrok.app" is already online.');
    expect(
      ngrokProblem(
        `t=x lvl=crit msg="command failed" err="authentication failed: ${"A1b2".repeat(12)}"`,
      ),
    ).toBe("authentication failed: [redacted]");
    expect(ngrokProblem('t=x lvl=info msg="started tunnel" url=https://example.ngrok.app')).toBe(
      undefined,
    );
  });

  test("redact masks token-like runs and leaves the rest", () => {
    const token = "2abcDEF345ghiJKL678mnoPQR901stuVWX_yz";
    expect(redact(`authtoken: ${token} for example.ngrok.app`)).toBe(
      "authtoken: [redacted] for example.ngrok.app",
    );
    expect(redact("ERR_NGROK_3200 offline")).toBe("ERR_NGROK_3200 offline");
  });
});

describe("which processes are stopped", () => {
  const T0 = Date.parse("2026-10-16T07:00:00+08:00");
  const at = (seconds: number) => T0 + seconds * 1_000;
  /** Our node is 100; it started the API (200), ngrok (300) and Metro (400). */
  const table = [
    { pid: 100, ppid: 50, created: at(-10) },
    { pid: 200, ppid: 100, created: at(1) },
    { pid: 300, ppid: 100, created: at(2) },
    { pid: 400, ppid: 100, created: at(3) },
    // Metro's children: Expo's ngrok agent and a Metro worker, and the worker's child.
    { pid: 410, ppid: 400, created: at(5) },
    { pid: 420, ppid: 400, created: at(6) },
    { pid: 421, ppid: 420, created: at(7) },
    // The owner's own node and ngrok, started before and elsewhere: never touched.
    { pid: 900, ppid: 60, created: at(-3600) },
    { pid: 901, ppid: 900, created: at(-3500) },
    { pid: 950, ppid: 60, created: at(20) },
  ];

  test("everything started and running, with every descendant; nothing else", () => {
    const started = [
      { pid: 200, startedAt: at(1) },
      { pid: 300, startedAt: at(2) },
      { pid: 400, startedAt: at(3) },
    ];
    expect(processesToStop(table, started)).toEqual([200, 300, 400, 410, 420, 421]);
  });

  test("the children of one that already exited, which Windows leaves where they are", () => {
    const started = [{ pid: 400, startedAt: at(3), exitedAt: at(30) }];
    const withoutMetro = table.filter((row) => row.pid !== 400);
    expect(processesToStop(withoutMetro, started)).toEqual([410, 420, 421]);
  });

  test("a PID reused after the process exited, and its children, are not ours", () => {
    const reused = [
      ...table.filter((row) => ![400, 410, 420, 421].includes(row.pid)),
      // Another program got PID 400 a minute after Metro exited, and started 401.
      { pid: 400, ppid: 60, created: at(90) },
      { pid: 401, ppid: 400, created: at(91) },
    ];
    const started = [{ pid: 400, startedAt: at(3), exitedAt: at(30) }];
    expect(processesToStop(reused, started)).toEqual([]);
  });

  test("a process whose PID was another's before the start is not counted as a child", () => {
    const old = [
      { pid: 200, ppid: 100, created: at(1) },
      // Its parent was an earlier holder of PID 200.
      { pid: 210, ppid: 200, created: at(-500) },
    ];
    expect(processesToStop(old, [{ pid: 200, startedAt: at(1) }])).toEqual([200]);
  });

  test("Windows' process table lines and FILETIME", () => {
    // 2026-10-16T07:00:00+08:00 as FILETIME.
    const fileTime = (T0 + 11_644_473_600_000) * 10_000;
    expect(fromFileTime(fileTime)).toBe(T0);
    expect(
      parseProcessTable(`4 0 ${fileTime}\r\n\r\n  200 100 ${fileTime}  \nnot a row\n`),
    ).toEqual([
      { pid: 4, ppid: 0, created: T0 },
      { pid: 200, ppid: 100, created: T0 },
    ]);
  });
});

describe("the development build", () => {
  test("its deep link opens Metro's https origin, as Expo CLI builds it", () => {
    expect(devClientUrl("https://ab12cd34ef56.ngrok.app")).toBe(
      "exp+underground-sg://expo-development-client/?url=https%3A%2F%2Fab12cd34ef56.ngrok.app",
    );
    // Only the origin: a path or query on Metro's address never reaches the launcher.
    expect(devClientUrl("https://ab12cd34ef56.ngrok.app/x?y=1")).toBe(
      devClientUrl("https://ab12cd34ef56.ngrok.app"),
    );
  });

  test("its scheme follows the app's slug (expo-dev-client: exp+ and the cleaned, lowercased slug)", () => {
    const config = readFileSync(
      new URL("../../apps/mapper/app.config.ts", import.meta.url),
      "utf8",
    );
    const slug = /\bslug:\s*"([^"]+)"/.exec(config)?.[1];
    expect(slug).toBeDefined();
    const expected = `exp+${(slug ?? "").replace(/[^A-Za-z0-9+\-.]/g, "").toLowerCase()}`;
    expect(DEV_CLIENT_SCHEME).toBe(expected);
  });
});

describe("the summary", () => {
  const base = { domain: "example.ngrok.app", logs: ".data/dev-phone" };

  test("the Safari URL, the exps:// URL and its QR code, and how to stop", () => {
    const text = summary({
      ...base,
      published: { version: 1, demo: true },
      metro: {
        kind: "running",
        client: "expo-go",
        user: "xennion",
        url: "exps://ab12cd34ef56.ngrok.app",
        qr: "█▀▄ QR",
      },
    });
    expect(text).toContain("Safari:   https://example.ngrok.app");
    expect(text).toContain("map version 1 (the demo map)");
    expect(text).toContain("signed in as xennion");
    expect(text).toContain("Scan this QR code with the iPhone's Camera app");
    expect(text).toContain("exps://ab12cd34ef56.ngrok.app");
    expect(text).toContain("Not Metro's exp:// address above");
    expect(text).toContain("█▀▄ QR");
    expect(text).toContain("Ctrl+C");
  });

  test("without a QR code it says to type the URL", () => {
    const text = summary({
      ...base,
      published: undefined,
      metro: {
        kind: "running",
        client: "expo-go",
        user: "xennion",
        url: "exps://ab12cd34ef56.ngrok.app",
      },
    });
    expect(text).toContain("Enter URL manually");
    expect(text).not.toContain("Scan this QR code");
  });

  test("the development build: its deep link as a QR code and the https address for its launcher", () => {
    const text = summary({
      ...base,
      published: { version: 1, demo: true },
      metro: {
        kind: "running",
        client: "dev-client",
        url: devClientUrl("https://ab12cd34ef56.ngrok.app"),
        metroUrl: "https://ab12cd34ef56.ngrok.app",
        qr: "█▀▄ QR",
      },
    });
    expect(text).toContain(
      "open the installed Underground SG Mapper (the development build, not Expo Go)",
    );
    expect(text).toContain("https://ab12cd34ef56.ngrok.app");
    expect(text).toContain("█▀▄ QR");
    expect(text).not.toContain("sign in to the same account in Expo Go");
  });

  test("without an Expo sign-in it says how to sign in", () => {
    const text = summary({ ...base, published: undefined, metro: { kind: "not-signed-in" } });
    expect(text).toContain("no map is published yet");
    expect(text).toContain("pnpm --filter @usg/mapper exec expo login");
  });

  test("when the sign-in couldn't be checked it says so, not that nobody is signed in", () => {
    const text = summary({
      ...base,
      published: undefined,
      metro: { kind: "whoami-failed", detail: "fetch failed: getaddrinfo ENOTFOUND api.expo.dev" },
    });
    expect(text).toContain(
      "couldn't check the Expo sign-in: fetch failed: getaddrinfo ENOTFOUND api.expo.dev",
    );
    expect(text).toContain("Safari works");
    expect(text).not.toContain("expo login");
  });
});

describe("the QR code", () => {
  test("two module rows per line, light on dark, with a quiet zone", () => {
    // 2 x 2: dark, light / light, dark.
    const text = qrText(Uint8Array.from([1, 0, 0, 1]), 2);
    expect(text.split("\n")).toEqual([
      // Quiet-zone row above row 0: light over (quiet, dark, light, quiet).
      "█▀██",
      // Row 1 over the quiet-zone row below: (quiet, light, dark, quiet) over light.
      "██▄█",
    ]);
  });
});
