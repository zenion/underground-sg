// @usg/contracts/bundle-validator: validates capture bundles (docs/capture-bundle.md, "Ingest and
// validation"). Node only: it uses Ajv, node:crypto and node:fs, so it is kept out of the
// environment-neutral `.` entry that the apps import.

export { AFFINE_TOLERANCE, FACING_TOLERANCE, MAX_INVALID_JSONL_LINES } from "./bundle.ts";
export { BUNDLE_DIRECTORY_PATTERN, REQUIRED_FILES } from "./layout.ts";
export { type BundleLimits, DEFAULT_BUNDLE_LIMITS, resolveLimits } from "./limits.ts";
export {
  formatReport,
  type OmittedProblems,
  PROBLEM_CODES,
  type Problem,
  type ProblemCode,
  type Severity,
  type ValidationInfo,
  type ValidationReport,
} from "./report.ts";
export { type AjvOptions, createAjv, validatorFor } from "./schemas.ts";
export { BundleIoError } from "./source.ts";
export {
  type ValidateOptions,
  validateBundle,
  validateBundleDirectory,
  validateBundleTar,
} from "./validate.ts";
