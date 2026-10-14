// A small ustar writer for the tests: builds well-formed archives, and malformed ones on request.

import { BUNDLE_DIR, type BundleFiles, concat } from "./bundle-fixture.ts";

const BLOCK = 512;

export interface TarEntry {
  readonly name: string;
  /** The typeflag: "0" file (default), "5" directory, "1" hard link, "2" symlink, "x" pax, ... */
  readonly type?: string;
  readonly data?: Uint8Array;
  readonly linkname?: string;
  /** POSIX "ustar\0" + "00" (default) or GNU "ustar  \0". */
  readonly magic?: "posix" | "gnu" | "none";
  readonly prefix?: string;
  /** Overrides the size field (the data written is still `data`). */
  readonly size?: number;
  /** Adds this to the stored checksum. */
  readonly checksumError?: number;
  /** Name bytes written as they are (for non-ASCII names). */
  readonly nameBytes?: Uint8Array;
}

function writeField(header: Uint8Array, offset: number, length: number, value: string): void {
  for (let i = 0; i < Math.min(length, value.length); i++) {
    header[offset + i] = value.charCodeAt(i) & 0xff;
  }
}

function octal(value: number, digits: number): string {
  return `${value.toString(8).padStart(digits, "0")}\u0000`;
}

export function tarHeader(entry: TarEntry): Uint8Array {
  const header = new Uint8Array(BLOCK);
  if (entry.nameBytes !== undefined) header.set(entry.nameBytes.subarray(0, 100), 0);
  else writeField(header, 0, 100, entry.name);
  writeField(header, 100, 8, octal(entry.type === "5" ? 0o755 : 0o644, 7));
  writeField(header, 108, 8, octal(0, 7));
  writeField(header, 116, 8, octal(0, 7));
  writeField(header, 124, 12, octal(entry.size ?? entry.data?.length ?? 0, 11));
  writeField(header, 136, 12, octal(1_792_461_121, 11));
  writeField(header, 156, 1, entry.type ?? "0");
  writeField(header, 157, 100, entry.linkname ?? "");
  const magic = entry.magic ?? "posix";
  if (magic === "posix") writeField(header, 257, 8, "ustar\u000000");
  else if (magic === "gnu") writeField(header, 257, 8, "ustar  \u0000");
  writeField(header, 329, 8, octal(0, 7));
  writeField(header, 337, 8, octal(0, 7));
  writeField(header, 345, 155, entry.prefix ?? "");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  writeField(
    header,
    148,
    8,
    `${(sum + (entry.checksumError ?? 0)).toString(8).padStart(6, "0")}\u0000 `,
  );
  return header;
}

export interface TarOptions {
  /** Zero blocks at the end (2 is correct). */
  readonly endBlocks?: number;
  /** Bytes after the end-of-archive marker. */
  readonly trailing?: Uint8Array;
}

export function writeTar(entries: readonly TarEntry[], options: TarOptions = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    parts.push(tarHeader(entry));
    const data = entry.data ?? new Uint8Array(0);
    parts.push(data);
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
    parts.push(new Uint8Array(padding));
  }
  parts.push(new Uint8Array(BLOCK * (options.endBlocks ?? 2)));
  if (options.trailing !== undefined) parts.push(options.trailing);
  return concat(parts);
}

/** The tar members for a bundle: the directories first, then the files, as packBundle would. */
export function bundleEntries(files: BundleFiles, top = BUNDLE_DIR): TarEntry[] {
  const directories = new Set<string>();
  for (const path of files.keys()) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  return [
    { name: `${top}/`, type: "5" },
    ...[...directories].sort().map((dir) => ({ name: `${top}/${dir}/`, type: "5" })),
    ...[...files.keys()].sort().map((path) => ({ name: `${top}/${path}`, data: files.get(path) })),
  ];
}

export function bundleTar(
  files: BundleFiles,
  top = BUNDLE_DIR,
  options: TarOptions = {},
): Uint8Array {
  return writeTar(bundleEntries(files, top), options);
}

/** `bytes` as an async stream of chunks of `size` bytes. */
export async function* chunks(bytes: Uint8Array, size = 4096): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}
