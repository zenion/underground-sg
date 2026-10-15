// What the webapp gives map-style's applyStatus: status.json narrowed to the version on screen.
// status.json is never part of a version (docs/snapshot-format.md, "status.json"), so it can name
// features the loaded indoor.json doesn't have, or name them with the wrong type; a client ignores
// those entries. A missing or unreadable status.json counts as one with no entries.

import { type IndoorSnapshot, SNAPSHOT_SCHEMA_VERSION, type StatusOverlay } from "@usg/contracts";

/** A status overlay with no entries: what a missing or unreadable status.json means. */
export function emptyStatus(now: Date = new Date()): StatusOverlay {
  return { schema_version: SNAPSHOT_SCHEMA_VERSION, generated_at: now.toISOString(), entries: [] };
}

/**
 * The overlay's entries for nodes and edges the version has, with the same feature type. Entries
 * for other features are dropped; applyStatus then decides, by time, which are closed.
 */
export function statusForVersion(overlay: StatusOverlay, indoor: IndoorSnapshot): StatusOverlay {
  const types = new Map<string, string>();
  for (const feature of indoor.features) {
    const type = feature.properties.feature_type;
    if (type === "node" || type === "edge") types.set(feature.id, type);
  }
  return {
    ...overlay,
    entries: overlay.entries.filter((entry) => types.get(entry.feature_id) === entry.feature_type),
  };
}
