// Entry points: validate a bundle from a tar stream, a directory, or a path that is either.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { FRAME_NAME_DIGITS } from "../capture-bundle.ts";
import { BundleCollector } from "./bundle.ts";
import { walkDirectory } from "./directory.ts";
import { type BundleLimits, resolveLimits } from "./limits.ts";
import type { ValidationReport } from "./report.ts";
import { BundleIoError, READ_CHUNK_BYTES } from "./source.ts";
import { readTar } from "./tar.ts";

export interface ValidateOptions {
  /**
   * Keyframes the server's privacy re-check quarantined (`captures.quarantined_frames`). Their
   * files in keyframes/, depth/ and confidence/ must be missing from the bundle but still listed
   * in manifest.files; their poses.jsonl and privacy/blur.jsonl lines remain.
   */
  readonly quarantinedFrames?: readonly number[];
  /** Overrides for DEFAULT_BUNDLE_LIMITS (tests use small ones). */
  readonly limits?: Partial<BundleLimits>;
}

const MAX_FRAME = 10 ** FRAME_NAME_DIGITS - 1;

function setup(options: ValidateOptions): { collector: BundleCollector; limits: BundleLimits } {
  const quarantined = new Set<number>();
  for (const frame of options.quarantinedFrames ?? []) {
    if (!Number.isInteger(frame) || frame < 0 || frame > MAX_FRAME) {
      throw new TypeError(`A quarantined frame must be an integer from 0 to ${MAX_FRAME}`);
    }
    quarantined.add(frame);
  }
  const limits = resolveLimits(options.limits);
  return { collector: new BundleCollector(limits, quarantined), limits };
}

/**
 * Validates a bundle tar read from `source`: a Node stream (from a file or from S3) or any async
 * iterable of byte chunks. The stream is read once and closed. Rejects with BundleIoError if the
 * source fails; every problem with the content is in the report.
 */
export async function validateBundleTar(
  source: AsyncIterable<unknown>,
  options: ValidateOptions = {},
): Promise<ValidationReport> {
  const { collector, limits } = setup(options);
  await collector.consume(readTar(source, limits));
  return collector.finish("tar");
}

/** Validates a bundle directory, capture-<capture_id>/. */
export async function validateBundleDirectory(
  path: string,
  options: ValidateOptions = {},
): Promise<ValidationReport> {
  const { collector, limits } = setup(options);
  await collector.consume(walkDirectory(path, limits));
  return collector.finish("directory");
}

/** Validates the bundle at `path`: a bundle directory, or a tar file. */
export async function validateBundle(
  path: string,
  options: ValidateOptions = {},
): Promise<ValidationReport> {
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(path);
  } catch (cause) {
    throw new BundleIoError(`Cannot read ${path}`, { cause });
  }
  if (stats.isDirectory()) return validateBundleDirectory(path, options);
  if (!stats.isFile()) throw new BundleIoError(`${path} is not a directory or a file`);
  return validateBundleTar(createReadStream(path, { highWaterMark: READ_CHUNK_BYTES }), options);
}
