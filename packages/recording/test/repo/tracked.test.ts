// The git check against state outside this package: this repository's own index, and the real
// .githooks/pre-push refusing a push. Turborepo hashes only the package's files, so a cached pass
// could hide a broken hook or a planted file; these run in the uncached `pnpm test:repo`.

import type { SpawnSyncReturns } from "node:child_process";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { checkIndex } from "../../src/node/index.ts";
import {
  DEVICE,
  git,
  ok,
  REPO_DIR,
  removeRepositories,
  repository,
  SET,
  SYNTHETIC,
  temporaryDir,
} from "../git-repos.ts";

const HOOKS_DIR = join(REPO_DIR, ".githooks").replaceAll("\\", "/");

afterAll(removeRepositories);

test("this repository's tracked files pass", () => {
  expect(checkIndex(REPO_DIR, { requireSets: true })).toEqual([]);
});

describe("the pre-push hook", () => {
  /** A repository with a bare remote, pushing with this repo's .githooks. */
  function pushing(...commits: Record<string, string | null>[]): SpawnSyncReturns<string> {
    const dir = repository(...commits);
    const remote = temporaryDir("usg-remote-");
    ok(git(remote, ["init", "-q", "--bare"]));
    ok(git(dir, ["remote", "add", "origin", remote]));
    return git(dir, ["-c", `core.hooksPath=${HOOKS_DIR}`, "push", "-q", "origin", "main"]);
  }

  test("refuses a push with a planted origin: device recording", () => {
    const result = pushing({ "fixtures/rec-1/recording.json": DEVICE });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("recording_not_synthetic");
    expect(result.stderr).toContain("fixtures/rec-1/recording.json");
  });

  test("refuses a push with a planted gnss.jsonl, even one deleted again", () => {
    const result = pushing({ "data/gnss.jsonl": "{}\n" }, { "data/gnss.jsonl": null });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("recording_file_outside_sets");
    expect(result.stderr).toContain("data/gnss.jsonl");
  });

  test("lets a clean push through", () => {
    const result = pushing({ "README.md": "hello\n", [`${SET}/recording.json`]: SYNTHETIC });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
