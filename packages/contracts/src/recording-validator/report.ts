// validate-recording's report and its text form. Like the bundle validator's, it names files,
// lines, frames and counts, never values from the recording.

import {
  displayPath,
  formatBytes,
  formatReport,
  type OmittedProblems,
  type Problem,
  plural,
  type ValidationReport,
  where,
} from "../bundle-validator/report.ts";
import type { RecordingEnded, RecordingProfile } from "../generated/contracts.ts";
import type { RecordingProblemCode } from "./codes.ts";

export type RecordingProblem = Problem<RecordingProblemCode>;

export interface RecordingValidationInfo {
  /** Tar members or directory entries read, the set's bundles included. */
  readonly entries: number;
  /** Bytes of file content, from the sizes. */
  readonly bytes: number;
  /** From recording.json when it is valid, otherwise null. */
  readonly profile: RecordingProfile | null;
  readonly ended: RecordingEnded | null;
  readonly closed: boolean | null;
  /** Lines in each of the recording's JSONL files. */
  readonly lines: Readonly<Record<string, number>>;
  /** frames.jsonl lines with a candidate, and those kept. */
  readonly candidates: number;
  readonly candidates_kept: number;
  /** Blocks in mesh/history.jsonl, and the bytes they inflated to (null if not checked). */
  readonly mesh_blocks: number;
  readonly mesh_inflated_bytes: number | null;
  /** Segments in recording.json, when it is valid. */
  readonly segments: number | null;
  /** For --parts: the parts, and the tar's bytes, as parts.json lists them. */
  readonly parts: number | null;
  readonly tar_bytes: number | null;
  /** Checks that could not run, and why. */
  readonly checks_skipped: readonly string[];
}

/** One bundle of the replay set, checked by validate-bundle. */
export interface BundleResult {
  /** capture-<capture_id>, as the set names it. */
  readonly directory: string;
  readonly report: ValidationReport;
}

export interface RecordingValidationReport {
  /** True when there are no errors, the bundles' included; warnings don't make a set invalid. */
  readonly valid: boolean;
  /**
   * What was read: a recording directory alone, a replay set directory, a tar of the set, or
   * an export's parts read as that tar.
   */
  readonly source: "directory" | "set_directory" | "tar" | "parts";
  /** From the recording directory's name, rec-<recording_id>, when there is one. */
  readonly recording_id: string | null;
  readonly errors: readonly RecordingProblem[];
  readonly warnings: readonly RecordingProblem[];
  readonly omitted: readonly OmittedProblems<RecordingProblemCode>[];
  readonly info: RecordingValidationInfo;
  /** Each bundle's own report, in name order. */
  readonly bundles: readonly BundleResult[];
  /** One line: the first error, or null when valid. */
  readonly failure_reason: string | null;
}

/** Where the problems that aren't about one file are. */
export const WHOLE_SET = "(recording)";

/** The report as text for a terminal: one line per problem, the info, then each bundle's. */
export function formatRecordingReport(report: RecordingValidationReport, name: string): string {
  const lines: string[] = [];
  const verdict = report.valid ? "valid" : "INVALID";
  lines.push(
    `${displayPath(name)} (${report.source}): ${verdict}, ${plural(report.errors.length, "error")}, ${plural(report.warnings.length, "warning")}`,
  );
  const problems = [...report.errors, ...report.warnings];
  const codeWidth = Math.max(0, ...problems.map((problem) => problem.code.length));
  const whereWidth = Math.min(
    40,
    Math.max(0, ...problems.map((problem) => where(problem, WHOLE_SET).length)),
  );
  for (const problem of problems) {
    lines.push(
      `  ${problem.severity.padEnd(7)}  ${problem.code.padEnd(codeWidth)}  ${where(problem, WHOLE_SET).padEnd(whereWidth)}  ${problem.message}`,
    );
  }
  for (const omitted of report.omitted) {
    const scope = omitted.file === null ? "" : ` in ${omitted.file}`;
    lines.push(
      `  omitted  ${plural(omitted.count, "more problem")} with code ${omitted.code}${scope}`,
    );
  }
  const { info } = report;
  const facts: string[] = [];
  if (info.profile !== null) {
    const closed = info.closed === true ? "closed" : "cut off";
    facts.push(`${info.profile}, ended ${info.ended ?? "(open)"}, ${closed}`);
  }
  facts.push(
    `${plural(info.candidates, "candidate")} (${info.candidates_kept} kept)`,
    info.mesh_inflated_bytes === null
      ? `mesh ${plural(info.mesh_blocks, "block")}`
      : `mesh ${plural(info.mesh_blocks, "block")}, ${formatBytes(info.mesh_inflated_bytes)} inflated`,
  );
  if (info.segments !== null) {
    facts.push(
      `${plural(info.segments, "segment")}, ${plural(report.bundles.length, "bundle")} in the set`,
    );
  }
  if (info.parts !== null && info.tar_bytes !== null) {
    facts.push(`${plural(info.parts, "part")}, tar ${formatBytes(info.tar_bytes)}`);
  }
  facts.push(`${plural(info.entries, "entry", "entries")}, ${formatBytes(info.bytes)}`);
  lines.push(`  info     ${facts.join("; ")}`);
  const counts = Object.entries(info.lines).map(([file, count]) => `${file} ${count}`);
  if (counts.length > 0) lines.push(`  lines    ${counts.join(", ")}`);
  for (const skipped of info.checks_skipped) lines.push(`  skipped  ${skipped}`);
  for (const bundle of report.bundles) {
    const text = formatReport(bundle.report, bundle.directory).trimEnd();
    for (const line of text.split("\n")) lines.push(`  | ${line}`);
  }
  return `${lines.join("\n")}\n`;
}
