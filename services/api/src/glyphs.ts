// The glyph PBFs of @usg/map-style (packages/map-style/glyphs), which GET /glyphs serves so the
// mapper app's WebView and the webapp in development can load them over the LAN. The files are
// listed once at start-up; a request is answered only by looking its font stack and range up in
// that list, so no part of a request ever becomes part of a file path.

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A range file name as MapLibre requests it, such as `0-255.pbf`. */
const RANGE_FILE = /^(\d{1,6})-(\d{1,6})\.pbf$/;

/** The glyphs directory of @usg/map-style. */
export function mapStyleGlyphsDir(): string {
  return dirname(fileURLToPath(import.meta.resolve("@usg/map-style/glyphs/OFL.txt")));
}

/** Whether a file name is a 256-code-point range file, `<start>-<start + 255>.pbf`. */
export function isRangeFile(name: string): boolean {
  const match = RANGE_FILE.exec(name);
  if (match === null) return false;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return start % 256 === 0 && end === start + 255 && end <= 0xffff;
}

/** Every glyph file: font stack (a directory name) to range file name to absolute path. */
export class GlyphIndex {
  readonly #files: ReadonlyMap<string, ReadonlyMap<string, string>>;

  constructor(dir: string) {
    const stacks = new Map<string, Map<string, string>>();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const ranges = new Map<string, string>();
      for (const file of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
        if (file.isFile() && isRangeFile(file.name)) {
          ranges.set(file.name, join(dir, entry.name, file.name));
        }
      }
      if (ranges.size > 0) stacks.set(entry.name, ranges);
    }
    this.#files = stacks;
  }

  /** The font stacks, sorted. */
  get fontStacks(): string[] {
    return [...this.#files.keys()].sort();
  }

  /** The range files of a font stack, sorted by name. */
  ranges(fontStack: string): string[] {
    return [...(this.#files.get(fontStack)?.keys() ?? [])].sort();
  }

  /** The file for a font stack and range file name, or undefined if there is none. */
  path(fontStack: string, rangeFile: string): string | undefined {
    return this.#files.get(fontStack)?.get(rangeFile);
  }
}
