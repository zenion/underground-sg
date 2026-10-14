// What the tar reader and the directory walker produce: one event per entry, in order.

import type { ProblemCode } from "./report.ts";

/** Chunk size for reading a tar file or a bundle directory's files from disk. */
export const READ_CHUNK_BYTES = 1024 * 1024;

export type SourceEvent =
  | { readonly kind: "directory"; readonly name: string }
  | {
      readonly kind: "file";
      readonly name: string;
      /** Size from the tar header or lstat, known before the content is read. */
      readonly size: number;
      /**
       * The content, in chunks that are only valid until the next one is requested. Call at
       * most once; a file that is never opened is skipped.
       */
      readonly open: () => AsyncIterable<Uint8Array>;
    }
  | {
      readonly kind: "problem";
      readonly code: ProblemCode;
      /** The member or entry name, if there is one. */
      readonly name: string | null;
      readonly message: string;
      /** Reading stopped: nothing after this problem was read. */
      readonly fatal: boolean;
    };

/**
 * The bundle could not be read at all: the path does not exist, a read failed, or the stream
 * errored. Not a verdict on the bundle; the CLI exits with 2.
 */
export class BundleIoError extends Error {
  override name = "BundleIoError";
}

export function problem(
  code: ProblemCode,
  name: string | null,
  message: string,
  fatal = false,
): SourceEvent {
  return { kind: "problem", code, name, message, fatal };
}
