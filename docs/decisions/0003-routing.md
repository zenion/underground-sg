# 0003: Own routing graph, OSM street graph plus indoor graph, routed on the client

Status: accepted · 2026-10-12 · amended 2026-10-15

## Decision

Route over one network: our indoor graph joined to an OpenStreetMap street graph at every exit and entrance. Clients route over the published snapshot; there is no routing server for the MVP.

### One router

- One TypeScript router in `packages/routing`, used by `apps/web` and `apps/mapper`. No port.
- The mapper app routes over the draft on the phone from Phase 2.

### Graph

| Part | Source | Published in |
| --- | --- | --- |
| Indoor | `nodes` and `edges` | `indoor.json` |
| Street | `street_nodes` and `street_edges`, keyed by OSM node ID | `street.json` (ODbL) |
| Joins | `street_connectors`: each exit or entrance node to the nearest street vertex within 100 m, computed in SVY21 and rebuilt in every publish | `indoor.json` |

- The OSM import filters out ways with `tunnel=yes`, `indoor=*`, a negative `level` or `layer`, and ways inside venue footprints, because OSM already maps some underground links. `covered` comes from `covered=yes` plus tunnel, building and roof heuristics. The import is re-runnable and idempotent.
- File layout and versioning: [0004](0004-storage-and-versioning.md).

### Cost

Cost is time in seconds:

- `length_m` / walking speed;
- plus fixed seconds per edge kind, for example a lift boarding wait or a level change;
- times multiplicative factors, for example a heavy factor on outdoor edges when "stay underground" is on.

All values live in `packages/routing/routing-config.json`, validated by a schema in `packages/contracts`. They are tuned in the Phase 3 field tests.

### Exclusions

| Excluded | When |
| --- | --- |
| Features closed in the status overlay (`status.json`) | While the report is valid |
| Edges with `access = paid_fare_zone` | By default |
| Edges with `access = customers_only` | By default |
| Edges whose `opening_hours` say closed at the time of travel | Always. OSM `opening_hours` syntax, evaluated in Asia/Singapore time; NULL means always open |
| Stairs and escalators | Step-free mode |

An exit's or entrance's hours go on the edges leading to its node; street connectors carry none.

### Vertical connectors

- A vertical connector is an edge of kind `escalator`, `stairs`, `lift`, `ramp` or `travelator` between two landing nodes on different levels. Landings are one node per end, or one per lift stop.
- A lift is one landing node per stop, all sharing a `connector_id`, with edges between consecutive stops and a one-time boarding penalty.
- Connector edges have `level_id` NULL and are drawn on both end levels. Single-level edges carry their `level_id`.
- `oneway = true` means traversable only from `from_node` to `to_node`.
- Stairs and escalators are never step-free; the schema enforces it with a CHECK.
- Routing never infers a connection from equal ordinals. Ordinal is only a display band (0004).
- Reversing escalator schedules are a later addition.

### Street side and licence

Keeping the street graph in its own file is meant to keep the indoor data a separate database under the OSMF collective-database guideline. Get legal review. The licence for our own map data is still an open question in the [spec](../spec.md).

## Why

- OneMap's routing API cannot take our indoor graph as input.
- One cluster is a small graph. Routing in the browser and on the phone is fast and works with the draft map.
- The mapper app is TypeScript, so one router serves both clients and there is no Swift port to keep in step.
- Seconds put walking, lift waits and level changes in one unit, so the penalties can be tuned against real walking times.
- Without access and opening hours, routes would cross MRT paid areas or use links that are locked at night.
- A plain bounding-box import would duplicate indoor links that OSM already maps, and ways stored without topology cannot join exits to the street network.
- An explicit connector edge is the only reliable evidence that two levels connect. Levels at different heights can share a display band.

Background and sources: [stack review](../reviews/2026-10-12-stack-review.md), section 7 (items 2, 3 and 9).

## Consequences

- Move to server-side routing (pgRouting) if the network grows past a few clusters.
- The snapshot writer's golden-file test produces the file the routing tests read, so producer and consumer are tested against one artifact.
- Closures come from the status overlay, not from columns on nodes and edges (`status_open` is gone).
- Mapping has to record landings with their `connector_id`, link and exit opening hours, and paid-area boundaries. The site walk collects opening hours and paid-area boundaries first.
- Phase 3 field tests verify routes on foot, including paid-area avoidance, opening hours and step-free mode.
- OSM attribution stays visible on every map view.
- A street connector joins an exit or entrance only to a street vertex within 100 m (2026-10-15, a tuning value; [snapshot-format.md](../snapshot-format.md#indoorjson)). An exit with no vertex that close has no connector, so routes can't start or end there until the street graph covers it: better than a connector drawn through buildings when the graph near it is missing. Revisit with the OSM import, or split street edges at the nearest point instead, if real exits sit further than that from every vertex.
