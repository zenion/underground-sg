// What a failed walk build may print in the public Actions log (.github/workflows/walk-build.yml;
// the lean recorder design, section 10; ADR 0009 "Builds and accounts"): only its error lines,
// each masked. The build's own output goes to a file, never to the log, because it names the
// iPhone (its UDID), the developer team and the install link. Pure, so Vitest covers it on any
// OS; walk-build-log.mts reads the file on the runner.

/** At most this many error lines are printed, each cut to `MAX_LINE_LENGTH` characters. */
export const MAX_LINES = 200;
export const MAX_LINE_LENGTH = 400;

interface Mask {
  readonly pattern: RegExp;
  readonly replacement: string;
}

/** In this order: URLs first, so a URL's own ids go with it. */
export const MASKS: readonly Mask[] = [
  // Any URL: the install link, expo.dev pages, signed storage URLs.
  { pattern: /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>)]+/g, replacement: "<url>" },
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replacement: "<email>" },
  // UUIDs: build ids, profile ids, older UDIDs written as UUIDs.
  {
    pattern: /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g,
    replacement: "<uuid>",
  },
  // UDIDs of iPhones since the XS: 8 and 16 hex digits.
  { pattern: /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}/g, replacement: "<udid>" },
  // Older 40-hex UDIDs, commit SHAs, certificate fingerprints and any other long hex.
  { pattern: /[0-9A-Fa-f]{24,}/g, replacement: "<hex>" },
  // Apple team ids: 10 capitals and digits with at least one of each.
  {
    pattern:
      /(?<![A-Za-z0-9])(?=[A-Z0-9]{10}(?![A-Za-z0-9]))(?=[A-Z0-9]*[0-9])(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10}/g,
    replacement: "<team>",
  },
  // A home folder's user name.
  { pattern: /\/Users\/[^/\s]+/g, replacement: "/Users/<user>" },
];

/** The line with every mask applied, cut to MAX_LINE_LENGTH. */
export function maskLine(line: string): string {
  let masked = line;
  for (const mask of MASKS) masked = masked.replace(mask.pattern, mask.replacement);
  return masked.length > MAX_LINE_LENGTH ? `${masked.slice(0, MAX_LINE_LENGTH)}…` : masked;
}

/**
 * The log's error lines, masked, at most MAX_LINES, each prefixed with "| " so none can start
 * with "::" and be read as a workflow command.
 */
export function errorLines(log: string): string[] {
  const lines = log
    .split(/\r?\n/)
    .filter((line) => /error:/i.test(line))
    .map((line) => `| ${maskLine(line.trim())}`);
  if (lines.length <= MAX_LINES) return lines;
  return [...lines.slice(0, MAX_LINES), `| (${lines.length - MAX_LINES} more error lines)`];
}
