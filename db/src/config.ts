// Paths and connection settings shared by the scripts and the tests.

import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
export const SCHEMA_FILE = fileURLToPath(new URL("../schema.sql", import.meta.url));

/**
 * Loads the repo root's `.env` (git-ignored; copied from `.env.example`) into `process.env`.
 * Variables already set in the environment win, so CI can set them directly. A missing file
 * is fine.
 */
export function loadRootEnv(): void {
  try {
    process.loadEnvFile(join(REPO_ROOT, ".env"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** `DATABASE_URL` from the environment or the root `.env`: the developer's app database. */
export function databaseUrl(): URL {
  loadRootEnv();
  const value = process.env["DATABASE_URL"];
  if (value === undefined || value === "") {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env at the repo root, or set it in the environment.",
    );
  }
  return new URL(value);
}

/** The database a URL names. */
export function databaseName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ""));
}

/** The same server and credentials, another database. */
export function withDatabase(url: URL, name: string): URL {
  const copy = new URL(url);
  copy.pathname = `/${encodeURIComponent(name)}`;
  return copy;
}

/** True for a server on this machine: the compose stack, or CI's service container. */
export function isLocalHost(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}
