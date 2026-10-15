import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * Loads the repo root's `.env` (git-ignored; copied from `.env.example`) into `process.env`.
 * Variables already set in the environment win. A missing file is fine.
 */
export function loadRootEnv(): void {
  try {
    process.loadEnvFile(join(REPO_ROOT, ".env"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * A variable that must be set, from the environment or the root `.env` (after `loadRootEnv`).
 * The error names the variable, never a value.
 */
export function required(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is not set. Copy .env.example to .env at the repo root, or set it in the environment.`,
    );
  }
  return value;
}
