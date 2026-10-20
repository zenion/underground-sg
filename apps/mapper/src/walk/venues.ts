// The MVP corridor's venues (ADR 0011), in walking order, for the walk screen's venue chips: the
// ids a recording names in `venues` (StartOptions). They are the seed's ids (db/seed/core-venues.ts),
// which never change; test/venues.test.ts checks that the two lists match.

export interface CorridorVenue {
  readonly id: string;
  readonly name: string;
}

export const CORRIDOR_VENUES: readonly CorridorVenue[] = Object.freeze([
  { id: "72b16287-20ee-4bee-8086-ce623f24495c", name: "South Beach" },
  { id: "36632586-e1fa-4e10-800a-81acf0eab09a", name: "Esplanade MRT" },
  { id: "dabbc03c-39d9-4947-8dbc-b2aa0c42e5d2", name: "Raffles City" },
  { id: "00e29161-0c10-4951-97aa-515e68cdc1cc", name: "City Hall MRT" },
  { id: "8092643f-fa68-476b-8290-225d6145032e", name: "Marina Square" },
]);

/** The module accepts 1 to 50 venues (`ERR_INVALID_VENUES` otherwise). */
export const MAX_SESSION_VENUES = 50;

export function isCorridorVenue(id: string): boolean {
  return CORRIDOR_VENUES.some((venue) => venue.id === id);
}
