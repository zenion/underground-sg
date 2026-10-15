// `pnpm dev:phone`: everything the owner's iPhone needs to test end to end, without an Apple
// Developer account (docs/phone-testing.md). Safari opens the webapp and Expo Go the mapper app,
// both through ngrok, because the PC's Wi-Fi profile is Public and Windows Firewall blocks the LAN:
//
// 1. Docker and the compose stack (PostGIS, RustFS) are up; migrations and buckets are applied.
// 2. The webapp is built, and the API serves it (API_WEB_DIST) on 127.0.0.1, beside its routes.
// 3. A map version is published: the demo map, if nothing is and the stack is on this machine.
// 4. One ngrok agent, request inspection off, with two endpoints: the owner's reserved domain
//    (NGROK_DOMAIN) to the API, and a random address for this run to Metro, whose Traffic Policy
//    refuses Metro's debugger and other local-only endpoints at ngrok's edge.
// 5. Metro starts for Expo Go on loopback, with its manifest and bundle URLs on the Metro
//    endpoint's https address and EXPO_PUBLIC_API_URL on the domain; dev:phone checks through the
//    tunnel that the manifest points at https and that the debugger is refused, and that nothing it
//    started answers on the PC's network addresses.
//
// Vite, PostGIS and RustFS are never exposed. Every API route the tunnel exposes is read-only. No
// write route may go through it before the owner device-token auth exists (Phase 2), and capture
// bundles and locate photos never go through a TLS-terminating proxy
// (docs/decisions/0009-hosting-and-budget.md).
//
// Ctrl+C, an error, or any of its processes stopping stops every process it started, with its
// children (taskkill /T /F on Windows), and nothing else. ngrok's authtoken stays in ngrok's own
// config; nothing here reads or prints it. Logs go to the git-ignored .data/dev-phone/.

import { type ChildProcess, type StdioOptions, spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  type WriteStream,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { toQR } from "toqr";
import {
  apiEnv,
  apiPort,
  classifyHealth,
  ENDPOINTS,
  expoArgs,
  expoEnv,
  expoGoUrl,
  isLocalStack,
  lanAddresses,
  METRO_PORT,
  type MetroState,
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
  processesToStop,
  publicOrigin,
  publishedVersion,
  qrText,
  redact,
  SetupError,
  servicesNotReady,
  summary,
  USAGE,
} from "./dev-phone-lib.ts";
import { loadRootEnv } from "./env.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const LOG_DIR = join(ROOT, ".data", "dev-phone");
const WINDOWS = process.platform === "win32";
const NODE = process.execPath;

/** A process this script started. */
interface Child {
  readonly name: string;
  readonly process: ChildProcess;
  readonly startedAt: number;
  exitedAt: number | undefined;
  exitCode: number | null | undefined;
  /** POSIX: started in a process group of its own, stopped as a group. */
  readonly group: boolean;
  /** Its exit stops everything (the long-running ones), unless the script is stopping anyway. */
  readonly essential: boolean;
}

const children: Child[] = [];
let stopping = false;

function say(text: string): void {
  console.log(`› ${text}`);
}

class StepError extends Error {
  override name = "StepError";
}

// --- Starting and stopping processes ---------------------------------------------------------

function track(
  name: string,
  child: ChildProcess,
  essential: boolean,
  group: boolean,
  startedAt: number,
): Child {
  const entry: Child = {
    name,
    process: child,
    startedAt,
    exitedAt: undefined,
    exitCode: undefined,
    group,
    essential,
  };
  children.push(entry);
  child.on("exit", (code) => {
    entry.exitedAt = Date.now();
    entry.exitCode = code;
    if (essential && !stopping) {
      const how = code === 0 ? "stopped" : `stopped unexpectedly (exit code ${code ?? "none"})`;
      void shutdown(code === 0 && name === "Metro" ? 0 : 1, `${name} ${how}.`);
    }
  });
  return entry;
}

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a short step to completion. `quiet` captures its output (shown only when it fails);
 * otherwise it writes to this terminal. Ctrl+C stops it with everything else.
 */
async function run(
  name: string,
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean; shell?: boolean } = {},
): Promise<RunResult> {
  const startedAt = Date.now();
  const stdio: StdioOptions = options.quiet
    ? ["ignore", "pipe", "pipe"]
    : ["ignore", "inherit", "inherit"];
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    stdio,
    windowsHide: true,
    shell: options.shell ?? false,
  });
  track(name, child, false, false, startedAt);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve, reject) => {
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new StepError(`${command} wasn't found: is it installed and on PATH?`)
          : error,
      );
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** Runs a step and fails with its output if it doesn't succeed. */
async function step(
  name: string,
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean } = {},
): Promise<RunResult> {
  const result = await run(name, command, args, options);
  if (result.status !== 0) {
    const output = `${result.stdout}${result.stderr}`.trim();
    throw new StepError(
      `${name} failed (exit code ${result.status ?? "none"}).${output === "" ? "" : `\n${redact(output)}`}`,
    );
  }
  return result;
}

/**
 * Starts a long-running process whose output goes to a log file, line by line through `onLine`.
 * `logLine` picks what of each line is written to the file (all of it by default; undefined
 * leaves the line out).
 */
function startLogged(
  name: string,
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    log: WriteStream;
    onLine?: (line: string) => void;
    logLine?: (line: string) => string | undefined;
  },
): Child {
  const startedAt = Date.now();
  // Piped, not inherited, so on Windows the child has no console (CREATE_NO_WINDOW): Ctrl+C in this
  // terminal reaches this script, which stops it.
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: !WINDOWS,
  });
  const entry = track(name, child, true, !WINDOWS, startedAt);
  for (const stream of [child.stdout, child.stderr]) {
    if (stream === null) continue;
    createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
      const kept = options.logLine ? options.logLine(line) : line;
      if (kept !== undefined) options.log.write(`${kept}\n`);
      options.onLine?.(line);
    });
  }
  child.on("error", (error: NodeJS.ErrnoException) => {
    if (stopping) return;
    const why =
      error.code === "ENOENT"
        ? `${command} wasn't found: is it installed and on PATH?`
        : error.message;
    void shutdown(1, `${name} couldn't start: ${why}`);
  });
  return entry;
}

const running = (child: Child): boolean =>
  child.exitedAt === undefined &&
  child.process.exitCode === null &&
  child.process.pid !== undefined;

async function waitForExit(list: readonly Child[], ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (list.some(running) && Date.now() < deadline) await sleep(100);
}

/** Windows' process table, for the processes the started ones left behind. */
function windowsProcessTable(): ReturnType<typeof parseProcessTable> {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() } }",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 20_000 },
  );
  return result.status === 0 ? parseProcessTable(result.stdout) : [];
}

function taskkill(pids: readonly number[], tree: boolean): void {
  if (pids.length === 0) return;
  spawnSync(
    "taskkill",
    [...pids.flatMap((pid) => ["/PID", String(pid)]), ...(tree ? ["/T"] : []), "/F"],
    { stdio: "ignore", windowsHide: true, timeout: 20_000 },
  );
}

/**
 * Stops every process this script started, with their children, and nothing else: Windows'
 * taskkill /T /F on each one still running, then any descendant left behind by one that had
 * already exited (processesToStop); on Linux and macOS, SIGTERM to each process group, then
 * SIGKILL.
 */
async function stopChildren(metroFirst: boolean): Promise<void> {
  const metro = children.find((child) => child.name === "Metro" && running(child));
  if (metro !== undefined && metroFirst) {
    // Ctrl+C reached Metro too (it shares the terminal): let it stop by itself first.
    await waitForExit([metro], 4_000);
  }
  if (WINDOWS) {
    taskkill(
      children.filter(running).map((child) => child.process.pid as number),
      true,
    );
    await waitForExit(children, 5_000);
    const leftover = processesToStop(
      windowsProcessTable(),
      children.flatMap((child) =>
        child.process.pid === undefined
          ? []
          : [{ pid: child.process.pid, startedAt: child.startedAt, exitedAt: child.exitedAt }],
      ),
    ).filter((pid) => pid !== process.pid);
    taskkill(leftover, false);
  } else {
    const signal = (child: Child, name: NodeJS.Signals): void => {
      try {
        const pid = child.process.pid as number;
        process.kill(child.group ? -pid : pid, name);
      } catch {
        // Already gone.
      }
    };
    for (const child of children.filter(running)) signal(child, "SIGTERM");
    await waitForExit(children, 5_000);
    for (const child of children.filter(running)) signal(child, "SIGKILL");
  }
  await waitForExit(children, 3_000);
}

async function shutdown(code: number, message?: string, fromSignal = false): Promise<never> {
  if (stopping) return new Promise(() => {});
  stopping = true;
  if (message !== undefined) (code === 0 ? console.log : console.error)(`\n${message}`);
  const started = children.filter((child) => child.essential).map((child) => child.name);
  if (children.some(running)) {
    say(`Stopping ${started.length > 0 ? started.join(", ") : "the running step"}…`);
  }
  await stopChildren(fromSignal);
  const left = children.filter(running).map((child) => `${child.name} (${child.process.pid})`);
  if (left.length > 0) console.error(`Still running, stop them by hand: ${left.join(", ")}`);
  else if (started.length > 0) say("Stopped everything dev:phone started.");
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const) {
  process.on(signal, () => {
    void shutdown(130, undefined, true);
  });
}
// Last resort if the script dies some other way: no orphans left serving the tunnel.
process.on("exit", () => {
  const left = children.filter(running);
  if (WINDOWS) {
    taskkill(
      left.map((child) => child.process.pid as number),
      true,
    );
    return;
  }
  for (const child of left) {
    try {
      const pid = child.process.pid as number;
      process.kill(child.group ? -pid : pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

// --- Checks ----------------------------------------------------------------------------------

/** Whether something accepts connections on `host`:`port` (127.0.0.1 by default). */
function listening(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(1_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Whether something accepts connections on `port` on either loopback address. */
async function listeningOnLoopback(port: number): Promise<boolean> {
  return (await listening(port, "127.0.0.1")) || (await listening(port, "::1"));
}

/**
 * The PC's network addresses and ports where something answers. dev:phone's processes listen on
 * loopback only, so the LAN never reaches them whatever the firewall or the network profile.
 */
async function answeringOnLan(ports: readonly number[]): Promise<string[]> {
  const found: string[] = [];
  for (const address of lanAddresses(networkInterfaces())) {
    for (const port of ports) {
      if (await listening(port, address)) {
        found.push(address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`);
      }
    }
  }
  return found;
}

interface HttpAnswer {
  readonly status: number;
  readonly ngrokErrorCode: string | null;
  readonly body: string;
}

async function get(
  url: string,
  headers: Record<string, string> = {},
): Promise<HttpAnswer | undefined> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
    return {
      status: response.status,
      ngrokErrorCode: response.headers.get("ngrok-error-code"),
      body: await response.text(),
    };
  } catch {
    return undefined;
  }
}

/**
 * Polls `check` every `every` ms until it gives a value, or fails after `ms` (or as soon as
 * `failed` says why).
 */
async function waitFor<T>(
  what: string,
  ms: number,
  check: () => Promise<T | undefined>,
  failed: () => string | undefined = () => undefined,
  every = 1_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const why = failed();
    if (why !== undefined) throw new StepError(why);
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new StepError(`${what} didn't happen within ${ms / 1000} s.`);
    await sleep(every);
  }
}

function binOf(packageName: string, bin: string, from: string): string {
  const require = createRequire(join(from, "package.json"));
  const packageJson = require.resolve(`${packageName}/package.json`);
  const bins = JSON.parse(readFileSync(packageJson, "utf8")).bin as Record<string, string>;
  return join(dirname(packageJson), bins[bin] ?? bin);
}

function tail(file: string, lines = 15): string {
  try {
    return readFileSync(file, "utf8").trim().split(/\r?\n/).slice(-lines).map(redact).join("\n");
  } catch {
    return "";
  }
}

// --- The steps -------------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(`${USAGE}\n\nSee docs/phone-testing.md.`);
    return;
  }
  loadRootEnv();
  const domain = ngrokDomain(process.env["NGROK_DOMAIN"]);
  const port = apiPort(process.env["API_PORT"]);
  const origin = publicOrigin(domain);
  mkdirSync(LOG_DIR, { recursive: true });
  const logs = relative(ROOT, LOG_DIR).replaceAll("\\", "/");

  // 1. Docker and the stack.
  say("Checking Docker…");
  const docker = await run("docker info", "docker", ["info", "--format", "{{.ServerVersion}}"], {
    quiet: true,
  });
  if (docker.status !== 0) {
    throw new StepError(
      "Docker isn't running. Start Docker Desktop, wait until it says Engine running, then run pnpm dev:phone again.",
    );
  }
  const ps = await run(
    "docker compose ps",
    "docker",
    ["compose", "ps", "--all", "--format", "json"],
    {
      quiet: true,
    },
  );
  const notReady = ps.status === 0 ? servicesNotReady(parseComposePs(ps.stdout)) : ["the stack"];
  if (notReady.length > 0) {
    say(`Starting ${notReady.join(" and ")} (docker compose up -d --wait)…`);
    await step("docker compose up", "docker", ["compose", "up", "-d", "--wait"]);
  } else {
    say("PostGIS and RustFS are up.");
  }
  say("Applying migrations and creating buckets…");
  await step("pnpm migrate", NODE, ["scripts/dbmate.ts", "up"], {
    cwd: join(ROOT, "db"),
    quiet: true,
  });
  await step("pnpm buckets", NODE, ["buckets.ts"], { cwd: join(ROOT, "scripts"), quiet: true });

  // Ports: nothing of the owner's may be in the way, and nothing is stopped to make room.
  if (await listening(port)) {
    throw new StepError(
      `Something already listens on 127.0.0.1:${port} (pnpm api, or an earlier pnpm dev:phone?). Stop it, then run pnpm dev:phone again.`,
    );
  }
  if (await listeningOnLoopback(METRO_PORT)) {
    throw new StepError(
      `Something already listens on port ${METRO_PORT} (another Metro: pnpm mapper?). Stop it, then run pnpm dev:phone again.`,
    );
  }
  const before = await get(`${origin}/health`);
  if (before !== undefined && before.ngrokErrorCode !== "ERR_NGROK_3200") {
    throw new StepError(
      `${origin} already answers${before.ngrokErrorCode ? ` (${before.ngrokErrorCode})` : ""}: another ngrok agent holds the domain (an earlier pnpm dev:phone, or ngrok started by hand). Stop it, then run pnpm dev:phone again.`,
    );
  }
  // Where ngrok's own configuration is (it holds the authtoken, which stays there).
  const check = await run("ngrok config check", "ngrok", ["config", "check"], { quiet: true });
  const ownConfig =
    check.status === 0 ? ngrokConfigPath(`${check.stdout}\n${check.stderr}`) : undefined;
  if (ownConfig === undefined) {
    const output = redact(`${check.stdout}${check.stderr}`.trim());
    throw new StepError(
      `ngrok has no valid configuration. Sign it in with ngrok config add-authtoken <token> (the token is on https://dashboard.ngrok.com), then run pnpm dev:phone again.${output === "" ? "" : `\n${output}`}`,
    );
  }

  // Whether Metro can run: Expo Go opens a project only from Expo CLI signed in to its account.
  const mapper = join(ROOT, "apps", "mapper");
  const expo = binOf("expo", "expo", mapper);
  const whoami = parseWhoami(
    await run("expo whoami", NODE, [expo, "whoami"], { cwd: mapper, quiet: true }),
    ["1", "true"].includes((process.env["EXPO_OFFLINE"] ?? "").toLowerCase()),
  );

  // 2. The webapp's build, and the API serving it.
  say("Building the webapp…");
  await step("vite build", NODE, [binOf("vite", "vite", join(ROOT, "apps/web")), "build"], {
    cwd: join(ROOT, "apps/web"),
    quiet: true,
  });
  const webDist = join(ROOT, "apps", "web", "dist");
  say(`Starting the API on 127.0.0.1:${port} (log: ${logs}/api.log)…`);
  const apiLog = createWriteStream(join(LOG_DIR, "api.log"));
  const api = startLogged("The API", NODE, ["src/server.ts"], {
    cwd: join(ROOT, "services/api"),
    env: apiEnv(process.env, { port, webDist, domain }),
    log: apiLog,
  });
  const local = `http://127.0.0.1:${port}`;
  const health = await waitFor(
    "The API answering",
    30_000,
    async () => {
      const answer = await get(`${local}/health`, { accept: "application/json" });
      return answer === undefined ? undefined : classifyHealth(answer);
    },
    () =>
      running(api)
        ? undefined
        : `The API stopped while starting. The end of ${logs}/api.log:\n${tail(join(LOG_DIR, "api.log"))}`,
  );
  if (health.kind === "unhealthy") {
    throw new StepError(`The API can't reach the stack (${health.detail}). Is Docker still up?`);
  }

  // 3. A published version.
  const latest = await get(`${local}/public/latest.json`);
  let published = latest?.status === 200 ? publishedVersion(latest.body) : undefined;
  if (published === undefined && latest?.status === 404) {
    if (options.noDemo) {
      say("No map is published (--no-demo): Safari and Expo Go will show the street map only.");
    } else if (!isLocalStack(process.env)) {
      say(
        "No map is published, and the stack isn't on this machine, so the demo map isn't published.",
      );
    } else {
      say("No map is published: publishing the demo map (pnpm demo)…");
      await step("pnpm demo", NODE, ["src/demo/cli.ts"], { cwd: join(ROOT, "services/api") });
      const again = await get(`${local}/public/latest.json`);
      published = again?.status === 200 ? publishedVersion(again.body) : undefined;
    }
  }
  if (published !== undefined) {
    say(`Map version ${published.version} is published${published.demo ? " (the demo map)" : ""}.`);
  }

  // 4. ngrok: the API on the domain and, when Metro runs, Metro on a random address.
  const withMetro = whoami.kind === "signed-in";
  say(
    `Starting ngrok: ${origin} → 127.0.0.1:${port}${withMetro ? `, and a random address → Metro on localhost:${METRO_PORT}` : ""}; inspection off (log: ${logs}/ngrok.log)…`,
  );
  const devPhoneConfig = join(LOG_DIR, "ngrok.yml");
  writeFileSync(devPhoneConfig, ngrokConfig({ domain, apiPort: port, metro: withMetro }));
  const ngrokLog = createWriteStream(join(LOG_DIR, "ngrok.log"));
  const ngrokProblems: string[] = [];
  const endpoints = new Map<string, string>();
  const ngrok = startLogged(
    "ngrok",
    "ngrok",
    ngrokArgs(
      ownConfig,
      devPhoneConfig,
      withMetro ? [ENDPOINTS.api, ENDPOINTS.metro] : [ENDPOINTS.api],
    ),
    {
      cwd: ROOT,
      env: process.env,
      log: ngrokLog,
      logLine: ngrokLogLine,
      onLine: (line) => {
        const started = ngrokStarted(line);
        if (started !== undefined) endpoints.set(started.name, started.url);
        const problem = ngrokProblem(line);
        if (problem !== undefined && !ngrokProblems.includes(problem)) {
          ngrokProblems.push(problem);
          console.error(`  ngrok: ${problem}`);
        }
      },
    },
  );
  const ngrokStopped = (): string | undefined =>
    running(ngrok)
      ? undefined
      : `ngrok stopped while starting${ngrokProblems.length > 0 ? `: ${ngrokProblems.join("; ")}` : ""}. Check that it is signed in (ngrok config check) and that ${domain} is your reserved domain. See ${logs}/ngrok.log.`;
  const metroUrl = await waitFor(
    "ngrok starting its endpoints",
    30_000,
    async () => {
      if (!endpoints.has(ENDPOINTS.api)) return undefined;
      return withMetro ? endpoints.get(ENDPOINTS.metro) : "";
    },
    ngrokStopped,
    250,
  );
  await waitFor(
    `${origin}/health answering through the tunnel`,
    45_000,
    async () => {
      const answer = await get(`${origin}/health`, { accept: "application/json" });
      if (answer === undefined) return undefined;
      const kind = classifyHealth(answer).kind;
      return kind === "ok" || kind === "unhealthy" ? kind : undefined;
    },
    ngrokStopped,
  );
  say(`${origin} answers through the tunnel.`);

  // 5. Metro for Expo Go, on loopback, reached through the Metro endpoint.
  if (whoami.kind !== "signed-in") {
    const metro: MetroState =
      whoami.kind === "not-signed-in"
        ? { kind: "not-signed-in" }
        : { kind: "whoami-failed", detail: whoami.detail };
    await checkNotOnLan([port]);
    console.log(summary({ domain, published, metro, logs }));
    say("Safari works; press Ctrl+C to stop.");
    return;
  }
  await step("maplibre worker", NODE, ["scripts/maplibre-worker.mts"], {
    cwd: mapper,
    quiet: true,
  });
  say(`Starting Metro for Expo Go on localhost:${METRO_PORT}, reached at ${metroUrl}…`);
  const metroStartedAt = Date.now();
  // Metro gets this terminal: its keys (r reloads the app) and Ctrl+C, which it handles itself;
  // its exit then stops the rest.
  const metroProcess = spawn(NODE, [expo, ...expoArgs({ clear: options.clear })], {
    cwd: mapper,
    env: expoEnv(process.env, { domain, metroUrl }),
    stdio: "inherit",
  });
  const metroChild = track("Metro", metroProcess, true, false, metroStartedAt);
  metroProcess.on("error", (error) => {
    if (!stopping) void shutdown(1, `Metro couldn't start: ${error.message}`);
  });
  const metroStopped = (): string | undefined =>
    running(metroChild) ? undefined : "Metro stopped while starting.";
  // Through the tunnel, as the phone asks for it: ngrok answers 502 until Metro listens.
  const manifest = await waitFor(
    "Metro serving the app's manifest through the tunnel",
    180_000,
    async () => {
      const answer = await get(`${metroUrl}/`, {
        "expo-platform": "ios",
        accept: "application/expo+json,application/json",
      });
      return answer?.status === 200 && answer.ngrokErrorCode === null ? answer.body : undefined;
    },
    () => metroStopped() ?? ngrokStopped(),
    3_000,
  );
  const problem = manifestProblem(manifest, metroUrl);
  if (problem !== undefined) {
    throw new StepError(`Metro's manifest through the tunnel is wrong: ${problem}.`);
  }
  // The edge has to refuse Metro's debugger, or nothing may stay up.
  for (const path of ["/json/version", "/status"]) {
    const answer = await get(`${metroUrl}${path}`);
    if (answer?.status !== 403) {
      throw new StepError(
        `ngrok didn't refuse ${path} on the Metro endpoint (got ${answer?.status ?? "no answer"}): Metro's debugger would be open to the internet.`,
      );
    }
  }
  await checkNotOnLan([port, METRO_PORT]);
  const url = expoGoUrl(metroUrl);
  let qr: string | undefined;
  try {
    const modules = toQR(url);
    qr = qrText(modules, Math.round(Math.sqrt(modules.length)));
  } catch {
    qr = undefined;
  }
  console.log(
    summary({ domain, published, metro: { kind: "running", user: whoami.user, url, qr }, logs }),
  );
}

/** Fails if anything answers on the PC's network addresses on `ports`. */
async function checkNotOnLan(ports: readonly number[]): Promise<void> {
  const open = await answeringOnLan(ports);
  if (open.length > 0) {
    throw new StepError(
      `Something answers on this PC's network address (${open.join(", ")}), not only on loopback: the LAN could reach it whenever the firewall lets it through. Nothing dev:phone starts should listen there.`,
    );
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof SetupError || error instanceof StepError
      ? error.message
      : `dev:phone failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
  void shutdown(error instanceof SetupError ? 2 : 1, message);
});
