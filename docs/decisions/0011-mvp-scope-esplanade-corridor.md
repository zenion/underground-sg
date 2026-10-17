# 0011: MVP scope: the Esplanade corridor

Status: accepted · 2026-10-17

## Decision

The owner decided on 2026-10-17 to move the MVP from the City Hall cluster to a corridor through Esplanade MRT.

- **The corridor.** It runs from South Beach to Raffles City through the unpaid B1 level of Esplanade MRT (CC3), signed "Esplanade Xchange": the Exit F link to South Beach, and the Exit G passage to Raffles City's basement. The links to Marina Square (Esplanade Exit B, Marina Link, Marina Square's basement door) are in it too. Raffles City's basement and its link to City Hall MRT's unpaid concourse are its west end. The venues and what is in scope for each are in the [spec](../spec.md#mvp-scope-the-esplanade-corridor).
- **Marina Square.** The mall closes on 31 Mar 2027 for a redevelopment due to finish around 2031. The MVP maps Marina Link up to its door; the interior is optional and low priority.
- **The first expansion** after the MVP is the former City Hall cluster: Funan with the UPL from its Basement 2 to City Hall MRT, City Hall MRT's other public levels and exits, and CityLink Mall with its link to Esplanade MRT.
- **Phase 1's gate:** the Swift spike's exit criteria are met, and a first corridor walk has been recorded and replays on the PC ([0010](0010-capture-recording-and-replay.md)). It replaces "one venue says yes": scanning needs no venue permission, an owner decision of the same day recorded in the [spec](../spec.md#privacy-and-legal) and [0010](0010-capture-recording-and-replay.md).
- **Phase 2's pilot** moves from the Funan UPL to the corridor:
  - P1: Exit F's street door through the Exit F link to the B1 junction;
  - P2: the B1 junction through the Exit G passage to Raffles City's B2 door, walked out and back;
  - P3: the B1 junction to the Exit C or E street door, with GNSS, for a second street prior;
  - then Marina Link.

  If Exit F has no public street door of its own (checked on the site walk), P1 starts at the B1 end of the Exit F link.
- Existing tests keep their City Hall cluster coordinates; new synthetic data prefers the corridor (Esplanade, Raffles City, South Beach).

## Why

- A short, connected corridor that can be walked repeatedly tests drift, positioning and routing on real ground before scaling, and suits walking a route once and replaying it ([0010](0010-capture-recording-and-replay.md)).
- Almost all of it is one station's unpaid level, outside paid areas. Planning lengths from OpenStreetMap: about 150 m from Exit F to Raffles City's entrance, and about 250 m to Marina Square's door.
- Exits C, E and F open at street level, so a connected group gets two street priors 90 to 140 m apart early. City Hall's exits, 240 to 360 m away, join once Raffles City's link is mapped ([0008](0008-anchors-and-georeferencing.md)).
- A scan of Marina Square's interior would be current for about five months.

## Consequences

- The spec's goals, scope, milestones and risks, the backlog, and the seed dataset change with it. The seed's core venues are Esplanade MRT, City Hall MRT, South Beach, Raffles City and Marina Square; Funan and CityLink Mall leave HEAD and come back with the same ids in the first expansion.
- [0002](0002-photo-localization.md)'s CPU benchmark and [0008](0008-anchors-and-georeferencing.md)'s synthetic alignment test use corridor data.
- Still open, and checked on the site walk: where Exit F reaches the street, the station's level names and which of them are unpaid, and whether Marina Link stays open during Marina Square's redevelopment.
- The records in `docs/reviews/` still describe the City Hall cluster, as they did when they were written.

## Alternatives considered

- **Keep the City Hall cluster as the MVP.** It stays the first expansion. The corridor is shorter and almost all on one station's unpaid level, so the first network can be walked, recorded and replayed sooner.
- **Map Marina Square's interior in the MVP.** It closes on 31 Mar 2027, months after the scan.
