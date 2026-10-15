// Fixture mode (`vite --mode fixtures`): the dev server answers /public/ itself with the demo
// snapshot in fixtures/demo-snapshot.ts, so the webapp runs without the API. WEB_FIXTURE picks
// what /public/ does, to show the page's other states:
//
//   demo         the demo version (the default)
//   empty        404 for every file: nothing published yet
//   down         503 for every file: the server failing
//   html         latest.json is an HTML page, as from a host that answers every path with the app
//   outdated     latest.json is in a newer format (schema_version 2)

import type { Connect, Plugin } from "vite";
import { demoPublicFiles, type PublicFile } from "../fixtures/demo-snapshot.ts";

export const FIXTURE_SCENARIOS = ["demo", "empty", "down", "html", "outdated"] as const;

export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number];

/** Reads WEB_FIXTURE: one of FIXTURE_SCENARIOS, "demo" when unset. */
export function fixtureScenario(value: string | undefined): FixtureScenario {
  const scenario = value?.trim() || "demo";
  if (!(FIXTURE_SCENARIOS as readonly string[]).includes(scenario)) {
    throw new Error(`WEB_FIXTURE is ${scenario}: use one of ${FIXTURE_SCENARIOS.join(", ")}`);
  }
  return scenario as FixtureScenario;
}

/** The response to a request for `path` (relative to /public/) in a scenario. */
export function fixtureResponse(
  scenario: FixtureScenario,
  files: ReadonlyMap<string, PublicFile>,
  path: string,
): { status: number; file?: PublicFile } {
  if (scenario === "empty") return { status: 404 };
  if (scenario === "down") return { status: 503 };
  if (path === "latest.json" && scenario === "html") {
    const body = "<!doctype html><title>Underground SG</title>";
    return { status: 200, file: { body, contentType: "text/html", cacheControl: "no-cache" } };
  }
  const file = files.get(path);
  if (file === undefined) return { status: 404 };
  if (path === "latest.json" && scenario === "outdated") {
    const latest = { ...(JSON.parse(file.body) as object), schema_version: 2 };
    return { status: 200, file: { ...file, body: JSON.stringify(latest) } };
  }
  return { status: 200, file };
}

function fixturesMiddleware(scenario: FixtureScenario): Connect.NextHandleFunction {
  return (req, res) => {
    // status.json's windows start an hour before "now", so build the files per request.
    const files = demoPublicFiles(new Date());
    const path = decodeURIComponent((req.url ?? "").split(/[?#]/)[0] ?? "").replace(/^\/+/, "");
    const { status, file } = fixtureResponse(scenario, files, path);
    res.statusCode = status;
    if (file === undefined) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(status === 404 ? "Not found\n" : "Service unavailable (fixture)\n");
      return;
    }
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Cache-Control", file.cacheControl);
    res.end(req.method === "HEAD" ? undefined : file.body);
  };
}

/**
 * The Vite plugin for fixture mode: /public/ from the demo snapshot, in the dev server and in the
 * preview server (`vite preview --mode fixtures`, to check a production build).
 */
export function demoFixtures(scenarioValue: string | undefined): Plugin {
  const scenario = fixtureScenario(scenarioValue);
  const message = `  Fixture mode: /public/ serves the "${scenario}" fixture`;
  return {
    name: "usg:demo-fixtures",
    apply: "serve",
    configureServer(server) {
      server.config.logger.info(message);
      server.middlewares.use("/public", fixturesMiddleware(scenario));
    },
    configurePreviewServer(server) {
      server.config.logger.info(message);
      server.middlewares.use("/public", fixturesMiddleware(scenario));
    },
  };
}
