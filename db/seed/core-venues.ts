// The MVP's five core venues (docs/spec.md, "MVP scope: the Esplanade corridor"), for
// `pnpm db seed`: the corridor from South Beach through the unpaid B1 level of Esplanade MRT to
// Raffles City's basement, City Hall MRT's unpaid concourse at its west end, and Marina Square's
// door at the end of Marina Link. Their names and kinds are known; everything the site walk
// decides is still a TODO. The ids are fixed: a venue keeps its id for good, since every other
// HEAD row hangs off it.
//
// TODO(site walk, docs/backlog.md "Owner tasks"): each venue's pedestrian-network levels, named as
// the venue signs it, with their ordinal band and sort_key; each footprint; each operator, and
// which venue the passages between them belong to (Marina Link, the Exit F link, the Exit G
// passage). Don't guess signage: a level added here is created once and afterwards changes only
// through change sets.
//
// Permission: scanning needs no venue permission (decided 2026-10-17, docs/spec.md "Privacy and
// legal"), so `permission` is null. It stays an optional, private reference to anything a venue
// agrees in writing as a courtesy, never the letter itself and never in a public file.
//
// Funan and CityLink Mall were seeded before the MVP moved to the corridor. They belong to the
// first expansion after it, so `remove` takes them out of HEAD (they have no levels, so nothing
// references them; on a database without them it does nothing). When the expansion starts, move
// them back into `venues` with these same ids and drop them from `remove`. Funan's landlord gave
// written permission on 2026-10-15; that is kept as history in docs/backlog.md.
//
// The demo dataset (`pnpm demo`) is separate: services/api/src/demo/dataset.ts.

import type { SeedDataset } from "../src/seed.ts";

export const CORE_VENUE = {
  esplanadeMrt: "36632586-e1fa-4e10-800a-81acf0eab09a",
  southBeach: "72b16287-20ee-4bee-8086-ce623f24495c",
  rafflesCity: "dabbc03c-39d9-4947-8dbc-b2aa0c42e5d2",
  cityHallMrt: "00e29161-0c10-4951-97aa-515e68cdc1cc",
  marinaSquare: "8092643f-fa68-476b-8290-225d6145032e",
} as const;

/** Venues of the first expansion after the MVP, kept out of HEAD until then, with their ids. */
export const EXPANSION_VENUE = {
  funan: "82e97baa-5228-4986-8434-56be34a8a7a8",
  cityLinkMall: "a3ff57b8-c5dc-4a46-918e-4399858ffbe7",
} as const;

export const coreVenues: SeedDataset = {
  name: "core venues",
  venues: [
    {
      id: CORE_VENUE.esplanadeMrt,
      name: "Esplanade MRT",
      kind: "mrt_station",
      operator: null, // TODO(site walk)
      permission: null,
      footprint: null, // TODO(site walk)
      levels: [], // TODO(site walk): the unpaid B1 level (Esplanade Xchange) first
    },
    {
      id: CORE_VENUE.southBeach,
      name: "South Beach",
      // A mixed-use development, not a mall: only its public link to Exit F, and as much of its
      // public basement as is on the pedestrian network, is in scope.
      kind: "other",
      operator: null, // TODO(site walk)
      permission: null,
      footprint: null, // TODO(site walk)
      levels: [], // TODO(site walk)
    },
    {
      id: CORE_VENUE.rafflesCity,
      name: "Raffles City",
      kind: "mall",
      operator: null, // TODO(site walk)
      permission: null,
      footprint: null, // TODO(site walk)
      levels: [], // TODO(site walk): the basement the Exit G passage reaches
    },
    {
      id: CORE_VENUE.cityHallMrt,
      name: "City Hall MRT",
      kind: "mrt_station",
      operator: null, // TODO(site walk)
      permission: null,
      footprint: null, // TODO(site walk)
      levels: [], // TODO(site walk): the unpaid concourse where Raffles City's link arrives
    },
    {
      id: CORE_VENUE.marinaSquare,
      name: "Marina Square",
      // Closes on 31 Mar 2027 for redevelopment (to about 2031). Marina Link up to its basement
      // door is in scope; the interior is optional, low priority.
      kind: "mall",
      operator: null, // TODO(site walk)
      permission: null,
      footprint: null, // TODO(site walk)
      levels: [], // TODO(site walk)
    },
  ],
  remove: { venues: [EXPANSION_VENUE.funan, EXPANSION_VENUE.cityLinkMall] },
};
