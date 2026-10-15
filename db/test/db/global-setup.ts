// Runs once per `pnpm test:db`: migrates a template database with dbmate, which every test
// file copies (test/db/harness.ts), and drops it at the end. The tests use DATABASE_URL's
// server and credentials, never its database.

import type { TestProject } from "vitest/node";
import { databaseUrl } from "../../src/config.ts";
import { createMigratedScratch, dropScratch, dropStaleScratches } from "../../src/scratch.ts";

declare module "vitest" {
  export interface ProvidedContext {
    /** DATABASE_URL: the server the scratch databases live on. */
    serverUrl: string;
    /** A scratch database with every migration applied. */
    templateDatabase: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const url = databaseUrl();
  for (const name of await dropStaleScratches(url)) console.log(`dropped stale ${name}`);
  const template = createMigratedScratch(url, "template");
  project.provide("serverUrl", url.href);
  project.provide("templateDatabase", template);
  return async () => {
    await dropScratch(url, template);
  };
}
