// The MVP's five core venues (docs/spec.md, "MVP scope: City Hall cluster"), for `pnpm db seed`.
// Their names and kinds are known; everything the site walk decides is still a TODO. The ids are
// fixed: a venue keeps its id for good, since every other HEAD row hangs off it.
//
// TODO(site walk, docs/backlog.md "Owner tasks"): each venue's pedestrian-network levels, named as
// the venue signs them, with their ordinal band and sort_key; each footprint; each operator. Don't
// guess signage: a level added here is created once and afterwards changes only through change
// sets.
//
// Permission: Funan's landlord gave written permission on 2026-10-15. The letter stays out of the
// repo; `permission` records only a reference to it, and is private (never in a public file).
// Raffles City, CityLink and the two MRT stations have not answered yet.
//
// The demo dataset (`pnpm demo`) is separate: services/api/src/demo/dataset.ts.

import type { SeedDataset } from "../src/seed.ts";

export const CORE_VENUE = {
  funan: "82e97baa-5228-4986-8434-56be34a8a7a8",
  rafflesCity: "dabbc03c-39d9-4947-8dbc-b2aa0c42e5d2",
  cityLinkMall: "a3ff57b8-c5dc-4a46-918e-4399858ffbe7",
  cityHallMrt: "00e29161-0c10-4951-97aa-515e68cdc1cc",
  esplanadeMrt: "36632586-e1fa-4e10-800a-81acf0eab09a",
} as const;

export const coreVenues: SeedDataset = {
  name: "core venues",
  venues: [
    {
      id: CORE_VENUE.funan,
      name: "Funan",
      kind: "mall",
      operator: null, // TODO(site walk)
      permission:
        "Written permission from Funan's landlord, granted 2026-10-15 (letter kept outside the repo)",
      footprint: null, // TODO(site walk)
      levels: [], // TODO(site walk): the B2 UPL level first
    },
    {
      id: CORE_VENUE.rafflesCity,
      name: "Raffles City",
      kind: "mall",
      operator: null, // TODO(site walk)
      permission: null, // Requested; not granted yet
      footprint: null, // TODO(site walk)
      levels: [], // TODO(site walk)
    },
    {
      id: CORE_VENUE.cityLinkMall,
      name: "CityLink Mall",
      kind: "mall",
      operator: null, // TODO(site walk)
      permission: null, // Requested; not granted yet
      footprint: null, // TODO(site walk)
      levels: [], // TODO(site walk)
    },
    {
      id: CORE_VENUE.cityHallMrt,
      name: "City Hall MRT",
      kind: "mrt_station",
      operator: null, // TODO(site walk)
      permission: null, // Asked of the MRT operator and LTA; not granted yet
      footprint: null, // TODO(site walk)
      levels: [], // TODO(site walk)
    },
    {
      id: CORE_VENUE.esplanadeMrt,
      name: "Esplanade MRT",
      kind: "mrt_station",
      operator: null, // TODO(site walk)
      permission: null, // Asked of the MRT operator and LTA; not granted yet
      footprint: null, // TODO(site walk)
      levels: [], // TODO(site walk)
    },
  ],
};
