import { describe, expect, test } from "vitest";
import {
  type ChangeSetDiff,
  DIFF_FEATURE_TYPES,
  DIFF_OPS,
  DIFF_OPS_BY_FEATURE_TYPE,
  type DiffEntry,
} from "../src/index.ts";
import { validateChangeSetDiff } from "../src/validators.ts";
import * as examples from "./map-examples.ts";
import { readSchema, type SchemaObject } from "./schemas.ts";

/** Returns a deep copy of `value` changed by `change`. */
function variant<T>(value: T, change: (copy: T) => void): T {
  const copy = structuredClone(value);
  change(copy);
  return copy;
}

/** An entry as loosely typed JSON, for making invalid variants. */
// biome-ignore lint/suspicious/noExplicitAny: an invalid variant may write anything anywhere
type LooseEntry = Record<string, any>;

/** Changes entry `i` of a copy of the example diff, loosely typed. */
function entryVariant(i: number, change: (entry: LooseEntry) => void): unknown {
  return variant(examples.diff, (copy) => {
    change(copy[i] as unknown as LooseEntry);
  });
}

const [spaceAdd, nodeModify, poiRemove, levelModify, anchorAdd] = examples.diff as [
  DiffEntry,
  DiffEntry,
  DiffEntry,
  DiffEntry,
  DiffEntry,
];

const edgeRow = {
  from_node: examples.NODE.funanB2Escalator,
  to_node: examples.NODE.funanB2Junction,
  kind: "walk",
  oneway: false,
  access: "public",
  opening_hours: null,
  level_id: examples.LEVEL.funanB2,
  connector_id: null,
  length_m: 40.12,
  step_free: true,
  sheltered: true,
  outdoor: false,
  geom: null,
};

/** The Funan B2 junction as HEAD has it, for removing it. */
const junctionRow = nodeModify.before;

/** Removes the Funan B2 junction, which the walk edge ends at. */
const junctionRemove = {
  op: "remove",
  feature_type: "node",
  id: examples.NODE.funanB2Junction,
  base_rev: 3,
  before: junctionRow,
  after: null,
};

describe("valid diffs", () => {
  test("the doc example", () => {
    expect(validateChangeSetDiff(examples.diff, "structural")).toEqual({
      valid: true,
      problems: [],
    });
  });

  test("a status change set's empty diff", () => {
    expect(validateChangeSetDiff([], "status")).toEqual({ valid: true, problems: [] });
  });

  test.each([
    [
      "an edge added without a centreline",
      [
        {
          op: "add",
          feature_type: "edge",
          id: examples.EDGE.walk,
          base_rev: null,
          before: null,
          after: edgeRow,
        },
      ],
    ],
    [
      "an edge removed",
      [
        {
          op: "remove",
          feature_type: "edge",
          id: examples.EDGE.walk,
          base_rev: 2,
          before: edgeRow,
          after: null,
        },
      ],
    ],
    [
      "a venue's footprint redrawn",
      [
        {
          op: "modify",
          feature_type: "venue",
          id: examples.VENUE.cityHallMrt,
          base_rev: 1,
          before: { name: "City Hall MRT", kind: "mrt_station", operator: "SMRT", footprint: null },
          after: {
            name: "City Hall MRT",
            kind: "mrt_station",
            operator: "SMRT",
            footprint: {
              type: "MultiPolygon",
              coordinates: [
                [
                  [
                    [103.8515, 1.2925],
                    [103.8528, 1.2925],
                    [103.8528, 1.2937],
                    [103.8515, 1.2937],
                    [103.8515, 1.2925],
                  ],
                ],
              ],
            },
          },
        },
      ],
    ],
    [
      "an anchor without a street prior",
      [
        variant(anchorAdd, (a) => {
          if (a.after !== null && a.feature_type === "anchor") {
            a.after.surveyed_geom = null;
            a.after.prior_source = null;
            a.after.prior_sigma_m = null;
          }
        }),
      ],
    ],
    [
      "a node removed with the edge that ends at it",
      [
        junctionRemove,
        {
          op: "remove",
          feature_type: "edge",
          id: examples.EDGE.walk,
          base_rev: 2,
          before: edgeRow,
          after: null,
        },
      ],
    ],
    [
      "a node removed, and the edge that ended at it rerouted",
      [
        junctionRemove,
        {
          op: "modify",
          feature_type: "edge",
          id: examples.EDGE.walk,
          base_rev: 2,
          before: edgeRow,
          after: { ...edgeRow, to_node: examples.NODE.funanB1Escalator },
        },
      ],
    ],
    [
      "an anchor facing 0 degrees",
      [
        variant(anchorAdd, (a) => {
          if (a.after !== null && a.feature_type === "anchor") a.after.facing_deg = 0;
        }),
      ],
    ],
  ])("%s", (_name, diff) => {
    expect(validateChangeSetDiff(diff, "structural")).toEqual({ valid: true, problems: [] });
  });
});

const INVALID: Record<string, [unknown, string?]> = {
  // op, base_rev, before and after go together
  "an add with a base_rev": [
    entryVariant(0, (e) => {
      e["base_rev"] = 1;
    }),
  ],
  "an add with a before": [
    entryVariant(0, (e) => {
      e["before"] = e["after"];
    }),
  ],
  "an add without an after": [
    entryVariant(0, (e) => {
      e["after"] = null;
    }),
  ],
  "a modify without a base_rev": [
    entryVariant(1, (e) => {
      e["base_rev"] = null;
    }),
  ],
  "a modify with base_rev 0": [
    entryVariant(1, (e) => {
      e["base_rev"] = 0;
    }),
  ],
  "a modify with a fractional base_rev": [
    entryVariant(1, (e) => {
      e["base_rev"] = 1.5;
    }),
  ],
  "a modify without a before": [
    entryVariant(1, (e) => {
      e["before"] = null;
    }),
  ],
  "a modify without an after": [
    entryVariant(1, (e) => {
      e["after"] = null;
    }),
  ],
  "a remove with an after": [
    entryVariant(2, (e) => {
      e["after"] = e["before"];
    }),
  ],
  "a remove without a base_rev": [
    entryVariant(2, (e) => {
      e["base_rev"] = null;
    }),
  ],
  "a remove without a before": [
    entryVariant(2, (e) => {
      e["before"] = null;
    }),
  ],
  "an entry without base_rev": [
    entryVariant(2, (e) => {
      delete e["base_rev"];
    }),
  ],
  "op move": [
    entryVariant(1, (e) => {
      e["op"] = "move";
    }),
  ],

  // Feature types and ops a change set may not use
  "adding a venue": [
    [
      {
        op: "add",
        feature_type: "venue",
        id: "10000000-0000-0000-0000-000000000009",
        base_rev: null,
        before: null,
        after: { name: "Raffles City", kind: "mall", operator: null, footprint: null },
      },
    ],
  ],
  "removing a level": [
    entryVariant(3, (e) => {
      e["op"] = "remove";
      e["after"] = null;
    }),
  ],
  "a street connector": [
    [
      {
        op: "remove",
        feature_type: "street_connector",
        id: examples.CONNECTOR.northBridgeRoad,
        base_rev: 1,
        before: { node_id: examples.NODE.northBridgeRoadExit },
        after: null,
      },
    ],
  ],
  "a restricted zone": [
    entryVariant(0, (e) => {
      e["feature_type"] = "restricted_zone";
    }),
  ],
  "a street edge": [
    entryVariant(0, (e) => {
      e["feature_type"] = "street_edge";
    }),
  ],
  "a row of the wrong feature type": [
    entryVariant(1, (e) => {
      e["feature_type"] = "poi";
    }),
  ],

  // Rows hold the diffable HEAD columns and nothing else
  "an unknown field on an entry": [
    entryVariant(1, (e) => {
      e["reason"] = "moved";
    }),
  ],
  "rev in a row": [
    entryVariant(1, (e) => {
      e["after"]["rev"] = 4;
    }),
  ],
  "id in a row": [
    entryVariant(1, (e) => {
      e["after"]["id"] = e["id"];
    }),
  ],
  "a node's ordinal (set by a trigger)": [
    entryVariant(1, (e) => {
      e["after"]["ordinal"] = -2;
    }),
  ],
  "a venue's permission (seed script only)": [
    [
      {
        op: "modify",
        feature_type: "venue",
        id: examples.VENUE.funan,
        base_rev: 1,
        before: { name: "Funan", kind: "mall", operator: null, footprint: null },
        after: {
          name: "Funan",
          kind: "mall",
          operator: null,
          footprint: null,
          permission: "letter",
        },
      },
    ],
  ],
  "a row missing a column": [
    entryVariant(1, (e) => {
      delete e["after"]["street_name"];
    }),
  ],
  "an unknown node kind": [
    entryVariant(1, (e) => {
      e["after"]["kind"] = "turnstile";
    }),
  ],
  "an uppercase id": [
    entryVariant(1, (e) => {
      e["id"] = String(e["id"]).replace("4", "A").toUpperCase();
    }),
  ],
  "a point with an altitude": [
    entryVariant(1, (e) => {
      e["after"]["geom"]["coordinates"] = [103.85021, 1.29152, -9.5];
    }),
  ],
  "a geometry in another type": [
    entryVariant(1, (e) => {
      e["after"]["geom"] = {
        type: "LineString",
        coordinates: [
          [103.85021, 1.29152],
          [103.8503, 1.2916],
        ],
      };
    }),
  ],
  "an anchor facing 360 degrees": [
    entryVariant(4, (e) => {
      e["after"]["facing_deg"] = 360;
    }),
  ],
  "an anchor prior with sigma 0": [
    entryVariant(4, (e) => {
      e["after"]["prior_sigma_m"] = 0;
    }),
  ],
  "a prior source of a made-up kind": [
    entryVariant(4, (e) => {
      e["after"]["prior_source"] = "survey";
    }),
  ],
  "a diff that is not a list": [{ entries: examples.diff }],

  // Checked after the schema
  "two entries for one feature": [[nodeModify, nodeModify], "second entry"],
  "a modify that changes nothing": [
    entryVariant(1, (e) => {
      e["after"] = e["before"];
    }),
    "equals its before",
  ],
  "a step-free stairs edge": [
    [
      {
        op: "add",
        feature_type: "edge",
        id: examples.EDGE.stairs,
        base_rev: null,
        before: null,
        after: { ...edgeRow, kind: "stairs" },
      },
    ],
    "never step_free",
  ],
  "an edge from a node to itself": [
    [
      {
        op: "add",
        feature_type: "edge",
        id: examples.EDGE.walk,
        base_rev: null,
        before: null,
        after: { ...edgeRow, to_node: edgeRow.from_node },
      },
    ],
    "from_node equals to_node",
  ],
  "an anchor prior without its sigma": [
    entryVariant(4, (e) => {
      e["after"]["prior_sigma_m"] = null;
    }),
    "all set or all null",
  ],
  "an unclosed ring": [
    entryVariant(0, (e) => {
      e["after"]["geom"]["coordinates"][0][4] = [103.8504, 1.2912];
    }),
    "not closed",
  ],
  "a coordinate with 8 decimals": [
    entryVariant(1, (e) => {
      e["after"]["geom"]["coordinates"] = [103.85021001, 1.29152];
    }),
    "decimals",
  ],
  "a structural change set with an empty diff": [[], "at least one entry"],

  // An add or modify may not reference a row the same diff removes: removes run last, so the
  // database's cascade would undo the entry.
  "an edge modified to end at a node the diff removes": [
    [
      junctionRemove,
      {
        op: "modify",
        feature_type: "edge",
        id: examples.EDGE.walk,
        base_rev: 2,
        before: edgeRow,
        after: { ...edgeRow, length_m: 41 },
      },
    ],
    `[1].after.to_node: references node ${examples.NODE.funanB2Junction}, which the diff removes`,
  ],
  "an edge added from a node the diff removes": [
    [
      {
        op: "add",
        feature_type: "edge",
        id: "50000000-0000-0000-0000-000000000009",
        base_rev: null,
        before: null,
        after: {
          ...edgeRow,
          from_node: examples.NODE.funanB2Junction,
          to_node: examples.NODE.funanB2Escalator,
        },
      },
      junctionRemove,
    ],
    "[0].after.from_node: references node",
  ],
  "a POI moved into a space the diff removes": [
    [
      {
        op: "remove",
        feature_type: "space",
        id: examples.SPACE.funanB2Toilet,
        base_rev: 1,
        before: {
          level_id: examples.LEVEL.funanB2,
          kind: "toilet",
          name: "Toilets",
          geom: {
            type: "Polygon",
            coordinates: [
              [
                [103.8495, 1.2911],
                [103.8497, 1.2911],
                [103.8497, 1.2913],
                [103.8495, 1.2913],
                [103.8495, 1.2911],
              ],
            ],
          },
        },
        after: null,
      },
      variant(poiRemove, (p) => {
        Object.assign(p, { op: "modify", after: { ...p.before, name: "Toilets (B2)" } });
      }),
    ],
    `[1].after.space_id: references space ${examples.SPACE.funanB2Toilet}, which the diff removes`,
  ],
  "an anchor added on a node the diff removes": [
    [
      junctionRemove,
      variant(anchorAdd, (a) => {
        if (a.after !== null && a.feature_type === "anchor")
          a.after.node_id = examples.NODE.funanB2Junction;
      }),
    ],
    "[1].after.node_id: references node",
  ],
};

describe("invalid diffs", () => {
  test.each(Object.entries(INVALID))("%s", (_name, [document, message]) => {
    const result = validateChangeSetDiff(document, "structural");
    expect(result.valid).toBe(false);
    if (message !== undefined) expect(result.problems.join("\n")).toContain(message);
  });

  test("a status change set with entries", () => {
    expect(validateChangeSetDiff([spaceAdd], "status").problems).toEqual([
      "a status change set has an empty diff: its content is its status reports",
    ]);
  });
});

describe("the schema's branches match the constants", () => {
  const schema = readSchema("diff/change-set-diff.schema.json");
  const defs = schema["$defs"] as Record<string, SchemaObject>;
  const branches = ((defs["entry"]?.["oneOf"] as SchemaObject[]) ?? []).map((branch) => {
    const name = String(branch["$ref"]).replace("#/$defs/", "");
    const properties = defs[name]?.["properties"] as Record<string, SchemaObject>;
    return [properties["feature_type"]?.["const"], properties["op"]?.["const"]];
  });

  test("one branch per allowed feature type and op, in apply order", () => {
    expect(branches).toEqual(
      DIFF_FEATURE_TYPES.flatMap((type) => DIFF_OPS_BY_FEATURE_TYPE[type].map((op) => [type, op])),
    );
  });

  test("the example uses every op", () => {
    expect(new Set([spaceAdd, nodeModify, poiRemove, levelModify].map((e) => e.op))).toEqual(
      new Set(DIFF_OPS),
    );
  });
});

describe("diff type", () => {
  test("TypeScript ties op to base_rev, before and after", () => {
    const entry: ChangeSetDiff[number] = spaceAdd;
    if (entry.op === "add") {
      // @ts-expect-error an add's base_rev is null
      const rev: number = entry.base_rev;
      expect(rev).toBeNull();
    }
  });
});
