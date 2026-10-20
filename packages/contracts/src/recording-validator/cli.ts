#!/usr/bin/env node
// validate-recording: checks a session recording, or a replay set, against
// docs/session-recording.md. Exit code 0 when valid, 1 when invalid, 2 when it could not be read
// (bad usage, a missing path, an IO error). The output names files, lines, frames and counts,
// never values from the recording.

import { parseArgs } from "node:util";
import { BundleIoError } from "../bundle-validator/source.ts";
import { formatRecordingReport, type RecordingValidationReport } from "./report.ts";
import { validateRecording, validateRecordingParts } from "./validate.ts";

const USAGE = `Usage: validate-recording <path> [--json]
       validate-recording --parts <dir> [--json]

  <path>         A recording directory, rec-<recording_id>/; a replay set directory holding it
                 and the session's capture-<capture_id>/ bundles; or an uncompressed tar of the set
  --parts <dir>  An export's folder: parts.json and the parts it lists, checked against it and
                 read in order as the set's tar, without writing a joined file
  --json         Print the report as JSON instead of text
  -h, --help     Show this help

Exit codes: 0 valid, 1 invalid, 2 usage or IO error.
`;

function usageError(message: string): number {
  process.stderr.write(`validate-recording: ${message}\n\n${USAGE}`);
  return 2;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}

const OPTIONS = {
  json: { type: "boolean" },
  parts: { type: "string" },
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
  const parts = values.parts;
  if (parts !== undefined ? positionals.length > 0 : positionals.length !== 1) {
    return usageError("Give exactly one path, or --parts <dir>");
  }
  const path = parts ?? (positionals[0] as string);

  let report: RecordingValidationReport;
  try {
    report =
      parts !== undefined ? await validateRecordingParts(parts) : await validateRecording(path);
  } catch (error) {
    const kind = error instanceof BundleIoError ? "" : "internal error: ";
    process.stderr.write(`validate-recording: ${kind}${describeError(error)}\n`);
    return 2;
  }
  process.stdout.write(
    values.json === true
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatRecordingReport(report, path),
  );
  return report.valid ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
