// Helpers for the bundle validator tests.

import { expect } from "vitest";
import {
  type Problem,
  type ProblemCode,
  type ValidateOptions,
  type ValidationReport,
  validateBundleDirectory,
  validateBundleTar,
} from "../src/bundle-validator/index.ts";
import { BUNDLE_DIR, type BundleFiles, writeBundleDirectory } from "./bundle-fixture.ts";
import { bundleTar, chunks } from "./tar-writer.ts";

/** Validates the files as an in-memory tar, streamed in chunks of `chunkSize` bytes. */
export function validateAsTar(
  files: BundleFiles,
  options: ValidateOptions = {},
  chunkSize = 4096,
): Promise<ValidationReport> {
  return validateBundleTar(chunks(bundleTar(files), chunkSize), options);
}

/** Validates the files written as a bundle directory. */
export function validateAsDirectory(
  files: BundleFiles,
  options: ValidateOptions = {},
  name = BUNDLE_DIR,
): Promise<ValidationReport> {
  return validateBundleDirectory(writeBundleDirectory(files, name), options);
}

export function problems(report: ValidationReport): Problem[] {
  return [...report.errors, ...report.warnings];
}

export function codes(report: ValidationReport): ProblemCode[] {
  return [...new Set(problems(report).map((problem) => problem.code))];
}

/** Asserts that the report has a problem with this code (and file and line, when given). */
export function expectProblem(
  report: ValidationReport,
  code: ProblemCode,
  file?: string | null,
  line?: number,
): Problem {
  const found = problems(report).find(
    (problem) =>
      problem.code === code &&
      (file === undefined || problem.file === file) &&
      (line === undefined || problem.line === line),
  );
  expect(
    found,
    `${code} ${file ?? ""} in ${JSON.stringify(problems(report), null, 2)}`,
  ).toBeDefined();
  return found as Problem;
}

/** Asserts a valid report with no warnings. */
export function expectClean(report: ValidationReport): void {
  expect(problems(report)).toEqual([]);
  expect(report.valid).toBe(true);
  expect(report.failure_reason).toBeNull();
}
