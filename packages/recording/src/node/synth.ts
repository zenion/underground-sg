// `pnpm rec synth`: writes the synthetic replay sets, by default into the package's
// fixtures/synthetic/, where they are tracked (.gitignore re-includes their rec-*/ directories) and
// CI regenerates them and fails on a diff. Like every `pnpm rec` command it refuses output paths
// outside its allowed roots: here fixtures/synthetic/ and the repo's git-ignored .data/.

import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { corridorLean, type SyntheticSet } from "../synthetic/corridor-lean.ts";
import { NODE_DIGESTS } from "./digests.ts";

export const PACKAGE_DIR = resolve(import.meta.dirname, "..", "..");
export const REPO_DIR = resolve(PACKAGE_DIR, "..", "..");
/** Where the tracked sets live. */
export const SYNTHETIC_DIR = join(PACKAGE_DIR, "fixtures", "synthetic");
/** The repo's git-ignored data directory. */
export const DATA_DIR = join(REPO_DIR, ".data");

/** Every synthetic set `pnpm rec synth` writes. */
export function syntheticSets(): SyntheticSet[] {
  return [corridorLean(NODE_DIGESTS)];
}

export class OutputPathError extends Error {
  override name = "OutputPathError";
}

/** The path with symbolic links resolved as far as it exists, so a link can't lead outside. */
function canonical(path: string): string {
  const rest: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(current), ...rest.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.push(basename(current));
      current = parent;
    }
  }
}

/** Whether `path` is `root` or inside it. */
export function isInside(path: string, root: string): boolean {
  const rel = relative(canonical(root), canonical(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Refuses an output directory outside every allowed root. */
export function checkOutputDir(dir: string, roots: readonly string[]): void {
  if (!roots.some((root) => isInside(dir, root))) {
    throw new OutputPathError(
      "the output must be inside packages/recording/fixtures/synthetic/ or .data/",
    );
  }
}

export interface WrittenSet {
  readonly name: string;
  readonly dir: string;
  readonly files: number;
  readonly bytes: number;
}

/** Replaces `<outDir>/<set name>/` with the set's files. */
export function writeSet(set: SyntheticSet, outDir: string, roots: readonly string[]): WrittenSet {
  checkOutputDir(outDir, roots);
  if (/^(rec|replay)-/.test(set.name) || set.name.includes("/")) {
    // .gitignore ignores rec-*/ and replay-*/ anywhere, so nothing inside could be re-included.
    throw new Error("a set's directory name must not start with rec- or replay-");
  }
  const dir = join(outDir, set.name);
  rmSync(dir, { recursive: true, force: true });
  let bytes = 0;
  for (const [path, data] of set.files) {
    const target = join(dir, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    bytes += data.length;
  }
  return { name: set.name, dir, files: set.files.size, bytes };
}

/** Writes every synthetic set into `outDir` (by default the package's fixtures/synthetic/). */
export function synthesize(
  outDir = SYNTHETIC_DIR,
  roots: readonly string[] = [SYNTHETIC_DIR, DATA_DIR],
): WrittenSet[] {
  checkOutputDir(outDir, roots);
  return syntheticSets().map((set) => writeSet(set, outDir, roots));
}
