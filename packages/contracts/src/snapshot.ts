// The public map files (docs/snapshot-format.md): constants, paths, and the checks the schemas
// can't express. Environment-neutral: the webapp, the mapper app (Hermes) and the server import
// it. Hashing needs node:crypto or Web Crypto, so it is left to the caller.

import type {
  IndoorFeature,
  IndoorSnapshot,
  LatestPointer,
  Position,
  StatusOverlay,
  StreetSnapshot,
} from "./generated/contracts.ts";
import { checkGeometry, NEVER_STEP_FREE_EDGE_KINDS, ProblemList } from "./map.ts";
import { SCHEMA_BASE_URL } from "./schema-ids.ts";

/** Base of the snapshot schemas' `$id`s. */
export const SNAPSHOT_SCHEMA_BASE_URL = `${SCHEMA_BASE_URL}snapshot/`;

/** The snapshot format version this package describes (`schema_version` in every public file). */
export const SNAPSHOT_SCHEMA_VERSION = 1;

/** The schema file for each public file. */
export const SNAPSHOT_SCHEMA_FILES = {
  "latest.json": "latest.schema.json",
  "indoor.json": "indoor.schema.json",
  "street.json": "street.schema.json",
  "status.json": "status.schema.json",
} as const;

/** A public file that has a schema. */
export type SnapshotFileName = keyof typeof SNAPSHOT_SCHEMA_FILES;

/** The files of a version, in the order `snapshot_sha256` hashes them. */
export const VERSION_FILES = ["indoor.json", "street.json"] as const;

/** A file of a version. */
export type VersionFileName = (typeof VERSION_FILES)[number];

/** The directory, under the root of the public files, that holds every version's directory. */
export const SNAPSHOTS_DIRECTORY = "snapshots";

/** `Cache-Control` for each kind of public file. */
export const CACHE_CONTROL = {
  /** indoor.json and street.json under a version's directory: never change. */
  version: "public, max-age=31536000, immutable",
  /** latest.json: rewritten on every publish. */
  latest: "public, max-age=60",
  /** status.json: rewritten whenever the overlay changes. */
  status: "public, max-age=60",
} as const;

/**
 * A version's directory relative to the root of the public files, `snapshots/<sha256>/`: the
 * value of `map_versions.snapshot_uri`.
 */
export function snapshotDirectory(snapshotSha256: string): string {
  return `${SNAPSHOTS_DIRECTORY}/${snapshotSha256}/`;
}

/** A version file's path relative to the root of the public files. */
export function snapshotFilePath(snapshotSha256: string, file: VersionFileName): string {
  return `${snapshotDirectory(snapshotSha256)}${file}`;
}

/**
 * The text whose SHA-256 is `snapshot_sha256`: one line per version file in `VERSION_FILES`
 * order, in `sha256sum`'s text-mode format (hex digest, two spaces, file name, LF). The digests are
 * of the files as decoded, so `sha256sum --text indoor.json street.json | sha256sum` gives the same
 * hash. (`--text` matters on Windows: Git Bash's sha256sum defaults to binary mode, which writes
 * `*` before the file name instead of the second space.)
 */
export function snapshotDigestInput(digests: Readonly<Record<VersionFileName, string>>): string {
  return VERSION_FILES.map((file) => `${digests[file]}  ${file}\n`).join("");
}

/**
 * The namespace of street connectors' ids in indoor.json. A connector's id is the UUIDv5 (RFC 9562)
 * of its node's id, as lowercase text, in this namespace: an exit or entrance has at most one
 * connector, so the id stays the same from version to version while the node exists, and the same
 * HEAD and street graph always give the same bytes. `streetConnectorId` in
 * `@usg/contracts/validators` computes it (UUIDv5 needs SHA-1).
 */
export const STREET_CONNECTOR_ID_NAMESPACE = "1ffdedde-dd2f-4f6d-a18a-800669a179e1";

/** indoor.json's feature types, in the order its features are sorted. */
export const INDOOR_FEATURE_TYPES = [
  "venue",
  "level",
  "space",
  "node",
  "edge",
  "poi",
  "street_connector",
] as const satisfies readonly IndoorFeature["properties"]["feature_type"][];

/** A feature type of indoor.json. */
export type IndoorFeatureType = (typeof INDOOR_FEATURE_TYPES)[number];

/** The indoor.json feature of one type. */
export type IndoorFeatureOf<T extends IndoorFeatureType> = Extract<
  IndoorFeature,
  { properties: { feature_type: T } }
>;

/**
 * Whether `feature` is of `type`. TypeScript doesn't narrow a union on a nested property such as
 * `feature.properties.feature_type`, so use this.
 */
export function isIndoorFeature<T extends IndoorFeatureType>(
  feature: IndoorFeature,
  type: T,
): feature is IndoorFeatureOf<T> {
  return feature.properties.feature_type === type;
}

const INDOOR_TYPE_RANK = new Map<string, number>(INDOOR_FEATURE_TYPES.map((type, i) => [type, i]));

function samePosition(a: Position | undefined, b: Position): boolean {
  return a !== undefined && a[0] === b[0] && a[1] === b[1];
}

/** One end of a line: what it should touch, and where that is. */
interface LineEnd {
  readonly name: string;
  readonly position: Position;
}

/**
 * Checks that a line runs from `from` to `to`: its first position is exactly `from`'s and its
 * last exactly `to`'s (both written with the same 7-decimal rounding). `undefined` skips that end.
 */
function checkLineEnds(
  line: readonly Position[],
  from: LineEnd | undefined,
  to: LineEnd | undefined,
  at: string,
  problems: ProblemList,
): void {
  if (from !== undefined && !samePosition(line[0], from.position)) {
    problems.add(`${at}: the line does not start at ${from.name}'s position`);
  }
  if (to !== undefined && !samePosition(line[line.length - 1], to.position)) {
    problems.add(`${at}: the line does not end at ${to.name}'s position`);
  }
}

/**
 * Checks a schema-valid indoor.json for what its schema can't: coordinates, unique ids that equal
 * properties.id, references that resolve within the file, ordinals that match their levels and
 * nodes, the database rules on edges, lines that run from their start node to their end node, at
 * most one street connector per node, and the feature order. Returns the problems; none means
 * valid. Street connectors' ids need SHA-1, so `validateSnapshotFile` in
 * `@usg/contracts/validators` checks them.
 */
export function checkIndoorSnapshot(snapshot: IndoorSnapshot): string[] {
  const problems = new ProblemList();
  const ids = new Set<string>();
  const venues = new Set<string>();
  const levelOrdinals = new Map<string, number>();
  const spaces = new Set<string>();
  const nodes = new Map<string, { ordinal: number; kind: string; position: Position }>();
  const connectedNodes = new Set<string>();
  for (const feature of snapshot.features) {
    const p = feature.properties;
    if (p.feature_type === "venue") venues.add(feature.id);
    if (p.feature_type === "level") levelOrdinals.set(feature.id, p.ordinal);
    if (p.feature_type === "space") spaces.add(feature.id);
    if (isIndoorFeature(feature, "node")) {
      nodes.set(feature.id, {
        ordinal: feature.properties.ordinal,
        kind: feature.properties.kind,
        position: feature.geometry.coordinates,
      });
    }
  }
  const nodeEnd = (name: string, nodeId: string): LineEnd | undefined => {
    const node = nodes.get(nodeId);
    return node === undefined ? undefined : { name, position: node.position };
  };

  const levelBand = (at: string, levelId: string, ordinal: number, what: string) => {
    const band = levelOrdinals.get(levelId);
    if (band === undefined) problems.add(`${at}: ${what} ${levelId} is not a level in the file`);
    else if (band !== ordinal)
      problems.add(`${at}: ordinal ${ordinal} differs from its level's ${band}`);
  };
  const nodeBand = (at: string, nodeId: string, ordinal: number, what: string) => {
    const node = nodes.get(nodeId);
    if (node === undefined) problems.add(`${at}: ${what} ${nodeId} is not a node in the file`);
    else if (node.ordinal !== ordinal) {
      problems.add(`${at}: ${what}'s ordinal is ${node.ordinal}, not ${ordinal}`);
    }
    return node;
  };

  let previous: IndoorFeature | undefined;
  snapshot.features.forEach((feature, i) => {
    const at = `features[${i}]`;
    const p = feature.properties;
    if (ids.has(feature.id)) problems.add(`${at}: id ${feature.id} is not unique`);
    ids.add(feature.id);
    if (p.id !== feature.id) problems.add(`${at}: properties.id differs from the feature's id`);
    checkGeometry(feature.geometry, `${at}.geometry`, problems);

    switch (p.feature_type) {
      case "level":
        if (!venues.has(p.venue_id))
          problems.add(`${at}: venue_id ${p.venue_id} is not a venue in the file`);
        break;
      case "space":
        levelBand(at, p.level_id, p.ordinal, "level_id");
        break;
      case "node":
        if (p.level_id === null) {
          if (p.ordinal !== 0) problems.add(`${at}: a node without a level has ordinal 0`);
        } else {
          levelBand(at, p.level_id, p.ordinal, "level_id");
        }
        break;
      case "edge":
        nodeBand(at, p.from_node, p.from_ordinal, "from_node");
        nodeBand(at, p.to_node, p.to_ordinal, "to_node");
        if (isIndoorFeature(feature, "edge")) {
          checkLineEnds(
            feature.geometry.coordinates,
            nodeEnd("from_node", p.from_node),
            nodeEnd("to_node", p.to_node),
            `${at}.geometry`,
            problems,
          );
        }
        if (p.from_node === p.to_node)
          problems.add(`${at}: from_node and to_node are the same node`);
        if (p.level_id !== null && !levelOrdinals.has(p.level_id)) {
          problems.add(`${at}: level_id ${p.level_id} is not a level in the file`);
        }
        if (p.step_free && (NEVER_STEP_FREE_EDGE_KINDS as readonly string[]).includes(p.kind)) {
          problems.add(`${at}: ${p.kind} edges are never step_free`);
        }
        break;
      case "poi":
        levelBand(at, p.level_id, p.ordinal, "level_id");
        if (p.space_id !== null && !spaces.has(p.space_id)) {
          problems.add(`${at}: space_id ${p.space_id} is not a space in the file`);
        }
        break;
      case "street_connector": {
        const node = nodeBand(at, p.node_id, p.ordinal, "node_id");
        if (node !== undefined && node.kind !== "exit" && node.kind !== "entrance") {
          problems.add(
            `${at}: a street connector starts at an exit or entrance, not a ${node.kind}`,
          );
        }
        if (connectedNodes.has(p.node_id)) {
          problems.add(`${at}: a second street connector for node ${p.node_id}`);
        }
        connectedNodes.add(p.node_id);
        if (isIndoorFeature(feature, "street_connector")) {
          checkLineEnds(
            feature.geometry.coordinates,
            nodeEnd("node_id", p.node_id),
            undefined,
            `${at}.geometry`,
            problems,
          );
        }
        break;
      }
    }

    if (previous !== undefined) {
      const rank = INDOOR_TYPE_RANK.get(p.feature_type) ?? 0;
      const previousRank = INDOOR_TYPE_RANK.get(previous.properties.feature_type) ?? 0;
      if (rank < previousRank || (rank === previousRank && feature.id <= previous.id)) {
        problems.add(`${at}: features are not sorted by type, then id`);
      }
    }
    previous = feature;
  });
  return problems.messages;
}

/**
 * Checks a schema-valid street.json for what its schema can't: coordinates, unique node ids,
 * edges whose ends are nodes in the file and whose lines run from from_osm_node to to_osm_node,
 * and the feature order (nodes by id, then edges by osm_way_id, from_osm_node and to_osm_node).
 * Returns the problems; none means valid.
 */
export function checkStreetSnapshot(snapshot: StreetSnapshot): string[] {
  const problems = new ProblemList();
  const nodes = new Map<number, Position>();
  for (const feature of snapshot.features) {
    if ("id" in feature) nodes.set(feature.id, feature.geometry.coordinates);
  }
  const nodeEnd = (name: string, osmNodeId: number): LineEnd | undefined => {
    const position = nodes.get(osmNodeId);
    return position === undefined ? undefined : { name, position };
  };
  const seen = new Set<number>();
  let previousKey: number[] | undefined;
  snapshot.features.forEach((feature, i) => {
    const at = `features[${i}]`;
    checkGeometry(feature.geometry, `${at}.geometry`, problems);
    let key: number[];
    if ("id" in feature) {
      if (seen.has(feature.id)) problems.add(`${at}: street node ${feature.id} is not unique`);
      seen.add(feature.id);
      key = [0, feature.id];
    } else {
      const p = feature.properties;
      for (const end of [p.from_osm_node, p.to_osm_node]) {
        if (!nodes.has(end)) problems.add(`${at}: ${end} is not a street node in the file`);
      }
      if (p.from_osm_node === p.to_osm_node)
        problems.add(`${at}: the edge starts and ends at one node`);
      checkLineEnds(
        feature.geometry.coordinates,
        nodeEnd("from_osm_node", p.from_osm_node),
        nodeEnd("to_osm_node", p.to_osm_node),
        `${at}.geometry`,
        problems,
      );
      key = [1, p.osm_way_id, p.from_osm_node, p.to_osm_node];
    }
    if (previousKey !== undefined && compareKeys(key, previousKey) <= 0) {
      problems.add(`${at}: features are not sorted (nodes by id, then edges by way and nodes)`);
    }
    previousKey = key;
  });
  return problems.messages;
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? -1) - (b[i] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Checks what neither version file can alone: every street connector in indoor.json ends at a
 * street node in street.json, exactly at its position. Both files must already be valid. Returns
 * the problems; none means valid.
 */
export function checkStreetConnectors(indoor: IndoorSnapshot, street: StreetSnapshot): string[] {
  const problems = new ProblemList();
  const streetNodes = new Map<number, Position>();
  for (const feature of street.features) {
    if ("id" in feature) streetNodes.set(feature.id, feature.geometry.coordinates);
  }
  indoor.features.forEach((feature, i) => {
    if (!isIndoorFeature(feature, "street_connector")) return;
    const osmNodeId = feature.properties.osm_node_id;
    const position = streetNodes.get(osmNodeId);
    if (position === undefined) {
      problems.add(`features[${i}]: osm_node_id ${osmNodeId} is not a street node in street.json`);
      return;
    }
    checkLineEnds(
      feature.geometry.coordinates,
      undefined,
      { name: `street node ${osmNodeId}`, position },
      `features[${i}].geometry`,
      problems,
    );
  });
  return problems.messages;
}

/**
 * Checks a schema-valid latest.json for what its schema can't: each file's path is its own name
 * under the version's directory. Checking `snapshot_sha256` against the files' digests needs a
 * hash function: `@usg/contracts/validators` does it. Returns the problems; none means valid.
 */
export function checkLatestPointer(latest: LatestPointer): string[] {
  const problems = new ProblemList();
  const expected = {
    indoor: snapshotFilePath(latest.snapshot_sha256, "indoor.json"),
    street: snapshotFilePath(latest.snapshot_sha256, "street.json"),
  };
  for (const key of ["indoor", "street"] as const) {
    if (latest.files[key].path !== expected[key]) {
      problems.add(`files.${key}.path: expected ${expected[key]}`);
    }
  }
  return problems.messages;
}

/**
 * Checks a schema-valid status.json for what its schema can't: at most one entry per feature,
 * and each entry's window covers `generated_at`. Returns the problems; none means valid.
 */
export function checkStatusOverlay(overlay: StatusOverlay): string[] {
  const problems = new ProblemList();
  const generatedAt = Date.parse(overlay.generated_at);
  const seen = new Set<string>();
  overlay.entries.forEach((entry, i) => {
    const at = `entries[${i}]`;
    const key = `${entry.feature_type}:${entry.feature_id}`;
    if (seen.has(key))
      problems.add(`${at}: a second entry for ${entry.feature_type} ${entry.feature_id}`);
    seen.add(key);
    const from = Date.parse(entry.valid_from);
    const until =
      entry.valid_until === null ? Number.POSITIVE_INFINITY : Date.parse(entry.valid_until);
    if (until <= from) problems.add(`${at}: valid_until is not later than valid_from`);
    if (from > generatedAt || until <= generatedAt) {
      problems.add(`${at}: its validity window does not cover generated_at`);
    }
  });
  return problems.messages;
}
