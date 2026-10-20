// Walks a bundle directory (or a recording's) as source events, in sorted order, without following
// links: a symbolic link or a Windows junction is reported, never entered or read. Only the
// layout's directories are entered; other directories are reported by the caller and not walked.

import { createReadStream } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { LAYOUT_DIRECTORIES } from "./layout.ts";
import type { BundleLimits } from "./limits.ts";
import { BundleIoError, problem, READ_CHUNK_BYTES, type SourceEvent } from "./source.ts";

/**
 * The file's content, which must be `size` bytes; or, given `start`, `size` bytes of it from
 * there. Throws BundleIoError if it can't be read or changes size meanwhile.
 */
export async function* readFileChunks(
  path: string,
  size: number,
  start?: number,
): AsyncGenerator<Uint8Array> {
  if (start !== undefined && size === 0) return;
  const range = start === undefined ? {} : { start, end: start + size - 1 };
  const stream = createReadStream(path, { highWaterMark: READ_CHUNK_BYTES, ...range });
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += (chunk as Uint8Array).length;
      if (bytes > size) break;
      yield chunk as Uint8Array;
    }
  } catch (cause) {
    throw new BundleIoError(`Reading ${path} failed`, { cause });
  } finally {
    stream.destroy();
  }
  if (bytes !== size) throw new BundleIoError(`${path} changed while it was being read`);
}

async function io<T>(what: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (cause) {
    throw new BundleIoError(what, { cause });
  }
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * The events for the bundle directory at `root`. The directory itself must exist (it is
 * followed if it is a link); its name is the bundle directory name, capture-<capture_id>.
 * Throws BundleIoError if it can't be read. validate-recording walks a recording directory with
 * its own `directories` and limits.
 */
export async function* walkDirectory(
  root: string,
  limits: Pick<BundleLimits, "maxBundleBytes" | "maxEntries">,
  directories: readonly string[] = LAYOUT_DIRECTORIES,
): AsyncGenerator<SourceEvent> {
  const absolute = resolve(root);
  const rootStats = await io(`Cannot read ${root}`, () => stat(absolute));
  if (!rootStats.isDirectory()) throw new BundleIoError(`${root} is not a directory`);
  const top = basename(absolute);
  yield { kind: "directory", name: `${top}/` };

  let entries = 1;
  let bytes = 0;
  const pending: { fsPath: string; name: string; depth: number }[] = [
    { fsPath: absolute, name: top, depth: 0 },
  ];
  while (pending.length > 0) {
    const dir = pending.shift();
    if (dir === undefined) break;
    const dirents = await io(`Cannot list ${dir.fsPath}`, () =>
      readdir(dir.fsPath, { withFileTypes: true }),
    );
    for (const dirent of dirents.sort(byName)) {
      entries++;
      if (entries > limits.maxEntries) {
        yield problem(
          "limits.entry_count",
          null,
          `More than ${limits.maxEntries} entries (maxEntries)`,
          true,
        );
        return;
      }
      const fsPath = join(dir.fsPath, dirent.name);
      const name = `${dir.name}/${dirent.name}`;
      // lstat, not the dirent type: it reports Windows junctions as links too.
      const stats = await io(`Cannot read ${fsPath}`, () => lstat(fsPath));
      if (stats.isSymbolicLink()) {
        yield problem("entry.link", name, "A symbolic link or junction; it was not followed");
      } else if (stats.isDirectory()) {
        yield { kind: "directory", name: `${name}/` };
        const enter = dir.depth === 0 && directories.includes(dirent.name);
        if (enter) pending.push({ fsPath, name, depth: dir.depth + 1 });
      } else if (stats.isFile()) {
        bytes += stats.size;
        if (bytes > limits.maxBundleBytes) {
          yield problem(
            "limits.bundle_size",
            name,
            `The bundle is larger than ${limits.maxBundleBytes} bytes (maxBundleBytes)`,
            true,
          );
          return;
        }
        let opened = false;
        yield {
          kind: "file",
          name,
          size: stats.size,
          open: () => {
            if (opened) throw new Error(`${name} was opened twice`);
            opened = true;
            return readFileChunks(fsPath, stats.size);
          },
          reread: (start: number, length: number) => readFileChunks(fsPath, length, start),
        };
      } else {
        yield problem(
          "entry.special_file",
          name,
          "Not a regular file or directory (a device, FIFO or socket)",
        );
      }
    }
  }
}
