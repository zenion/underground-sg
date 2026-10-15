// What the webapp hands map-style's applyStatus: status.json narrowed to the version on screen,
// and the closures that come out at a given time.

import type { StatusEntry, StatusOverlay } from "@usg/contracts";
import { applyStatus, CLOSED_STATE, closedFeatureIds, SOURCES } from "@usg/map-style";
import { describe, expect, test } from "vitest";
import { demoIndoor, demoStatus, EDGE, NODE, SPACE } from "../fixtures/demo-snapshot.ts";
import { emptyStatus, statusForVersion } from "../src/data/status.ts";

const NOW = new Date("2026-10-15T10:00:00+08:00");

function entry(overrides: Partial<StatusEntry>): StatusEntry {
  return {
    feature_type: "node",
    feature_id: NODE.cityHallExitA,
    is_open: false,
    note: null,
    valid_from: "2026-10-15T08:00:00+08:00",
    valid_until: null,
    ...overrides,
  };
}

function overlay(entries: StatusEntry[]): StatusOverlay {
  return { schema_version: 1, generated_at: NOW.toISOString(), entries };
}

describe("statusForVersion", () => {
  test("keeps entries for the version's nodes and edges", () => {
    const status = demoStatus(NOW);
    expect(statusForVersion(status, demoIndoor)).toEqual(status);
  });

  test("drops entries for features the version doesn't have, or of another type", () => {
    const kept = entry({ feature_type: "edge", feature_id: EDGE.stairs });
    const narrowed = statusForVersion(
      overlay([
        kept,
        entry({ feature_id: "70000000-0000-0000-0000-000000000001" }),
        // An edge's id, reported as a node.
        entry({ feature_type: "node", feature_id: EDGE.link }),
        // A space is neither.
        entry({ feature_type: "node", feature_id: SPACE.cityHallConcourse }),
      ]),
      demoIndoor,
    );
    expect(narrowed.entries).toEqual([kept]);
  });

  test("an empty overlay is what a missing status.json means", () => {
    expect(emptyStatus(NOW)).toEqual({
      schema_version: 1,
      generated_at: NOW.toISOString(),
      entries: [],
    });
  });
});

describe("the closures applyStatus marks", () => {
  test("the demo's escalator and Exit B are closed now", () => {
    const status = statusForVersion(demoStatus(NOW), demoIndoor);
    expect(closedFeatureIds(status, NOW)).toEqual([EDGE.escalator, NODE.northBridgeRoadExit]);
  });

  test("a closure that has ended or not started, and a reopening, mark nothing", () => {
    const status = statusForVersion(
      overlay([
        entry({ valid_until: "2026-10-15T09:00:00+08:00" }),
        entry({ feature_id: NODE.stamfordRoadExit, valid_from: "2026-10-15T12:00:00+08:00" }),
        entry({ feature_id: NODE.northBridgeRoadExit, is_open: true }),
      ]),
      demoIndoor,
    );
    expect(closedFeatureIds(status, NOW)).toEqual([]);
  });

  test("applied to a map, then cleared by an empty overlay", () => {
    const state = new Map<string, Record<string, unknown>>();
    const map = {
      setFeatureState(feature: { source: string; id: string }, value: Record<string, unknown>) {
        state.set(`${feature.source}/${feature.id}`, {
          ...state.get(`${feature.source}/${feature.id}`),
          ...value,
        });
      },
      removeFeatureState(target: { source: string; id?: string }, key?: string) {
        const current = state.get(`${target.source}/${target.id}`);
        if (current !== undefined && key !== undefined) delete current[key];
      },
    };
    applyStatus(map, statusForVersion(demoStatus(NOW), demoIndoor), NOW);
    expect(state.get(`${SOURCES.indoor}/${EDGE.escalator}`)).toEqual({ [CLOSED_STATE]: true });
    applyStatus(map, emptyStatus(NOW), NOW);
    expect(state.get(`${SOURCES.indoor}/${EDGE.escalator}`)).toEqual({});
  });
});
