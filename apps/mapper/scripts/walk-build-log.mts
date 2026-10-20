// Prints a failed walk build's error lines, masked (walk-build-log-lib.mts), and nothing else.
//
//   node apps/mapper/scripts/walk-build-log.mts <build log>
//
// Used by .github/workflows/walk-build.yml after `eas build --local` fails; its output is the only
// part of the build's log that reaches the public Actions log.

import { readFileSync } from "node:fs";
import { errorLines } from "./walk-build-log-lib.mts";

const file = process.argv[2];
if (!file) {
  process.stderr.write("usage: walk-build-log.mts <build log>\n");
  process.exit(2);
}

let log: string;
try {
  log = readFileSync(file, "utf8");
} catch {
  process.stdout.write("| (the build log could not be read)\n");
  process.exit(0);
}

const lines = errorLines(log);
process.stdout.write(
  lines.length === 0 ? "| (no error: lines in the build log)\n" : `${lines.join("\n")}\n`,
);
