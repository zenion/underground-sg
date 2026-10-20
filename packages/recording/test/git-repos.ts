// Throwaway git repositories for the git check's tests (tracked.test.ts, repo/tracked.test.ts).
// Test files that make them remove them with `afterAll(removeRepositories)`.

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SYNTHETIC_SETS_DIR } from "../src/node/index.ts";

export const REPO_DIR = join(import.meta.dirname, "..", "..", "..");

export const SET = `${SYNTHETIC_SETS_DIR}corridor-lean/rec-5f0e8f0c-7a4e-5c1b-9d2e-3f4a5b6c7d8e`;
export const SYNTHETIC = JSON.stringify({ recording_version: 1, origin: "synthetic" });
export const DEVICE = JSON.stringify({ recording_version: 1, origin: "device" });

const temporary: string[] = [];

export function removeRepositories(): void {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A new empty directory under the system's temporary directory, removed with the repositories. */
export function temporaryDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

/** git with no user or system configuration that could sign, prompt or run other hooks. */
export function git(cwd: string, args: string[], input?: string): SpawnSyncReturns<string> {
  return spawnSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    {
      cwd,
      input,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    },
  );
}

export function ok(result: SpawnSyncReturns<string>): string {
  if (result.status !== 0) throw new Error(`git failed: ${result.stderr}`);
  return result.stdout;
}

/** A new repository with `files` committed, one commit per entry of `commits`. */
export function repository(...commits: Record<string, string | null>[]): string {
  const dir = temporaryDir("usg-tracked-");
  ok(git(dir, ["init", "-q", "-b", "main"]));
  commits.forEach((files, i) => {
    for (const [path, text] of Object.entries(files)) {
      const target = join(dir, ...path.split("/"));
      if (text === null) {
        ok(git(dir, ["rm", "-q", path]));
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
      ok(git(dir, ["add", path]));
    }
    ok(git(dir, ["commit", "-q", "--allow-empty", "-m", `commit ${i}`]));
  });
  return dir;
}
