// The walk screen's venues (src/walk/venues.ts) are the seed's core venues, with the same ids and
// names: a recording names its venues by these ids, which never change.

import { NODE_KINDS } from "@usg/contracts";
import { expect, test } from "vitest";
import { CORE_VENUE, coreVenues } from "../../../db/seed/core-venues.ts";
import { isNodeTagKind, NODE_TAG_ROW, nodeTagOptions } from "../src/walk/tags.ts";
import { CORRIDOR_VENUES, isCorridorVenue } from "../src/walk/venues.ts";

test("the corridor venues are the seed's core venues", () => {
  const ids = CORRIDOR_VENUES.map((venue) => venue.id);
  expect([...ids].sort()).toEqual(Object.values(CORE_VENUE).sort());
  const seedNames = new Map(coreVenues.venues.map((venue) => [venue.id, venue.name]));
  for (const venue of CORRIDOR_VENUES) expect(venue.name).toBe(seedNames.get(venue.id));
  expect(
    ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)),
  ).toBe(true);
  expect(isCorridorVenue(CORE_VENUE.rafflesCity)).toBe(true);
  expect(isCorridorVenue("82e97baa-5228-4986-8434-56be34a8a7a8")).toBe(false);
});

test("the tag row's kinds are node kinds, each once, without junctions", () => {
  const kinds = NODE_TAG_ROW.map((button) => button.kind);
  expect(new Set(kinds).size).toBe(kinds.length);
  for (const kind of kinds) expect(NODE_KINDS).toContain(kind);
  expect(kinds).not.toContain("junction");
  expect(isNodeTagKind("toilet")).toBe(false);
  expect(nodeTagOptions("lift")).toEqual({ type: "node", kind: "lift", name: null });
});
