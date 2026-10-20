// The git check (ADR 0010, "Git and EAS"): a pushed branch of the public repo is already
// published, so CI and the pre-push hook refuse any tracked recording.json that isn't
// `origin: synthetic`, and recording or bundle files anywhere but the generated synthetic sets
// and the hand-made fixture directories. Problems name paths and commits, never file contents.

import { spawnSync } from "node:child_process";

/** The generated sets: packages/recording/fixtures/synthetic/<set>/, as `pnpm rec synth` writes. */
export const SYNTHETIC_SETS_DIR = "packages/recording/fixtures/synthetic/";

/**
 * Hand-made fixture directories allowed to hold recording or bundle files. None today (checked
 * 2026-10-21): the validators' tests build their recordings and bundles in code
 * (packages/contracts/test/recording-fixture.ts, bundle-fixture.ts), and the Swift goldens in
 * apps/mapper/modules/capture-native/Tests/CaptureCoreTests/Golden/ are named by type
 * (RecordingFrameLine.jsonl, GnssLine.jsonl), which no rule matches. Add a directory here only
 * for synthetic files, in a reviewed change; its recording.json files must still be synthetic.
 */
export const HAND_MADE_FIXTURE_DIRS: readonly string[] = [];

/** File names the recorder, the bundle writer and the export write. */
const RECORDING_FILE_NAMES = new Set([
  "recording.json",
  "frames.jsonl",
  "boundary.jsonl",
  "location.jsonl",
  "history.bin",
  "poses.jsonl",
  "gnss.jsonl",
  "parts.json",
]);

export type TrackedProblemCode =
  | "recording_not_synthetic"
  | "recording_file_outside_sets"
  | "no_synthetic_recording";

export interface TrackedProblem {
  readonly code: TrackedProblemCode;
  /** The tracked path, or null for a problem with the whole tree. */
  readonly path: string | null;
  /** The commit the path is in, when a pre-push check found it; null for the index. */
  readonly commit: string | null;
  readonly message: string;
}

const MESSAGES: Readonly<Record<TrackedProblemCode, string>> = {
  recording_not_synthetic: "a tracked recording.json that doesn't say origin: synthetic",
  recording_file_outside_sets:
    "a recording or bundle file outside the generated synthetic sets and the hand-made fixture directories",
  no_synthetic_recording: `no tracked recording.json in the generated sets (${SYNTHETIC_SETS_DIR}<set>/)`,
};

/** Whether the path's name is one the recorder, the bundle or the export writes. */
export function isRecordingFile(path: string): boolean {
  // Lowercase: a checkout on Windows or macOS doesn't tell RECORDING.json from recording.json.
  const segments = path.toLowerCase().split("/");
  const name = segments[segments.length - 1] ?? "";
  const parent = segments[segments.length - 2];
  return (
    RECORDING_FILE_NAMES.has(name) ||
    name.endsWith(".part") ||
    segments.slice(0, -1).includes("candidates") ||
    (name === "manifest.json" && parent !== undefined && parent.startsWith("capture-"))
  );
}

/** Whether the path is inside a generated set: fixtures/synthetic/<set>/, any depth below. */
export function inSyntheticSet(path: string): boolean {
  if (!path.startsWith(SYNTHETIC_SETS_DIR)) return false;
  const [set, ...rest] = path.slice(SYNTHETIC_SETS_DIR.length).split("/");
  return set !== undefined && rest.length > 0 && !/^(rec|replay)-/.test(set) && set !== "";
}

function inAllowedDir(path: string): boolean {
  return (
    inSyntheticSet(path) ||
    HAND_MADE_FIXTURE_DIRS.some((dir) => path.startsWith(dir.endsWith("/") ? dir : `${dir}/`))
  );
}

/** Whether a recording.json's bytes say `origin: synthetic`; unreadable JSON doesn't. */
export function isSyntheticRecording(bytes: Uint8Array): boolean {
  try {
    const document: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return (
      typeof document === "object" &&
      document !== null &&
      (document as Record<string, unknown>)["origin"] === "synthetic"
    );
  } catch {
    return false;
  }
}

function isRecordingJson(path: string): boolean {
  return (path.toLowerCase().split("/").pop() ?? "") === "recording.json";
}

export interface CheckOptions {
  /** Fail when the tree holds no tracked recording.json in the generated sets (CI). */
  readonly requireSets?: boolean;
  /** The commit the paths are from, for the messages; null for the index. */
  readonly commit?: string | null;
}

/** Checks one tree's paths; `synthetic` reads a recording.json and says whether it is synthetic. */
export function checkPaths(
  paths: readonly string[],
  synthetic: (path: string) => boolean,
  options: CheckOptions = {},
): TrackedProblem[] {
  const commit = options.commit ?? null;
  const problems: TrackedProblem[] = [];
  const problem = (code: TrackedProblemCode, path: string | null): void => {
    problems.push({ code, path, commit, message: MESSAGES[code] });
  };
  let sets = 0;
  for (const path of paths) {
    if (isRecordingJson(path)) {
      if (!synthetic(path)) problem("recording_not_synthetic", path);
      else if (inSyntheticSet(path)) sets++;
    }
    if (isRecordingFile(path) && !inAllowedDir(path)) problem("recording_file_outside_sets", path);
  }
  if (options.requireSets === true && sets === 0) problem("no_synthetic_recording", null);
  return problems;
}

/** Runs git in `cwd`, returning stdout as bytes; throws with git's exit status on failure. */
function git(cwd: string, args: readonly string[]): Buffer {
  const result = spawnSync("git", args, { cwd, maxBuffer: 1 << 30, windowsHide: true });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${result.status ?? "signal"})`);
  }
  return result.stdout;
}

function nulSeparated(output: Buffer): string[] {
  return output
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry !== "");
}

/** Checks the files tracked in the index (`git ls-files`), as CI does. */
export function checkIndex(cwd: string, options: CheckOptions = {}): TrackedProblem[] {
  const paths = nulSeparated(git(cwd, ["ls-files", "-z", "--cached"]));
  return checkPaths(
    paths,
    (path) => isSyntheticRecording(git(cwd, ["cat-file", "blob", `:${path}`])),
    options,
  );
}

/** Checks the tree of one commit. */
function checkCommit(
  cwd: string,
  commit: string,
  blobOrigins: Map<string, boolean>,
): TrackedProblem[] {
  const entries = nulSeparated(git(cwd, ["ls-tree", "-r", "-z", "--full-tree", commit]));
  const blobs = new Map<string, string>();
  const paths: string[] = [];
  for (const entry of entries) {
    // "<mode> <type> <object>\t<path>"
    const tab = entry.indexOf("\t");
    const [, type, object] = entry.slice(0, tab).split(" ");
    if (type !== "blob" || object === undefined) continue;
    const path = entry.slice(tab + 1);
    paths.push(path);
    blobs.set(path, object);
  }
  return checkPaths(
    paths,
    (path) => {
      const object = blobs.get(path) as string;
      let synthetic = blobOrigins.get(object);
      if (synthetic === undefined) {
        synthetic = isSyntheticRecording(git(cwd, ["cat-file", "blob", object]));
        blobOrigins.set(object, synthetic);
      }
      return synthetic;
    },
    { commit },
  );
}

const ZERO_OBJECT = /^0+$/;

/**
 * Checks every commit a push would publish: for each line git gives the pre-push hook
 * ("<local ref> <local object> <remote ref> <remote object>"), the commits reachable from the
 * local object that no remote-tracking ref has yet. A deleted ref publishes nothing.
 */
export function checkPush(cwd: string, hookInput: string): TrackedProblem[] {
  const tips: string[] = [];
  for (const line of hookInput.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const local = fields[1] as string;
    if (!ZERO_OBJECT.test(local)) tips.push(local);
  }
  if (tips.length === 0) return [];
  const commits = git(cwd, ["rev-list", ...tips, "--not", "--remotes"])
    .toString("utf8")
    .split("\n")
    .filter((commit) => commit !== "");
  // Each recording.json blob is read once, however many commits hold it.
  const blobOrigins = new Map<string, boolean>();
  return commits.flatMap((commit) => checkCommit(cwd, commit, blobOrigins));
}

/** One line per problem: the code, the commit if any, the path and what is wrong. */
export function formatProblems(problems: readonly TrackedProblem[]): string {
  return problems
    .map((problem) => {
      const where = [problem.commit?.slice(0, 12), problem.path].filter((part) => part != null);
      return `${problem.code}: ${where.length > 0 ? `${where.join(" ")}: ` : ""}${problem.message}`;
    })
    .join("\n");
}
