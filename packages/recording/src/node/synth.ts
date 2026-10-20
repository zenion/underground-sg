// `pnpm rec synth`: writes the synthetic replay sets, by default into the package's
// fixtures/synthetic/, where they are tracked (.gitignore re-includes their rec-*/ directories) and
// CI regenerates them and fails on a diff. Like every `pnpm rec` command it refuses output paths
// outside its allowed roots: here fixtures/synthetic/ and the repo's git-ignored .data/. In
// fixtures/synthetic/ it also removes every directory that isn't a known set, so CI's diff shows
// anything copied in beside them.

import { mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { corridorLean, type SyntheticSet } from "../synthetic/corridor-lean.ts";
import { SYNTHETIC_SET_NAMES } from "../synthetic/sets.ts";
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

/** Removes every directory in `dir` that isn't one of SYNTHETIC_SET_NAMES; returns their names. */
export function removeStrayDirectories(dir: string): string[] {
  const removed: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || SYNTHETIC_SET_NAMES.includes(entry.name)) continue;
    rmSync(join(dir, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed.sort();
}

export interface SynthesizeOptions {
  /**
   * Remove every other directory beside the sets. By default only in fixtures/synthetic/, where
   * nothing but the generated sets belongs; .data/ holds the owner's own data.
   */
  readonly removeStrays?: boolean;
}

export interface Synthesized {
  readonly sets: WrittenSet[];
  /** The directories removed beside the sets, by name. */
  readonly removed: string[];
}

/** Writes every synthetic set into `outDir` (by default the package's fixtures/synthetic/). */
export function synthesize(
  outDir = SYNTHETIC_DIR,
  roots: readonly string[] = [SYNTHETIC_DIR, DATA_DIR],
  options: SynthesizeOptions = {},
): Synthesized {
  checkOutputDir(outDir, roots);
  const sets = syntheticSets();
  for (const set of sets) {
    // The git check allows only the named sets, so an unnamed one could never be pushed.
    if (!SYNTHETIC_SET_NAMES.includes(set.name)) {
      throw new Error(`the set ${set.name} is not in SYNTHETIC_SET_NAMES (src/synthetic/sets.ts)`);
    }
  }
  const written = sets.map((set) => writeSet(set, outDir, roots));
  const removeStrays =
    options.removeStrays ?? (isInside(outDir, SYNTHETIC_DIR) && isInside(SYNTHETIC_DIR, outDir));
  return { sets: written, removed: removeStrays ? removeStrayDirectories(outDir) : [] };
}
