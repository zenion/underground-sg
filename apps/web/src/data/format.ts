// Text the page shows about the loaded version. Times are shown in Singapore time, whatever the
// device's time zone (CLAUDE.md, "Conventions").

import type { LatestPointer } from "@usg/contracts";

const publishedFormat = new Intl.DateTimeFormat("en-SG", {
  timeZone: "Asia/Singapore",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** When a version was published, in Singapore time, such as "15 Oct 2026, 9:00 am". */
export function formatPublishedAt(publishedAt: string): string {
  const time = Date.parse(publishedAt);
  return Number.isNaN(time) ? publishedAt : publishedFormat.format(time);
}

/** One line about the version on screen, such as "Map version 7 · 2 Nov 2026, 2:05 pm". */
export function versionLine(latest: LatestPointer): string {
  return `Map version ${latest.version} · ${formatPublishedAt(latest.published_at)}`;
}
