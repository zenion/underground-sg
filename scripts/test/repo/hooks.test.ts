// The hooks the prepare script points git at, as this repository's index holds them. The index
// isn't in the package's Turborepo hash, so this runs in the uncached `pnpm test:repo`.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";
import { HOOKS_PATH } from "../../install-hooks.ts";

test("the hook is in the repo, executable", () => {
  const root = join(import.meta.dirname, "..", "..", "..");
  const result = spawnSync("git", ["ls-files", "-s", `${HOOKS_PATH}/pre-push`], {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/^100755 /);
});
