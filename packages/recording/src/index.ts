// @usg/recording: session recordings on the PC (docs/session-recording.md, ADR 0010).
// Environment-neutral, so the mapper app's trace-playing fake can share it later; file work, git
// and the CLI are in the ./node entry. For now: the synthetic replay sets and the deterministic
// DEFLATE their mesh history uses.

export { deflateRaw } from "./deflate.ts";
export {
  CORRIDOR_LEAN,
  corridorLean,
  ESPLANADE_MRT_VENUE,
  EXIT_F_DOOR,
  type SetDigests,
  type SyntheticSet,
} from "./synthetic/corridor-lean.ts";
