import { describe, expect, test } from "vitest";
import {
  checkStreetConnectors,
  hasAtMostDecimals,
  type IndoorSnapshot,
  isIndoorFeature,
  type LatestPointer,
  SNAPSHOT_SCHEMA_FILES,
  type SnapshotFileName,
  type StatusOverlay,
  type StreetSnapshot,
  snapshotDigestInput,
  snapshotDirectory,
  snapshotFilePath,
} from "../src/index.ts";
import {
  sha256Hex,
  snapshotSha256,
  streetConnectorId,
  uuidV5,
  validateSnapshotFile,
  validateVersion,
  verifyLatestPointer,
} from "../src/validators.ts";
import * as examples from "./map-examples.ts";
import { readSchema, walkSchema } from "./schemas.ts";

/** Returns a deep copy of `value` changed by `change`. */
function variant<T>(value: T, change: (copy: T) => void): T {
  const copy = structuredClone(value);
  change(copy);
  return copy;
}

/** Index of the first indoor feature of a type in the example. */
function indexOf(type: string, snapshot: IndoorSnapshot = examples.indoor): number {
  const i = snapshot.features.findIndex((f) => f.properties.feature_type === type);
  if (i < 0) throw new Error(`no ${type} in the example`);
  return i;
}

/** A feature as loosely typed JSON, for making invalid variants. */
// biome-ignore lint/suspicious/noExplicitAny: an invalid variant may write anything anywhere
type LooseFeature = Record<string, any>;

/** Changes the first indoor feature of a type, loosely typed, in a copy of the example. */
function indoorVariant(type: string, change: (feature: LooseFeature) => void) {
  return variant(examples.indoor, (copy) => {
    change(copy.features[indexOf(type, copy)] as unknown as LooseFeature);
  });
}

const VALID: Record<string, [SnapshotFileName, unknown]> = {
  "doc indoor.json": ["indoor.json", examples.indoor],
  "an empty indoor.json": ["indoor.json", { ...examples.indoor, features: [] }],
  "doc street.json": ["street.json", examples.street],
  "doc latest.json": ["latest.json", examples.latest],
  "latest.json of a demo map": ["latest.json", { ...examples.latest, demo: true }],
  "doc status.json": ["status.json", examples.status],
  "an empty status.json": ["status.json", { ...examples.status, entries: [] }],
  "a venue footprint with a hole": [
    "indoor.json",
    indoorVariant("venue", (f) => {
      f["geometry"].coordinates[0].push([
        [103.8498, 1.2912],
        [103.8498, 1.2914],
        [103.85, 1.2914],
        [103.85, 1.2912],
        [103.8498, 1.2912],
      ]);
    }),
  ],
  "coordinates with exactly 7 decimals": [
    "indoor.json",
    indoorVariant("poi", (f) => {
      f["geometry"].coordinates = [103.8496123, 1.2912456];
    }),
  ],
};

describe("valid public files", () => {
  test.each(Object.entries(VALID))("%s", (_name, [file, document]) => {
    expect(validateSnapshotFile(file, document)).toEqual({ valid: true, problems: [] });
  });
});

/**
 * Fields that must never appear in a public file (docs/snapshot-format.md, "Privacy"): anchors and
 * their priors and photos, restricted zones, permissions, contributors, change sets, moderation,
 * captures, evidence, private exports, revs and bookkeeping times.
 */
const PRIVATE_FIELDS = [
  "rev",
  "permission",
  "operator",
  "anchor_id",
  "anchors",
  "photo_uri",
  "surveyed_geom",
  "prior_source",
  "prior_sigma_m",
  "facing_deg",
  "restricted_zone",
  "restricted_zones",
  "contributor_id",
  "display_name",
  "trust_tier",
  "change_set_id",
  "base_version_id",
  "decision",
  "publish_path",
  "reviewer_id",
  "published_by",
  "capture_id",
  "bundle_uri",
  "device_model",
  "evidence_uri",
  "private_export_uri",
  "snapshot_uri",
  "updated_at",
  "created_at",
  "imported_at",
  "tags",
];

const PUBLIC_FILES = Object.keys(SNAPSHOT_SCHEMA_FILES) as SnapshotFileName[];

describe("privacy", () => {
  test.each(PUBLIC_FILES)("the %s schema names no private field", (file) => {
    const found: string[] = [];
    walkSchema(readSchema(`snapshot/${SNAPSHOT_SCHEMA_FILES[file]}`), file, (schema, at) => {
      const properties = Object.keys((schema["properties"] as object | undefined) ?? {});
      for (const name of properties) if (PRIVATE_FIELDS.includes(name)) found.push(`${at}/${name}`);
    });
    expect(found).toEqual([]);
  });

  test("indoor.json has no anchor or restricted-zone feature type", () => {
    const types: unknown[] = [];
    walkSchema(readSchema("snapshot/indoor.schema.json"), "", (schema, at) => {
      if (at.endsWith("/properties/feature_type")) types.push(schema["const"]);
    });
    expect(types.sort()).toEqual(
      ["edge", "level", "node", "poi", "space", "street_connector", "venue"].sort(),
    );
  });

  // Every object in the public schemas has additionalProperties: false (schemas.test.ts), so a
  // private field can't be smuggled in anywhere. Spot-check the places a builder bug would put one.
  const places: Record<string, (field: string) => [SnapshotFileName, unknown]> = {
    "the indoor collection": (field) => ["indoor.json", { ...examples.indoor, [field]: 1 }],
    "an indoor feature": (field) => [
      "indoor.json",
      indoorVariant("node", (f) => {
        f[field] = 1;
      }),
    ],
    "venue properties": (field) => [
      "indoor.json",
      indoorVariant("venue", (f) => {
        f["properties"][field] = "x";
      }),
    ],
    "node properties": (field) => [
      "indoor.json",
      indoorVariant("node", (f) => {
        f["properties"][field] = "x";
      }),
    ],
    "edge properties": (field) => [
      "indoor.json",
      indoorVariant("edge", (f) => {
        f["properties"][field] = 1;
      }),
    ],
    "street edge properties": (field) => [
      "street.json",
      variant(examples.street, (s) => {
        (s.features[3]?.properties as unknown as Record<string, unknown>)[field] = "x";
      }),
    ],
    "latest.json": (field) => ["latest.json", { ...examples.latest, [field]: "x" }],
    "a status entry": (field) => [
      "status.json",
      variant(examples.status, (s) => {
        (s.entries[0] as unknown as Record<string, unknown>)[field] = "x";
      }),
    ],
  };
  const cases = Object.keys(places).flatMap((place) =>
    PRIVATE_FIELDS.map((field) => [place, field] as const),
  );

  test.each(cases)("%s refuses %s", (place, field) => {
    const [file, document] = places[place]?.(field) ?? ["indoor.json", null];
    expect(validateSnapshotFile(file, document).valid).toBe(false);
  });

  test.each([
    ["anchor", { kind: "floor_point", name: "Funan B2 UPL door" }],
    ["restricted_zone", { note: "plant room" }],
  ])("indoor.json refuses a feature of type %s", (featureType, extra) => {
    const document = variant(examples.indoor, (copy) => {
      copy.features.push({
        type: "Feature",
        id: "a0000000-0000-0000-0000-000000000001",
        properties: { feature_type: featureType, ...extra },
        geometry: { type: "Point", coordinates: [103.8499, 1.2913] },
      } as never);
    });
    expect(validateSnapshotFile("indoor.json", document).valid).toBe(false);
  });
});

const INVALID: Record<string, [SnapshotFileName, unknown, string?]> = {
  // Structure and constants
  "indoor.json of schema_version 2": ["indoor.json", { ...examples.indoor, schema_version: 2 }],
  "indoor.json that is not a FeatureCollection": [
    "indoor.json",
    { ...examples.indoor, type: "Feature" },
  ],
  "a bbox on the collection": ["indoor.json", { ...examples.indoor, bbox: [0, 0, 1, 1] }],
  "a feature without properties": [
    "indoor.json",
    indoorVariant("space", (f) => {
      delete f["properties"];
    }),
  ],
  "an unknown property (colour)": [
    "indoor.json",
    indoorVariant("space", (f) => {
      f["properties"]["colour"] = "#fff";
    }),
  ],
  "an unknown space kind": [
    "indoor.json",
    indoorVariant("space", (f) => {
      f["properties"]["kind"] = "car_park";
    }),
  ],
  "an uppercase id": [
    "indoor.json",
    indoorVariant("space", (f) => {
      f["id"] = "3000000A-0000-0000-0000-000000000001";
    }),
  ],
  "a numeric node id": [
    "indoor.json",
    indoorVariant("node", (f) => {
      f["id"] = 4;
    }),
  ],
  "an empty space name (use null)": [
    "indoor.json",
    indoorVariant("space", (f) => {
      f["properties"]["name"] = "";
    }),
  ],
  "an ordinal beyond a smallint": [
    "indoor.json",
    indoorVariant("level", (f) => {
      f["properties"]["ordinal"] = 40_000;
    }),
  ],
  "a negative length_m": [
    "indoor.json",
    indoorVariant("edge", (f) => {
      f["properties"]["length_m"] = -1;
    }),
  ],
  "an edge without from_ordinal": [
    "indoor.json",
    indoorVariant("edge", (f) => {
      delete f["properties"]["from_ordinal"];
    }),
  ],

  // Geometry
  "a level with a geometry": [
    "indoor.json",
    indoorVariant("level", (f) => {
      f["geometry"] = { type: "Point", coordinates: [103.8499, 1.2913] };
    }),
  ],
  "a space drawn as a point": [
    "indoor.json",
    indoorVariant("space", (f) => {
      f["geometry"] = { type: "Point", coordinates: [103.8499, 1.2913] };
    }),
  ],
  "a node without a geometry": [
    "indoor.json",
    indoorVariant("node", (f) => {
      f["geometry"] = null;
    }),
  ],
  "a point with an altitude": [
    "indoor.json",
    indoorVariant("node", (f) => {
      f["geometry"].coordinates = [103.8499, 1.2913, -9.5];
    }),
  ],
  "a line of one position": [
    "indoor.json",
    indoorVariant("edge", (f) => {
      f["geometry"].coordinates = [[103.8499, 1.2913]];
    }),
  ],
  "a ring of three positions": [
    "indoor.json",
    indoorVariant("space", (f) => {
      f["geometry"].coordinates = [
        [
          [103.8497, 1.2911],
          [103.8504, 1.2911],
          [103.8497, 1.2911],
        ],
      ];
    }),
  ],
  "a ring that is not closed": [
    "indoor.json",
    indoorVariant("space", (f) => {
      f["geometry"].coordinates[0][4] = [103.8497, 1.2912];
    }),
    "not closed",
  ],
  "a longitude beyond 180": [
    "indoor.json",
    indoorVariant("poi", (f) => {
      f["geometry"].coordinates = [183.8496, 1.2912];
    }),
  ],
  "swapped longitude and latitude": [
    "indoor.json",
    indoorVariant("poi", (f) => {
      f["geometry"].coordinates = [1.2912, 103.8496];
    }),
    "latitude",
  ],
  "a coordinate with 8 decimals": [
    "indoor.json",
    indoorVariant("poi", (f) => {
      f["geometry"].coordinates = [103.84961234, 1.2912];
    }),
    "decimals",
  ],
  "a coordinate in SVY21 metres": [
    "indoor.json",
    indoorVariant("poi", (f) => {
      f["geometry"].coordinates = [29_950.1, 30_120.4];
    }),
  ],
  "a line coordinate with float noise": [
    "indoor.json",
    indoorVariant("edge", (f) => {
      f["geometry"].coordinates[0] = [103.8499 + 0.00001, 1.2913];
    }),
    "decimals",
  ],

  // References, order and database rules (checked after the schema)
  "a properties.id that differs from the id": [
    "indoor.json",
    indoorVariant("space", (f) => {
      f["properties"]["id"] = examples.SPACE.funanB2Toilet;
    }),
    "properties.id differs",
  ],
  "two features with one id": [
    "indoor.json",
    indoorVariant("poi", (f) => {
      f["id"] = examples.SPACE.funanB2Toilet;
      f["properties"]["id"] = examples.SPACE.funanB2Toilet;
    }),
    "not unique",
  ],
  "features out of order": [
    "indoor.json",
    variant(examples.indoor, (copy) => {
      copy.features.reverse();
    }),
    "sorted",
  ],
  "a space on a level not in the file": [
    "indoor.json",
    indoorVariant("space", (f) => {
      f["properties"]["level_id"] = "20000000-0000-0000-0000-000000000099";
    }),
    "not a level",
  ],
  "a level of a venue not in the file": [
    "indoor.json",
    indoorVariant("level", (f) => {
      f["properties"]["venue_id"] = "10000000-0000-0000-0000-000000000099";
    }),
    "not a venue",
  ],
  "an edge to a node not in the file": [
    "indoor.json",
    indoorVariant("edge", (f) => {
      f["properties"]["to_node"] = "40000000-0000-0000-0000-000000000099";
    }),
    "not a node",
  ],
  "a POI in a space not in the file": [
    "indoor.json",
    indoorVariant("poi", (f) => {
      f["properties"]["space_id"] = "30000000-0000-0000-0000-000000000099";
    }),
    "not a space",
  ],
  "a space whose ordinal differs from its level's": [
    "indoor.json",
    indoorVariant("space", (f) => {
      f["properties"]["ordinal"] = -1;
    }),
    "ordinal",
  ],
  "an edge whose to_ordinal differs from its node's": [
    "indoor.json",
    indoorVariant("edge", (f) => {
      f["properties"]["to_ordinal"] = -2;
    }),
    "ordinal",
  ],
  "a node without a level off the street band": [
    "indoor.json",
    variant(examples.indoor, (copy) => {
      const exit = copy.features.find((f) => f.id === examples.NODE.cityHallExitA);
      if (exit !== undefined) (exit.properties as { ordinal: number }).ordinal = -1;
    }),
    "ordinal 0",
  ],
  "a step-free escalator": [
    "indoor.json",
    indoorVariant("edge", (f) => {
      f["properties"]["step_free"] = true;
    }),
    "never step_free",
  ],
  "an edge from a node to itself": [
    "indoor.json",
    variant(examples.indoor, (copy) => {
      const walk = copy.features.find((f) => f.id === examples.EDGE.walk);
      if (walk !== undefined && isIndoorFeature(walk, "edge")) {
        walk.properties.to_node = walk.properties.from_node;
        walk.properties.to_ordinal = walk.properties.from_ordinal;
      }
    }),
    "same node",
  ],
  "a street connector from a junction": [
    "indoor.json",
    indoorVariant("street_connector", (f) => {
      f["properties"]["node_id"] = examples.NODE.funanB2Junction;
      f["properties"]["ordinal"] = -2;
    }),
    "exit or entrance",
  ],

  // Lines run from their start node to their end node, exactly
  "an edge drawn backwards": [
    "indoor.json",
    variant(examples.indoor, (copy) => {
      const walk = copy.features.find((f) => f.id === examples.EDGE.walk);
      if (walk?.geometry?.type === "LineString") walk.geometry.coordinates.reverse();
    }),
    "does not start at from_node's position",
  ],
  "an edge that stops short of its end node": [
    "indoor.json",
    variant(examples.indoor, (copy) => {
      const walk = copy.features.find((f) => f.id === examples.EDGE.walk);
      if (walk?.geometry?.type === "LineString") walk.geometry.coordinates.pop();
    }),
    "does not end at to_node's position",
  ],
  "a street connector that doesn't start at its exit": [
    "indoor.json",
    indoorVariant("street_connector", (f) => {
      f["geometry"].coordinates[0] = [103.8505, 1.2928];
    }),
    "does not start at node_id's position",
  ],

  // Street connectors: one per exit or entrance, with an id derived from it
  "a street connector whose id is not derived from its node": [
    "indoor.json",
    indoorVariant("street_connector", (f) => {
      f["id"] = "70000000-0000-0000-0000-000000000001";
      f["properties"]["id"] = "70000000-0000-0000-0000-000000000001";
    }),
    `a street connector's id is ${examples.CONNECTOR.northBridgeRoad}`,
  ],
  "two street connectors for one exit": [
    "indoor.json",
    variant(examples.indoor, (copy) => {
      const connector = copy.features.find((f) => f.id === examples.CONNECTOR.northBridgeRoad);
      if (connector !== undefined) {
        const second = structuredClone(connector);
        second.id = "ffffffff-0000-0000-0000-000000000001";
        second.properties.id = second.id;
        copy.features.push(second);
      }
    }),
    "a second street connector",
  ],

  // street.json
  "street.json without its source": [
    "street.json",
    variant(examples.street, (s) => {
      delete (s as Partial<StreetSnapshot>).source;
    }),
  ],
  "street.json under another licence": [
    "street.json",
    variant(examples.street, (s) => {
      (s.source as { licence: string }).licence = "CC-BY-4.0";
    }),
  ],
  "a street edge with an id": [
    "street.json",
    variant(examples.street, (s) => {
      (s.features[3] as unknown as Record<string, unknown>)["id"] =
        "60000000-0000-0000-0000-000000000001";
    }),
  ],
  "a street node with a UUID id": [
    "street.json",
    variant(examples.street, (s) => {
      (s.features[0] as unknown as Record<string, unknown>)["id"] =
        "60000000-0000-0000-0000-000000000001";
    }),
  ],
  "a street node id of 0": [
    "street.json",
    variant(examples.street, (s) => {
      (s.features[0] as unknown as Record<string, unknown>)["id"] = 0;
    }),
  ],
  "a street edge to a node not in the file": [
    "street.json",
    variant(examples.street, (s) => {
      (s.features[4]?.properties as { to_osm_node: number }).to_osm_node = 1999;
    }),
    "not a street node",
  ],
  "a street edge drawn backwards": [
    "street.json",
    variant(examples.street, (s) => {
      const edge = s.features[3];
      if (edge?.geometry.type === "LineString") edge.geometry.coordinates.reverse();
    }),
    "does not start at from_osm_node's position",
  ],
  "street features out of order": [
    "street.json",
    variant(examples.street, (s) => {
      s.features.reverse();
    }),
    "sorted",
  ],

  // latest.json
  "latest.json without attribution": [
    "latest.json",
    { ...examples.latest, attribution: [] as unknown as LatestPointer["attribution"] },
  ],
  "an attribution over http": [
    "latest.json",
    {
      ...examples.latest,
      attribution: [{ text: "© OpenStreetMap contributors", url: "http://osm.org/copyright" }],
    },
  ],
  "a demo flag that is not a boolean": ["latest.json", { ...examples.latest, demo: "yes" }],
  "version 0": ["latest.json", { ...examples.latest, version: 0 }],
  "a file of 0 bytes": [
    "latest.json",
    variant(examples.latest, (l) => {
      l.files.indoor.bytes = 0;
    }),
  ],
  "a file path outside snapshots/": [
    "latest.json",
    variant(examples.latest, (l) => {
      l.files.indoor.path = "indoor.json";
    }),
  ],
  "a file path under another version's directory": [
    "latest.json",
    variant(examples.latest, (l) => {
      l.files.street.path = snapshotFilePath("0".repeat(64), "street.json");
    }),
    "expected",
  ],
  "indoor and street swapped": [
    "latest.json",
    variant(examples.latest, (l) => {
      [l.files.indoor, l.files.street] = [l.files.street, l.files.indoor];
    }),
    "expected",
  ],
  "a published_at without an offset": [
    "latest.json",
    { ...examples.latest, published_at: "2026-11-02T14:05:11" },
  ],

  // status.json
  "a status entry for a space": [
    "status.json",
    variant(examples.status, (s) => {
      (s.entries[0] as { feature_type: string }).feature_type = "space";
    }),
  ],
  "a status entry without note (required, may be null)": [
    "status.json",
    variant(examples.status, (s) => {
      delete (s.entries[0] as Partial<StatusOverlay["entries"][0]>).note;
    }),
  ],
  "two entries for one feature": [
    "status.json",
    variant(examples.status, (s) => {
      const first = s.entries[0];
      if (first !== undefined) s.entries.push({ ...first, is_open: true });
    }),
    "second entry",
  ],
  "an entry that ends before it starts": [
    "status.json",
    variant(examples.status, (s) => {
      const first = s.entries[0];
      if (first !== undefined) first.valid_until = "2026-11-03T06:00:00+08:00";
    }),
    "not later",
  ],
  "an entry that has not started": [
    "status.json",
    variant(examples.status, (s) => {
      const first = s.entries[0];
      if (first !== undefined) first.valid_from = "2026-11-03T09:00:00+08:00";
    }),
    "does not cover",
  ],
  "an entry that has ended": [
    "status.json",
    variant(examples.status, (s) => {
      const first = s.entries[0];
      if (first !== undefined) first.valid_until = "2026-11-03T08:00:00+08:00";
    }),
    "does not cover",
  ],
};

describe("invalid public files", () => {
  test.each(Object.entries(INVALID))("%s", (_name, [file, document, message]) => {
    const result = validateSnapshotFile(file, document);
    expect(result.valid).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
    if (message !== undefined) expect(result.problems.join("\n")).toContain(message);
  });
});

describe("content addressing", () => {
  const indoorBytes = new TextEncoder().encode(JSON.stringify(examples.indoor));
  const streetBytes = new TextEncoder().encode(JSON.stringify(examples.street));
  const snapshotSha = snapshotSha256({ "indoor.json": indoorBytes, "street.json": streetBytes });

  test("snapshot_sha256 is the SHA-256 of the files' sha256sum lines", () => {
    const lines = `${sha256Hex(indoorBytes)}  indoor.json\n${sha256Hex(streetBytes)}  street.json\n`;
    expect(
      snapshotDigestInput({
        "indoor.json": sha256Hex(indoorBytes),
        "street.json": sha256Hex(streetBytes),
      }),
    ).toBe(lines);
    expect(snapshotSha).toBe(sha256Hex(lines));
    expect(snapshotSha).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a version's files live under snapshots/<snapshot_sha256>/", () => {
    expect(snapshotDirectory(snapshotSha)).toBe(`snapshots/${snapshotSha}/`);
    expect(snapshotFilePath(snapshotSha, "indoor.json")).toBe(
      `snapshots/${snapshotSha}/indoor.json`,
    );
  });

  const pointer: LatestPointer = {
    ...examples.latest,
    snapshot_sha256: snapshotSha,
    files: {
      indoor: {
        path: snapshotFilePath(snapshotSha, "indoor.json"),
        bytes: indoorBytes.byteLength,
        sha256: sha256Hex(indoorBytes),
      },
      street: {
        path: snapshotFilePath(snapshotSha, "street.json"),
        bytes: streetBytes.byteLength,
        sha256: sha256Hex(streetBytes),
      },
    },
  };

  test("latest.json built from the files validates and matches them", () => {
    expect(validateSnapshotFile("latest.json", pointer)).toEqual({ valid: true, problems: [] });
    expect(
      verifyLatestPointer(pointer, { "indoor.json": indoorBytes, "street.json": streetBytes }),
    ).toEqual([]);
  });

  test("a changed file no longer matches latest.json", () => {
    const changed = new TextEncoder().encode(
      JSON.stringify({ ...examples.indoor, features: examples.indoor.features.slice(1) }),
    );
    expect(
      verifyLatestPointer(pointer, { "indoor.json": changed, "street.json": streetBytes }),
    ).toEqual([
      `files.indoor.bytes is ${indoorBytes.byteLength}; indoor.json has ${changed.byteLength}`,
      "files.indoor.sha256 does not match indoor.json",
      "snapshot_sha256 does not match the files",
    ]);
  });

  test("the same content gives the same path", () => {
    const again = snapshotSha256({
      "indoor.json": JSON.stringify(structuredClone(examples.indoor)),
      "street.json": JSON.stringify(structuredClone(examples.street)),
    });
    expect(again).toBe(snapshotSha);
  });
});

describe("coordinate decimals", () => {
  test.each([
    [103.8545349, true],
    [1.2930001, true],
    [103.85, true],
    [-180, true],
    [0, true],
    [103.85453491, false],
    [0.1 + 0.2, false],
    [1e-8, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
  ])("%d has at most 7 decimals: %s", (value, expected) => {
    expect(hasAtMostDecimals(value)).toBe(expected);
  });

  test("rounding to 7 decimals always passes", () => {
    for (let i = 0; i < 10_000; i++) {
      const value = Number((103.8 + Math.random() * 0.1).toFixed(7));
      expect(hasAtMostDecimals(value)).toBe(true);
    }
  });
});

describe("street connector ids", () => {
  test("uuidV5 gives RFC 9562's name-based UUIDs", () => {
    // Python's uuid.uuid5(uuid.NAMESPACE_DNS, "python.org"), from its documentation.
    expect(uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org")).toBe(
      "886313e1-3b8a-5372-9b90-0c9aee199e5d",
    );
    expect(() => uuidV5("not-a-uuid", "x")).toThrow("Not a UUID");
  });

  test("a connector's id is derived from its node's, whatever the case", () => {
    expect(streetConnectorId(examples.NODE.northBridgeRoadExit)).toBe(
      examples.CONNECTOR.northBridgeRoad,
    );
    expect(streetConnectorId(examples.NODE.northBridgeRoadExit.toUpperCase())).toBe(
      examples.CONNECTOR.northBridgeRoad,
    );
    expect(streetConnectorId(examples.NODE.cityHallExitA)).not.toBe(
      examples.CONNECTOR.northBridgeRoad,
    );
  });
});

describe("street connectors across the two files", () => {
  test("every connector ends at a street node in street.json", () => {
    expect(checkStreetConnectors(examples.indoor, examples.street)).toEqual([]);
  });

  test("a connector that ends away from its street node", () => {
    const indoor = indoorVariant("street_connector", (f) => {
      f["geometry"].coordinates[1] = [103.8507, 1.2929];
    });
    expect(checkStreetConnectors(indoor, examples.street)).toEqual([
      "features[17].geometry: the line does not end at street node 1001's position",
    ]);
  });

  test("a connector to a vertex street.json lacks", () => {
    const street = variant(examples.street, (s) => {
      s.features.shift();
    });
    expect(checkStreetConnectors(examples.indoor, street)).toEqual([
      "features[17]: osm_node_id 1001 is not a street node in street.json",
    ]);
  });
});

describe("validateVersion", () => {
  test("the example version is valid", () => {
    expect(validateVersion(examples.indoor, examples.street)).toEqual({
      valid: true,
      problems: [],
    });
  });

  test("checks the files against each other", () => {
    const street = variant(examples.street, (s) => {
      s.features = s.features.filter((f) => !("id" in f) || f.id !== 1001);
      s.features = s.features.filter(
        (f) => f.properties.feature_type !== "street_edge" || f.properties.from_osm_node !== 1001,
      );
    });
    expect(validateSnapshotFile("street.json", street)).toEqual({ valid: true, problems: [] });
    expect(validateVersion(examples.indoor, street)).toEqual({
      valid: false,
      problems: ["indoor.json: features[17]: osm_node_id 1001 is not a street node in street.json"],
    });
  });

  test("names the file of each problem, and checks across files only when both are valid", () => {
    const indoor = indoorVariant("space", (f) => {
      f["properties"]["kind"] = "car_park";
    });
    const result = validateVersion(indoor, { ...examples.street, schema_version: 2 });
    expect(result.valid).toBe(false);
    expect(result.problems.some((p) => p.startsWith("indoor.json: "))).toBe(true);
    expect(result.problems.some((p) => p.startsWith("street.json: "))).toBe(true);
    expect(result.problems.every((p) => /^(indoor|street)\.json: /.test(p))).toBe(true);
  });
});

describe("isIndoorFeature", () => {
  test("narrows by properties.feature_type", () => {
    const edges = examples.indoor.features.filter((f) => isIndoorFeature(f, "edge"));
    expect(edges.map((edge) => edge.properties.from_node)).toHaveLength(4);
  });
});
