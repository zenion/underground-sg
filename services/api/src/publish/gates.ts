// The automated gates (CLAUDE.md, docs/spec.md "Crowdsourcing and moderation"): run on every
// publish path, the owner's included, and recorded in moderation_events as gates_passed or
// gates_failed before a publish path is set. The database refuses to set one without a
// gates_passed that no later gates_failed overrides, or while a linked capture has failed, isn't
// ready or is privacy-flagged (change_sets_guard); these checks report the problems first, with
// details, and record that they ran.
//
// - diff: the diff validates (validateChangeSetDiff). Every other gate reads it.
// - privacy: every linked capture has passed processing (the privacy re-check) and carries no
//   privacy flag. Not applicable to a manual edit, which has no captures and so no images.
// - restricted_zones: no space, node, edge or POI the change set leaves in HEAD overlaps the
//   interior of a restricted zone on its level (sharing an edge is fine); edges without a level are
//   checked against the levels of both their ends, as drawn (the stored line, or a straight one),
//   and a node without a level (a street exit) has no level whose zones apply.
//   The details name features and zones by id, never an outline (docs/decisions/0005).
// - alignment_residuals and street_priors: checks on captured segments (Phase 2). Not applicable
//   to a manual edit, and recorded as such rather than as passed. A change set with captures
//   fails them until the network adjustment records residuals and priors.
//
// A gate that had nothing to check is recorded as not_applicable, never as passed: the
// restricted-zone gate when the diff doesn't validate (only the diff gate failed) or leaves no public
// feature to check (a removal, a venue or level edit, an anchor).
//
// Gates run in a transaction of their own, before the publish, and their record is never rolled
// back with a publish that fails. The record says what was checked: the diff's SHA-256 (of the
// jsonb as Postgres prints it), the linked captures and the version map_head pointed at. The publish
// refuses a change set whose diff or captures have changed since (src/publish/publish.ts), and
// checks the restricted zones again against HEAD as it applies it, since HEAD and the zones may
// have moved on (src/publish/restricted-zones.ts).

import type { ChangeSetDiff, DiffEntry } from "@usg/contracts";
import { validateChangeSetDiff } from "@usg/contracts/validators";
import { type Kysely, sql } from "kysely";
import type { Database } from "../database.ts";
import { lineFromTo } from "./snapshot.ts";

export const GATES = [
  "diff",
  "privacy",
  "restricted_zones",
  "alignment_residuals",
  "street_priors",
] as const;

export type GateName = (typeof GATES)[number];

export type GateResult = "passed" | "failed" | "not_applicable";

/** One gate's outcome, as moderation_events.detail records it. */
export interface GateReport {
  readonly gate: GateName;
  readonly result: GateResult;
  readonly reason: string;
  /** What failed, by feature and zone id, capture id or diff path. */
  readonly problems?: readonly string[];
}

/** moderation_events.detail of a gates_passed or gates_failed event. */
export interface GatesDetail {
  readonly gates: readonly GateReport[];
  /** SHA-256 of the diff the gates checked (diffSha256Sql). */
  readonly diff_sha256: string;
  /** The captures linked to the change set when the gates ran, sorted. */
  readonly captures: readonly string[];
  /** The version map_head pointed at, or null before the first publish. */
  readonly head_version: number | null;
}

/**
 * SQL for the SHA-256 (hex) of a change set's diff: of the jsonb as Postgres prints it, which is
 * the same text for the same value, so the gates and the publish compare like with like.
 */
export function diffSha256Sql(column: string) {
  return sql<string>`encode(sha256(convert_to(${sql.ref(column)}::text, 'UTF8')), 'hex')`;
}

export interface GatesOutcome {
  readonly changeSetId: string;
  /** True when no gate failed: the event is gates_passed. */
  readonly passed: boolean;
  readonly gates: readonly GateReport[];
  /** moderation_events.id of the event recorded. */
  readonly eventId: string;
}

/** The gates can't run on this change set: it isn't there, isn't structural or isn't pending. */
export class GatesRefusedError extends Error {
  override name = "GatesRefusedError";
}

const MAX_PROBLEMS = 50;

function capped(problems: string[]): string[] {
  if (problems.length <= MAX_PROBLEMS) return problems;
  return [...problems.slice(0, MAX_PROBLEMS), `and ${problems.length - MAX_PROBLEMS} more`];
}

/**
 * Runs the gates on a pending structural change set and records the outcome in moderation_events
 * (actor NULL: automated), in a transaction of its own. Holds map_head FOR SHARE meanwhile, so no
 * publish changes HEAD under the checks.
 */
export async function runGates(db: Kysely<Database>, id: string): Promise<GatesOutcome> {
  const changeSetId = id.toLowerCase();
  if (db.isTransaction) {
    throw new Error(
      "runGates runs in a transaction of its own, so its record is never rolled back",
    );
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(changeSetId)) {
    throw new GatesRefusedError(`${JSON.stringify(id)} is not a change set id`);
  }
  return db.transaction().execute(async (trx) => {
    const head = await sql<{
      version_id: number | null;
    }>`SELECT version_id FROM map_head FOR SHARE`.execute(trx);
    const changeSet = await trx
      .selectFrom("change_sets")
      .select(["id", "track", "decision", "diff", diffSha256Sql("diff").as("diff_sha256")])
      .where("id", "=", changeSetId)
      .forUpdate()
      .executeTakeFirst();
    if (changeSet === undefined) throw new GatesRefusedError(`No change set ${changeSetId}`);
    if (changeSet.track !== "structural") {
      throw new GatesRefusedError(
        `Change set ${changeSetId} is a status change set: its gates come with the status overlay (Phase 4)`,
      );
    }
    if (changeSet.decision !== "pending") {
      throw new GatesRefusedError(
        `Change set ${changeSetId} is ${changeSet.decision}, not pending`,
      );
    }

    const captures = await trx
      .selectFrom("change_set_captures as csc")
      .innerJoin("captures as c", "c.id", "csc.capture_id")
      .select(["c.id", "c.status", "c.privacy_flagged"])
      .where("csc.change_set_id", "=", changeSetId)
      .orderBy("c.id")
      .execute();

    const validation = validateChangeSetDiff(changeSet.diff, "structural");
    const diff = validation.valid ? (changeSet.diff as ChangeSetDiff) : undefined;
    const gates: GateReport[] = [
      validation.valid
        ? { gate: "diff", result: "passed", reason: "the diff validates" }
        : {
            gate: "diff",
            result: "failed",
            reason: "the diff does not validate",
            problems: capped([...validation.problems]),
          },
      privacyGate(captures),
      diff === undefined
        ? {
            gate: "restricted_zones",
            result: "not_applicable",
            reason: "not run: the diff does not validate",
          }
        : await restrictedZonesGate(trx, diff),
      segmentGate("alignment_residuals", captures.length),
      segmentGate("street_priors", captures.length),
    ];
    const passed = gates.every((gate) => gate.result !== "failed");
    const detail: GatesDetail = {
      gates,
      diff_sha256: changeSet.diff_sha256,
      captures: captures.map((c) => c.id),
      head_version: head.rows[0]?.version_id ?? null,
    };
    const event = await trx
      .insertInto("moderation_events")
      .values({
        change_set_id: changeSetId,
        actor_id: null,
        action: passed ? "gates_passed" : "gates_failed",
        detail: JSON.stringify(detail),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { changeSetId, passed, gates, eventId: String(event.id) };
  });
}

function privacyGate(
  captures: readonly { id: string; status: string; privacy_flagged: boolean }[],
): GateReport {
  if (captures.length === 0) {
    return {
      gate: "privacy",
      result: "not_applicable",
      reason: "a manual edit: no captures, so no images to re-check",
    };
  }
  const problems: string[] = [];
  for (const c of captures) {
    if (c.privacy_flagged) problems.push(`capture ${c.id} is privacy-flagged`);
    if (c.status === "failed") problems.push(`capture ${c.id} failed processing`);
    else if (c.status !== "ready_for_review" && c.status !== "approved") {
      problems.push(`capture ${c.id} has not passed processing (status ${c.status})`);
    }
  }
  return problems.length === 0
    ? { gate: "privacy", result: "passed", reason: `${captures.length} captures re-checked` }
    : {
        gate: "privacy",
        result: "failed",
        reason: "a linked capture failed or is privacy-flagged",
        problems: capped(problems),
      };
}

function segmentGate(gate: "alignment_residuals" | "street_priors", captures: number): GateReport {
  if (captures === 0) {
    return {
      gate,
      result: "not_applicable",
      reason: "a manual edit: no captured segments to align",
    };
  }
  return {
    gate,
    result: "failed",
    reason:
      gate === "alignment_residuals"
        ? "not built yet (Phase 2): no residuals are recorded for captured segments"
        : "not built yet (Phase 2): street priors per connected group are not checked",
  };
}

// ---------------------------------------------------------------- restricted zones

interface NodeState {
  readonly level_id: string | null;
  /** GeoJSON text. */
  readonly geom: string;
}

/** One geometry to check against the zones of one level. */
interface Candidate {
  readonly feature: string;
  readonly level_id: string;
  /** A polygon or point, as GeoJSON text; null for an edge. */
  readonly geom: string | null;
  /** An edge's stored line (or null), and the points of its two ends. */
  readonly line: string | null;
  readonly from_geom: string | null;
  readonly to_geom: string | null;
}

async function restrictedZonesGate(db: Kysely<Database>, diff: ChangeSetDiff): Promise<GateReport> {
  const entries = new Map(diff.map((e) => [`${e.feature_type}:${e.id}`, e]));
  const kept = diff.filter((e): e is Exclude<DiffEntry, { op: "remove" }> => e.op !== "remove");

  // Nodes as the change set leaves them: its adds and modifies over HEAD.
  const nodes = new Map<string, NodeState | null>();
  for (const e of diff) {
    if (e.feature_type !== "node") continue;
    nodes.set(e.id, e.after === null ? null : { ...e.after, geom: JSON.stringify(e.after.geom) });
  }
  // HEAD edges that the diff doesn't name but whose ends it moves: their drawn line moves too.
  const movedNodes = kept.filter((e) => e.feature_type === "node" && e.op === "modify");
  const movedIds = movedNodes.map((e) => e.id);
  const headEdges =
    movedIds.length === 0
      ? []
      : (
          await sql<{
            id: string;
            from_node: string;
            to_node: string;
            level_id: string | null;
            geom: string | null;
          }>`SELECT id, from_node, to_node, level_id, ST_AsGeoJSON(geom) AS geom
               FROM edges
              WHERE from_node = ANY(${movedIds}::uuid[]) OR to_node = ANY(${movedIds}::uuid[])
              ORDER BY id`.execute(db)
        ).rows.filter((edge) => !entries.has(`edge:${edge.id}`));

  type EdgeLike = {
    feature: string;
    from_node: string;
    to_node: string;
    level_id: string | null;
    line: string | null;
  };
  const edges: EdgeLike[] = [
    ...kept.flatMap((e) =>
      e.feature_type === "edge"
        ? [
            {
              feature: `edge ${e.id}`,
              from_node: e.after.from_node,
              to_node: e.after.to_node,
              level_id: e.after.level_id,
              line: e.after.geom === null ? null : JSON.stringify(e.after.geom),
            },
          ]
        : [],
    ),
    ...headEdges.map((edge) => ({
      feature: `edge ${edge.id} (its end moves)`,
      from_node: edge.from_node,
      to_node: edge.to_node,
      level_id: edge.level_id,
      line: edge.geom,
    })),
  ];

  // The ends of those edges that the diff doesn't add or modify, from HEAD.
  const missing = [
    ...new Set(edges.flatMap((e) => [e.from_node, e.to_node]).filter((id) => !nodes.has(id))),
  ];
  if (missing.length > 0) {
    const rows = await sql<{ id: string; level_id: string | null; geom: string }>`
      SELECT id, level_id, ST_AsGeoJSON(geom) AS geom FROM nodes WHERE id = ANY(${missing}::uuid[])`.execute(
      db,
    );
    for (const row of rows.rows) nodes.set(row.id, { level_id: row.level_id, geom: row.geom });
  }

  const candidates: Candidate[] = [];
  const point = (feature: string, level: string | null, geom: object) => {
    if (level !== null) {
      candidates.push({
        feature,
        level_id: level,
        geom: JSON.stringify(geom),
        line: null,
        from_geom: null,
        to_geom: null,
      });
    }
  };
  for (const e of kept) {
    if (e.feature_type === "space") point(`space ${e.id}`, e.after.level_id, e.after.geom);
    if (e.feature_type === "node") point(`node ${e.id}`, e.after.level_id, e.after.geom);
    if (e.feature_type === "poi") point(`poi ${e.id}`, e.after.level_id, e.after.geom);
  }
  for (const edge of edges) {
    const from = nodes.get(edge.from_node);
    const to = nodes.get(edge.to_node);
    // An end that is gone fails the rebase check instead; nothing to draw here.
    if (from === undefined || from === null || to === undefined || to === null) continue;
    const levels =
      edge.level_id !== null
        ? [edge.level_id]
        : [...new Set([from.level_id, to.level_id].filter((l): l is string => l !== null))];
    for (const level of levels) {
      candidates.push({
        feature: edge.feature,
        level_id: level,
        geom: null,
        line: edge.line,
        from_geom: from.geom,
        to_geom: to.geom,
      });
    }
  }
  if (candidates.length === 0) {
    return {
      gate: "restricted_zones",
      result: "not_applicable",
      reason: "no public features in the change set",
    };
  }
  const overlaps = await sql<{ feature: string; level_id: string; zone_id: string }>`
    WITH raw AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(candidates)}::jsonb)
        AS r(feature text, level_id uuid, geom text, line text, from_geom text, to_geom text)
    ), g AS (
      SELECT feature, level_id,
             ST_SetSRID(ST_GeomFromGeoJSON(geom), 4326) AS geom,
             ST_SetSRID(ST_GeomFromGeoJSON(line), 4326) AS line,
             ST_SetSRID(ST_GeomFromGeoJSON(from_geom), 4326) AS from_geom,
             ST_SetSRID(ST_GeomFromGeoJSON(to_geom), 4326) AS to_geom
        FROM raw
    ), c AS (
      SELECT feature, level_id,
             CASE WHEN from_geom IS NULL THEN geom
                  ELSE ${lineFromTo("line", "from_geom", "to_geom")} END AS geom
        FROM g
    )
    SELECT DISTINCT c.feature, c.level_id, rz.id AS zone_id
      FROM c
      JOIN levels l ON l.id = c.level_id
      JOIN restricted_zones rz
        ON rz.venue_id = l.venue_id AND (rz.level_id IS NULL OR rz.level_id = c.level_id)
     WHERE rz.geom && c.geom AND ST_Relate(c.geom, rz.geom, 'T********')
     ORDER BY 1, 2, 3`.execute(db);

  const checked = new Set(candidates.map((c) => c.feature)).size;
  if (overlaps.rows.length === 0) {
    return {
      gate: "restricted_zones",
      result: "passed",
      reason: `${checked} features checked; none overlaps a restricted zone`,
    };
  }
  return {
    gate: "restricted_zones",
    result: "failed",
    reason: "a feature overlaps the interior of a restricted zone",
    problems: capped(
      overlaps.rows.map(
        (o) => `${o.feature} overlaps restricted zone ${o.zone_id} on level ${o.level_id}`,
      ),
    ),
  };
}
