// @usg/contracts/recording-validator: validates session recordings and replay sets
// (docs/session-recording.md), built on the bundle validator's tar, path, JSONL and image code.
// Node only: it uses Ajv, node:crypto, node:fs and node:zlib, so it is kept out of the
// environment-neutral `.` entry that the apps import.

export { BundleIoError } from "../bundle-validator/source.ts";
export { RECORDING_PROBLEM_CODES, type RecordingProblemCode } from "./codes.ts";
export {
  RECORDING_DIRECTORY_PATTERN,
  RECORDING_LAYOUT_DIRECTORIES,
  RECORDING_REQUIRED_FILES,
} from "./layout.ts";
export {
  type BundleResult,
  formatRecordingReport,
  type RecordingProblem,
  type RecordingValidationInfo,
  type RecordingValidationReport,
} from "./report.ts";
export {
  resolveRecordingLimits,
  type ValidateRecordingOptions,
  validateRecording,
  validateRecordingDirectory,
  validateRecordingParts,
  validateRecordingTar,
} from "./validate.ts";
