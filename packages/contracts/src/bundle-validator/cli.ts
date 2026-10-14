#!/usr/bin/env node
// validate-bundle: checks a capture bundle (a capture-<capture_id>/ directory, or its tar)
// against docs/capture-bundle.md. Exit code 0 when valid, 1 when invalid, 2 when the bundle
// could not be read (bad usage, a missing path, an IO error).

import { parseArgs } from "node:util";
import { FRAME_NAME_DIGITS } from "../capture-bundle.ts";
import { formatReport } from "./report.ts";
import { BundleIoError } from "./source.ts";
import { validateBundle } from "./validate.ts";

const USAGE = `Usage: validate-bundle <path> [--json] [--quarantined <frames>]

  <path>                  A bundle directory, capture-<capture_id>/, or an uncompressed tar of one
  --json                  Print the report as JSON instead of text
  --quarantined <frames>  Comma-separated keyframes the privacy re-check quarantined, for example
                          812,1004: their files must be missing but still listed in manifest.files
  -h, --help              Show this help

Exit codes: 0 valid, 1 invalid, 2 usage or IO error.
`;

const FRAME_PATTERN = new RegExp(`^[0-9]{1,${FRAME_NAME_DIGITS}}$`);

function usageError(message: string): number {
  process.stderr.write(`validate-bundle: ${message}\n\n${USAGE}`);
  return 2;
}

/** Parses "812,1004" (or "" for none); null if any item is not a frame index. */
function parseFrames(text: string): number[] | null {
  if (text.trim() === "") return [];
  const frames: number[] = [];
  for (const item of text.split(",")) {
    const trimmed = item.trim();
    if (!FRAME_PATTERN.test(trimmed)) return null;
    frames.push(Number(trimmed));
  }
  return frames;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}

const OPTIONS = {
  json: { type: "boolean" },
  quarantined: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

function parseCommandLine(args: string[]) {
  return parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
}

async function main(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(args);
  } catch (error) {
    return usageError(describeError(error));
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  const [path, ...extra] = positionals;
  if (path === undefined || extra.length > 0) return usageError("Give exactly one bundle path");
  const quarantinedFrames = parseFrames(values.quarantined ?? "");
  if (quarantinedFrames === null) {
    return usageError("--quarantined takes frame indices separated by commas, such as 812,1004");
  }

  let report: Awaited<ReturnType<typeof validateBundle>>;
  try {
    report = await validateBundle(path, { quarantinedFrames });
  } catch (error) {
    const kind = error instanceof BundleIoError ? "" : "internal error: ";
    process.stderr.write(`validate-bundle: ${kind}${describeError(error)}\n`);
    return 2;
  }
  process.stdout.write(
    values.json === true ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report, path),
  );
  return report.valid ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
