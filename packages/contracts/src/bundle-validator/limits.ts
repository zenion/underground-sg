// Size and count limits for capture bundles (docs/capture-bundle.md, "Ingest and validation").
// Sized for a 3 to 5 minute segment on an iPhone 17 Pro Max with plenty of headroom: the doc's
// example segment (2 min 38 s) has 4210 frames and 312 keyframes, and a 5-minute segment is
// roughly 300-600 MB. Raise a limit if real bundles come close; never remove one.

import { UPLOAD_PART_BYTES } from "../capture-bundle.ts";

const KiB = 1024;
const MiB = 1024 * KiB;

export interface BundleLimits {
  /**
   * Whole bundle: the tar stream's length, or the sum of file sizes for a directory. By default
   * maxUploadParts parts of UPLOAD_PART_BYTES, so a bundle within it can always be uploaded.
   */
  readonly maxBundleBytes: number;
  /**
   * Upload parts of UPLOAD_PART_BYTES, 16 MiB (`packBundle(dir, partBytes)`). Enforced by the
   * API when it creates the multipart upload; the validator only sees the reassembled tar.
   */
  readonly maxUploadParts: number;
  /** Tar members or directory entries, files and directories together. */
  readonly maxEntries: number;
  /** manifest.json, anchors.json, tags.json, preview/floorplan.geojson: read into memory. */
  readonly maxJsonBytes: number;
  /** Each .jsonl file: streamed line by line. */
  readonly maxJsonlBytes: number;
  /** One line of a .jsonl file, without its newline. */
  readonly maxJsonlLineBytes: number;
  /** Each keyframe JPEG. */
  readonly maxJpegBytes: number;
  /**
   * Pixels in a keyframe: manifest.image_size width times height. Keyframe JPEGs must have that
   * size, so this bounds what processing decodes (depth_size is fixed at 256 x 192).
   */
  readonly maxImagePixels: number;
  /** Each depth or confidence PNG. */
  readonly maxPngBytes: number;
  /** mesh/scene.ply. */
  readonly maxPlyBytes: number;
  /** The PLY header, up to and including `end_header`. */
  readonly maxPlyHeaderBytes: number;
  /** PLY `element vertex` count, checked before the body is read. */
  readonly maxPlyVertices: number;
  /** PLY `element face` count, checked before the body is read. */
  readonly maxPlyFaces: number;
}

const MAX_UPLOAD_PARTS = 128;

/** The limits ingest uses. Tests pass smaller ones through `ValidateOptions.limits`. */
export const DEFAULT_BUNDLE_LIMITS: BundleLimits = Object.freeze({
  maxBundleBytes: MAX_UPLOAD_PARTS * UPLOAD_PART_BYTES, // 2 GiB
  maxUploadParts: MAX_UPLOAD_PARTS,
  maxEntries: 20_000,
  maxJsonBytes: 16 * MiB,
  maxJsonlBytes: 256 * MiB,
  maxJsonlLineBytes: 64 * KiB,
  maxJpegBytes: 16 * MiB,
  maxImagePixels: 4096 * 4096,
  maxPngBytes: 4 * MiB,
  maxPlyBytes: 256 * MiB,
  maxPlyHeaderBytes: 4 * KiB,
  maxPlyVertices: 5_000_000,
  maxPlyFaces: 10_000_000,
});

/** `DEFAULT_BUNDLE_LIMITS` with `overrides` applied; every value must be a positive integer. */
export function resolveLimits(overrides: Partial<BundleLimits> = {}): BundleLimits {
  const limits = { ...DEFAULT_BUNDLE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`Bundle limit ${name} must be a positive integer, got ${String(value)}`);
    }
  }
  return Object.freeze(limits);
}
