// The root prepare script: it points git at .githooks/ in a checkout of the repo, and does nothing
// in CI or outside a checkout's top level.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { HOOKS_PATH, installHooks } from "../install-hooks.ts";

const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "usg-hooks-"));
  temporary.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout.trim() };
}

function repository(): string {
  const dir = directory();
  expect(git(dir, ["init", "-q"]).status).toBe(0);
  return dir;
}

const LOCAL = { CI: undefined } as NodeJS.ProcessEnv;

describe("installHooks", () => {
  test("sets core.hooksPath in a checkout's top level", () => {
    const dir = repository();
    expect(installHooks(dir, LOCAL)).toBe("installed");
    expect(git(dir, ["config", "--local", "core.hooksPath"]).stdout).toBe(HOOKS_PATH);
  });

  test("does nothing in CI", () => {
    const dir = repository();
    expect(installHooks(dir, { CI: "true" })).toBe("ci");
    expect(git(dir, ["config", "--local", "core.hooksPath"]).status).not.toBe(0);
  });

  test("does nothing outside a git checkout", () => {
    expect(installHooks(directory(), LOCAL)).toBe("not-a-checkout");
  });

  test("does nothing in a copy inside another repository", () => {
    const outer = repository();
    const inner = join(outer, "vendor", "underground-sg");
    mkdirSync(inner, { recursive: true });
    expect(installHooks(inner, LOCAL)).toBe("not-a-checkout");
    expect(git(outer, ["config", "--local", "core.hooksPath"]).status).not.toBe(0);
  });

  test("the hook is in the repo, executable", () => {
    const root = join(import.meta.dirname, "..", "..");
    const entry = git(root, ["ls-files", "-s", `${HOOKS_PATH}/pre-push`]).stdout;
    expect(entry).toMatch(/^100755 /);
  });
});
