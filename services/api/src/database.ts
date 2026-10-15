// Kysely over node-postgres, with the tables of db/schema.sql as types. Geometry crosses the
// boundary as GeoJSON text through raw SQL (CLAUDE.md, docs/decisions/0006): select it with
// sql`ST_AsGeoJSON(geom, 7)` and write it with sql`ST_GeomFromGeoJSON(${json})`; a geometry column
// selected directly is hex EWKB, which nothing here reads.

import type {
  EdgeAccess,
  EdgeKind,
  NodeKind,
  PoiCategory,
  SpaceKind,
  StreetPriorSource,
  VenueKind,
} from "@usg/contracts";
import { type ColumnType, type Generated, Kysely, PostgresDialect } from "kysely";
import pg from "pg";

/** A geometry column: hex EWKB when selected as is. Use ST_AsGeoJSON and ST_GeomFromGeoJSON. */
export type Geometry = ColumnType<string, string, string>;
/** A timestamptz column: node-postgres reads it as a Date. */
export type Timestamp = ColumnType<Date, Date | string, Date | string>;
/** A timestamptz column with a default (now()). */
export type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
/** A bigint or bigserial column: node-postgres reads int8 as a string, since it may exceed 2^53. */
export type Int8 = ColumnType<string, string | number | bigint, string | number | bigint>;
/** A jsonb column: write JSON text (node-postgres would turn an array into a Postgres array). */
export type Jsonb = ColumnType<unknown, string, string>;

export type TrustTier = "new" | "trusted" | "moderator" | "owner";
export type AnchorKind = "floor_point" | "image_anchor";
export type CaptureStatus =
  | "uploading"
  | "uploaded"
  | "processing"
  | "failed"
  | "ready_for_review"
  | "approved"
  | "rejected";
export type ChangeTrack = "structural" | "status";
export type ChangeDecision =
  | "pending"
  | "approved"
  | "rejected"
  | "auto_published"
  | "rolled_back"
  | "needs_rebase";
export type PublishPath = "moderator_review" | "owner_mapper" | "trusted_status_auto";

export interface ContributorsTable {
  id: Generated<string>;
  display_name: string;
  trust_tier: Generated<TrustTier>;
  accepted_count: Generated<number>;
  rejected_count: Generated<number>;
  created_at: DefaultTimestamp;
}

export interface VenuesTable {
  id: Generated<string>;
  name: string;
  kind: VenueKind;
  operator: string | null;
  permission: string | null;
  footprint: Geometry | null;
  updated_at: DefaultTimestamp;
  rev: Generated<number>;
}

export interface LevelsTable {
  id: Generated<string>;
  venue_id: string;
  ordinal: number;
  name: string;
  elevation_m: number | null;
  sort_key: Generated<number>;
  rev: Generated<number>;
}

export interface SpacesTable {
  id: Generated<string>;
  level_id: string;
  kind: SpaceKind;
  name: string | null;
  geom: Geometry;
  rev: Generated<number>;
}

export interface NodesTable {
  id: Generated<string>;
  level_id: string | null;
  /** Kept in step with the level's by a trigger. */
  ordinal: Generated<number>;
  kind: NodeKind;
  name: string | null;
  street_name: string | null;
  connector_id: string | null;
  elevation_m: number | null;
  geom: Geometry;
  rev: Generated<number>;
}

export interface EdgesTable {
  id: Generated<string>;
  from_node: string;
  to_node: string;
  kind: EdgeKind;
  oneway: Generated<boolean>;
  access: Generated<EdgeAccess>;
  opening_hours: string | null;
  level_id: string | null;
  connector_id: string | null;
  length_m: number;
  step_free: boolean;
  sheltered: boolean;
  outdoor: boolean;
  geom: Geometry | null;
  rev: Generated<number>;
}

export interface AnchorsTable {
  id: Generated<string>;
  node_id: string | null;
  kind: AnchorKind;
  name: string;
  level_id: string | null;
  /** Kept in step with the level's by a trigger. */
  ordinal: Generated<number>;
  facing_deg: number | null;
  surveyed_geom: Geometry | null;
  prior_source: StreetPriorSource | null;
  prior_sigma_m: number | null;
  photo_uri: string | null;
  created_at: DefaultTimestamp;
  rev: Generated<number>;
}

export interface PoisTable {
  id: Generated<string>;
  space_id: string | null;
  level_id: string;
  name: string;
  category: PoiCategory;
  geom: Geometry;
  rev: Generated<number>;
}

export interface RestrictedZonesTable {
  id: Generated<string>;
  venue_id: string;
  level_id: string | null;
  geom: Geometry;
  note: string | null;
}

export interface StreetNodesTable {
  osm_node_id: Int8;
  geom: Geometry;
}

export interface StreetEdgesTable {
  id: Generated<string>;
  osm_way_id: Int8;
  from_osm_node: Int8;
  to_osm_node: Int8;
  tags: ColumnType<unknown, string | undefined, string>;
  covered: Generated<boolean>;
  length_m: number;
  geom: Geometry;
  imported_at: DefaultTimestamp;
}

export interface StreetConnectorsTable {
  node_id: string;
  osm_node_id: Int8;
  length_m: number;
  geom: Geometry;
}

export interface CapturesTable {
  id: string;
  contributor_id: string;
  start_anchor_id: string | null;
  end_anchor_id: string | null;
  bundle_uri: string | null;
  status: Generated<CaptureStatus>;
  device_model: string | null;
  os_version: string | null;
  app_version: string | null;
  drift_m: number | null;
  failure_reason: string | null;
  privacy_flagged: Generated<boolean>;
  quarantined_frames: Generated<number[]>;
  captured_at: Timestamp;
  uploaded_at: Timestamp | null;
}

export interface SegmentAlignmentsTable {
  id: Generated<string>;
  capture_id: string;
  solve_id: string;
  tx_m: number;
  ty_m: number;
  tz_m: number;
  yaw_rad: number;
  start_residual_m: number | null;
  end_residual_m: number | null;
  solved_at: DefaultTimestamp;
}

export interface MapVersionsTable {
  id: Generated<number>;
  published_at: DefaultTimestamp;
  published_by: string | null;
  snapshot_uri: string;
  snapshot_sha256: string;
  private_export_uri: string;
  restores: number | null;
  note: string | null;
}

export interface MapHeadTable {
  id: Generated<boolean>;
  version_id: number | null;
}

export interface ChangeSetsTable {
  id: Generated<string>;
  contributor_id: string;
  track: ChangeTrack;
  base_version_id: number | null;
  diff: Jsonb;
  note: string | null;
  decision: Generated<ChangeDecision>;
  publish_path: PublishPath | null;
  reviewer_id: string | null;
  reviewed_at: Timestamp | null;
  map_version_id: number | null;
  created_at: DefaultTimestamp;
}

export interface ChangeSetCapturesTable {
  change_set_id: string;
  capture_id: string;
}

export interface ModerationEventsTable {
  id: ColumnType<string, string | number | bigint | undefined, never>;
  change_set_id: string;
  actor_id: string | null;
  action: string;
  detail: ColumnType<unknown, string | undefined, string>;
  at: DefaultTimestamp;
}

export interface StatusReportsTable {
  id: Generated<string>;
  feature_type: "node" | "edge";
  feature_id: string;
  is_open: boolean;
  note: string | null;
  evidence_uri: string | null;
  valid_from: Timestamp;
  valid_until: Timestamp | null;
  change_set_id: string;
  track: Generated<"status">;
  created_at: DefaultTimestamp;
}

/** Every table in db/schema.sql (dbmate's schema_migrations aside). */
export interface Database {
  contributors: ContributorsTable;
  venues: VenuesTable;
  levels: LevelsTable;
  spaces: SpacesTable;
  nodes: NodesTable;
  edges: EdgesTable;
  anchors: AnchorsTable;
  pois: PoisTable;
  restricted_zones: RestrictedZonesTable;
  street_nodes: StreetNodesTable;
  street_edges: StreetEdgesTable;
  street_connectors: StreetConnectorsTable;
  captures: CapturesTable;
  segment_alignments: SegmentAlignmentsTable;
  map_versions: MapVersionsTable;
  map_head: MapHeadTable;
  change_sets: ChangeSetsTable;
  change_set_captures: ChangeSetCapturesTable;
  moderation_events: ModerationEventsTable;
  status_reports: StatusReportsTable;
}

/**
 * The columns of each table in db/schema.sql order, so a test can compare them with the generated
 * schema. The type below fails to compile if a table's list leaves out a column of its interface.
 */
export const TABLE_COLUMNS = {
  contributors: [
    "id",
    "display_name",
    "trust_tier",
    "accepted_count",
    "rejected_count",
    "created_at",
  ],
  venues: ["id", "name", "kind", "operator", "permission", "footprint", "updated_at", "rev"],
  levels: ["id", "venue_id", "ordinal", "name", "elevation_m", "sort_key", "rev"],
  spaces: ["id", "level_id", "kind", "name", "geom", "rev"],
  nodes: [
    "id",
    "level_id",
    "ordinal",
    "kind",
    "name",
    "street_name",
    "connector_id",
    "elevation_m",
    "geom",
    "rev",
  ],
  edges: [
    "id",
    "from_node",
    "to_node",
    "kind",
    "oneway",
    "access",
    "opening_hours",
    "level_id",
    "connector_id",
    "length_m",
    "step_free",
    "sheltered",
    "outdoor",
    "geom",
    "rev",
  ],
  anchors: [
    "id",
    "node_id",
    "kind",
    "name",
    "level_id",
    "ordinal",
    "facing_deg",
    "surveyed_geom",
    "prior_source",
    "prior_sigma_m",
    "photo_uri",
    "created_at",
    "rev",
  ],
  pois: ["id", "space_id", "level_id", "name", "category", "geom", "rev"],
  restricted_zones: ["id", "venue_id", "level_id", "geom", "note"],
  street_nodes: ["osm_node_id", "geom"],
  street_edges: [
    "id",
    "osm_way_id",
    "from_osm_node",
    "to_osm_node",
    "tags",
    "covered",
    "length_m",
    "geom",
    "imported_at",
  ],
  street_connectors: ["node_id", "osm_node_id", "length_m", "geom"],
  captures: [
    "id",
    "contributor_id",
    "start_anchor_id",
    "end_anchor_id",
    "bundle_uri",
    "status",
    "device_model",
    "os_version",
    "app_version",
    "drift_m",
    "failure_reason",
    "privacy_flagged",
    "quarantined_frames",
    "captured_at",
    "uploaded_at",
  ],
  segment_alignments: [
    "id",
    "capture_id",
    "solve_id",
    "tx_m",
    "ty_m",
    "tz_m",
    "yaw_rad",
    "start_residual_m",
    "end_residual_m",
    "solved_at",
  ],
  map_versions: [
    "id",
    "published_at",
    "published_by",
    "snapshot_uri",
    "snapshot_sha256",
    "private_export_uri",
    "restores",
    "note",
  ],
  map_head: ["id", "version_id"],
  change_sets: [
    "id",
    "contributor_id",
    "track",
    "base_version_id",
    "diff",
    "note",
    "decision",
    "publish_path",
    "reviewer_id",
    "reviewed_at",
    "map_version_id",
    "created_at",
  ],
  change_set_captures: ["change_set_id", "capture_id"],
  moderation_events: ["id", "change_set_id", "actor_id", "action", "detail", "at"],
  status_reports: [
    "id",
    "feature_type",
    "feature_id",
    "is_open",
    "note",
    "evidence_uri",
    "valid_from",
    "valid_until",
    "change_set_id",
    "track",
    "created_at",
  ],
} as const satisfies { [T in keyof Database]: readonly (keyof Database[T] & string)[] };

type UnlistedColumns = {
  [T in keyof Database]: Exclude<keyof Database[T], (typeof TABLE_COLUMNS)[T][number]>;
}[keyof Database];
/** Compiles only while every interface column is listed in TABLE_COLUMNS. */
export const EVERY_COLUMN_LISTED: [UnlistedColumns] extends [never] ? true : never = true;

export interface DatabaseOptions {
  /** Most connections the pool opens. */
  readonly maxConnections?: number;
}

/**
 * A Kysely instance on a new node-postgres pool. Nothing connects until the first query; call
 * `destroy()` to close the pool.
 */
export function createDatabase(url: string, options: DatabaseOptions = {}): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: "usg-api",
  });
  // An idle client's error (the server restarted, say) would otherwise crash the process; the
  // pool drops the client, and the next query opens a new one.
  pool.on("error", () => {});
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
