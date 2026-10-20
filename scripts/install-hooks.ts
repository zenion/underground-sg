// The root `prepare` script, run by `pnpm install`: points git at the hooks kept in the repo
// (.githooks/, whose pre-push refuses to publish session recordings, ADR 0010). It does nothing
// in CI, which runs the same check itself, and nothing outside a git checkout of this repo (an
// extracted archive, or a copy inside another repository), so it never changes another repo's
// configuration.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative } from "node:path";

export const HOOKS_PATH = ".githooks";

export type InstallResult = "installed" | "ci" | "not-a-checkout";

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { ok: result.error === undefined && result.status === 0, stdout: result.stdout ?? "" };
}

/** Sets core.hooksPath in the repository whose top level is `root`. */
export function installHooks(root: string, env: NodeJS.ProcessEnv = process.env): InstallResult {
  if (env["CI"] !== undefined && env["CI"] !== "" && env["CI"] !== "false") return "ci";
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return "not-a-checkout";
  if (relative(realpathSync.native(top.stdout.trim()), realpathSync.native(root)) !== "") {
    return "not-a-checkout";
  }
  if (!git(root, ["config", "core.hooksPath", HOOKS_PATH]).ok) {
    throw new Error("git config core.hooksPath failed");
  }
  return "installed";
}

if (import.meta.main) {
  installHooks(process.cwd());
}
