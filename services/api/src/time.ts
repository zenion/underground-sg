// Times shown to people and written into public files are in Singapore time (CLAUDE.md).

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Singapore",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "longOffset",
});

/**
 * An RFC 3339 date-time in Asia/Singapore time to the second, for example
 * `2026-11-02T14:05:11+08:00` (the snapshot format's `published_at`). Fractions of a second are
 * dropped.
 */
export function singaporeDateTime(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid date");
  const parts = Object.fromEntries(
    PARTS.formatToParts(date).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  // longOffset gives "GMT+08:00" (Singapore has kept +08:00 since 1982).
  const offset = (parts["timeZoneName"] ?? "").replace(/^GMT/, "") || "+00:00";
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}:${parts["second"]}${offset}`;
}
