#!/usr/bin/env node
// The git check for session recordings (ADR 0010, "Git and EAS"), run by CI on the checkout and by
// the pre-push hook (.githooks/pre-push) on every commit a push would publish. It prints paths,
// commits and problem codes only, never file contents.
//
//   node packages/recording/scripts/check-tracked.ts [--require-sets]   the index (git ls-files)
//   node packages/recording/scripts/check-tracked.ts --pre-push          the commits git names on stdin
//
// Exit codes: 0 clean, 1 problems found, 2 usage or git error.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { checkIndex, checkPush, formatProblems, type TrackedProblem } from "../src/node/tracked.ts";

const OPTIONS = {
  "pre-push": { type: "boolean" },
  "require-sets": { type: "boolean" },
} as const;

function main(args: string[]): number {
  let values: { "pre-push"?: boolean; "require-sets"?: boolean };
  try {
    // A pre-push hook also gets the remote's name and URL as arguments, which this ignores.
    ({ values } = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true }));
  } catch (error) {
    process.stderr.write(`check-tracked: ${error instanceof Error ? error.message : error}\n`);
    return 2;
  }
  const cwd = process.cwd();
  let problems: TrackedProblem[];
  try {
    problems =
      values["pre-push"] === true
        ? checkPush(cwd, readFileSync(0, "utf8"))
        : checkIndex(cwd, { requireSets: values["require-sets"] === true });
  } catch (error) {
    process.stderr.write(`check-tracked: ${error instanceof Error ? error.message : error}\n`);
    return 2;
  }
  if (problems.length === 0) return 0;
  process.stderr.write(
    `check-tracked: ${problems.length} problem${problems.length === 1 ? "" : "s"}. Session recordings ` +
      "and capture data never go in git; only `pnpm rec synth` sets (origin: synthetic) do " +
      "(ADR 0010).\n" +
      `${formatProblems(problems)}\n`,
  );
  return 1;
}

process.exitCode = main(process.argv.slice(2));
