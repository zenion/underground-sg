#!/usr/bin/env node
// `pnpm rec`: the PC's recording tools (docs/session-recording.md, ADR 0010). For now only
// `synth`; pull, import, ls, review, delete and the derive commands come after the first walk.
// Output names sets, directories and counts, never values from a recording.

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { OutputPathError, synthesize } from "./synth.ts";

const USAGE = `Usage: pnpm rec synth [--out <dir>]

  synth          Write the synthetic replay sets (origin: synthetic), replacing each set's
                 directory. By default into packages/recording/fixtures/synthetic/, where they
                 are tracked; --out must be inside that directory or the repo's .data/
  -h, --help     Show this help

Exit codes: 0 done, 2 usage error or a refused path.
`;

function fail(message: string): number {
  process.stderr.write(`rec: ${message}\n\n${USAGE}`);
  return 2;
}

const OPTIONS = {
  out: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

function parseCommandLine(args: string[]) {
  return parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
}

function main(args: string[]): number {
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(args);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (positionals.length !== 1 || positionals[0] !== "synth") {
    return fail("give one command: synth");
  }
  // pnpm runs the script in the package; a relative --out is relative to where it was typed.
  const from = process.env["INIT_CWD"] ?? process.cwd();
  try {
    const written = values.out === undefined ? synthesize() : synthesize(resolve(from, values.out));
    for (const set of written) {
      process.stdout.write(`rec synth: ${set.name}: ${set.files} files, ${set.bytes} bytes\n`);
    }
  } catch (error) {
    if (error instanceof OutputPathError) return fail(`refused: ${error.message}`);
    throw error;
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
