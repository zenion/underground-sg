// The synthetic sets' directory names under fixtures/synthetic/, kept apart from the builders so
// the git check can name them without loading or building any set.

/** The corridor-lean set's directory name under fixtures/synthetic/ (never rec-* or replay-*). */
export const CORRIDOR_LEAN = "corridor-lean";

/**
 * Every set `pnpm rec synth` writes, by directory name. The git check allows recording files only
 * inside these, and `pnpm rec synth` removes any other directory beside them.
 */
export const SYNTHETIC_SET_NAMES: readonly string[] = [CORRIDOR_LEAN];
