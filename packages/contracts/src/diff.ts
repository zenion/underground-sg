// The change-set diff (docs/diff-format.md): constants and the checks its schema can't express.
// Environment-neutral: the mapper app (Hermes) checks its manual edits with it before upload, and
// processing and the API check every diff.

import type { ChangeSetDiff, DiffEntry } from "./generated/contracts.ts";
import { checkGeometry, type Geometry, NEVER_STEP_FREE_EDGE_KINDS, ProblemList } from "./map.ts";
import { SCHEMA_BASE_URL } from "./schema-ids.ts";

/** Base of the diff schema's `$id`. */
export const DIFF_SCHEMA_BASE_URL = `${SCHEMA_BASE_URL}diff/`;

/** The schema file of `change_sets.diff`. */
export const CHANGE_SET_DIFF_SCHEMA_FILE = "change-set-diff.schema.json";

export const DIFF_OPS = ["add", "modify", "remove"] as const satisfies readonly DiffEntry["op"][];

/**
 * The HEAD tables a change set may touch, by `feature_type`, in the order approval applies adds
 * and modifies (parents before children); removes run in the reverse order.
 */
export const DIFF_FEATURE_TYPES = [
  "venue",
  "level",
  "space",
  "node",
  "edge",
  "poi",
  "anchor",
] as const satisfies readonly DiffEntry["feature_type"][];

/** A HEAD table a change set may touch. */
export type DiffFeatureType = (typeof DIFF_FEATURE_TYPES)[number];

/**
 * The ops a change set may use on each feature type. Venues and levels are added and removed only
 * by the owner's seed script.
 */
export const DIFF_OPS_BY_FEATURE_TYPE = {
  venue: ["modify"],
  level: ["modify"],
  space: ["add", "modify", "remove"],
  node: ["add", "modify", "remove"],
  edge: ["add", "modify", "remove"],
  poi: ["add", "modify", "remove"],
  anchor: ["add", "modify", "remove"],
} as const satisfies Record<DiffFeatureType, readonly DiffEntry["op"][]>;

/**
 * The columns of each feature type's row that reference another HEAD row, and that row's feature
 * type: the foreign keys between the HEAD tables in db/schema.sql (a test keeps them in step).
 * Approval uses them for its rebase check (docs/diff-format.md, "Approval"), and
 * `checkChangeSetDiff` refuses an add or modify whose `after` references a row the same diff
 * removes.
 */
export const DIFF_ROW_REFERENCES = {
  venue: [],
  level: [{ column: "venue_id", feature_type: "venue" }],
  space: [{ column: "level_id", feature_type: "level" }],
  node: [{ column: "level_id", feature_type: "level" }],
  edge: [
    { column: "from_node", feature_type: "node" },
    { column: "to_node", feature_type: "node" },
    { column: "level_id", feature_type: "level" },
  ],
  poi: [
    { column: "space_id", feature_type: "space" },
    { column: "level_id", feature_type: "level" },
  ],
  anchor: [
    { column: "node_id", feature_type: "node" },
    { column: "level_id", feature_type: "level" },
  ],
} as const satisfies Record<
  DiffFeatureType,
  readonly { readonly column: string; readonly feature_type: DiffFeatureType }[]
>;

/** The geometry columns of each feature type's row. */
const GEOMETRY_COLUMNS: Record<DiffFeatureType, readonly string[]> = {
  venue: ["footprint"],
  level: [],
  space: ["geom"],
  node: ["geom"],
  edge: ["geom"],
  poi: ["geom"],
  anchor: ["surveyed_geom"],
};

/** Deep equality of two JSON values; key order doesn't matter. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      jsonEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

function checkRow(entry: DiffEntry, side: "before" | "after", at: string, problems: ProblemList) {
  const row: object | null = entry[side];
  if (row === null) return;
  for (const column of GEOMETRY_COLUMNS[entry.feature_type]) {
    const geometry = (row as Record<string, unknown>)[column] ?? null;
    checkGeometry(geometry as Geometry | null, `${at}.${side}.${column}`, problems);
  }
  if (entry.feature_type === "edge") {
    const edge = entry[side];
    if (edge === null) return;
    if (edge.from_node === edge.to_node) problems.add(`${at}.${side}: from_node equals to_node`);
    if (edge.step_free && (NEVER_STEP_FREE_EDGE_KINDS as readonly string[]).includes(edge.kind)) {
      problems.add(`${at}.${side}: ${edge.kind} edges are never step_free`);
    }
  }
  if (entry.feature_type === "anchor") {
    const anchor = entry[side];
    if (anchor === null) return;
    const set = [anchor.surveyed_geom, anchor.prior_source, anchor.prior_sigma_m].filter(
      (value) => value !== null,
    ).length;
    if (set !== 0 && set !== 3) {
      problems.add(
        `${at}.${side}: surveyed_geom, prior_source and prior_sigma_m are all set or all null`,
      );
    }
  }
}

/**
 * Checks a schema-valid diff for what its schema can't: a status change set's diff is empty and a
 * structural one's is not, at most one entry per feature_type and id, a modify changes something,
 * no add or modify references a row the same diff removes, the rules the database also enforces
 * on rows, and coordinates. Returns the problems; none means valid. Whether each `base_rev` still
 * matches HEAD, and whether the rows an entry references are still in HEAD, is for approval to
 * check.
 */
export function checkChangeSetDiff(diff: ChangeSetDiff, track: "structural" | "status"): string[] {
  const problems = new ProblemList();
  if (track === "status" && diff.length > 0) {
    problems.add("a status change set has an empty diff: its content is its status reports");
  }
  if (track === "structural" && diff.length === 0) {
    problems.add("a structural change set has at least one entry");
  }
  const removed = new Set(
    diff.filter((entry) => entry.op === "remove").map((e) => `${e.feature_type}:${e.id}`),
  );
  const seen = new Set<string>();
  diff.forEach((entry, i) => {
    const at = `[${i}]`;
    const key = `${entry.feature_type}:${entry.id}`;
    if (seen.has(key)) problems.add(`${at}: a second entry for ${entry.feature_type} ${entry.id}`);
    seen.add(key);
    if (entry.op === "modify" && jsonEqual(entry.before, entry.after)) {
      problems.add(`${at}: a modify whose after equals its before`);
    }
    checkRow(entry, "before", at, problems);
    checkRow(entry, "after", at, problems);
    if (entry.after !== null) {
      // Approval applies removes last, so the database's ON DELETE CASCADE or SET NULL would
      // undo this entry: HEAD would end up differing from the reviewed diff.
      const after = entry.after as unknown as Record<string, unknown>;
      for (const { column, feature_type } of DIFF_ROW_REFERENCES[entry.feature_type]) {
        const id = after[column];
        if (typeof id === "string" && removed.has(`${feature_type}:${id}`)) {
          problems.add(
            `${at}.after.${column}: references ${feature_type} ${id}, which the diff removes`,
          );
        }
      }
    }
  });
  return problems.messages;
}
