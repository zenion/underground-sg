# 0003: Own routing graph, OSM footpaths plus indoor graph, routed on the client

Status: accepted · 2026-10-12

## Decision

Route over one graph that joins OpenStreetMap pedestrian footpaths (inside the cluster's bounding box) to our indoor graph at shared exit nodes. For the MVP, the client routes over the published snapshot; no routing server.

## Why

- OneMap's routing API cannot take our indoor graph as input.
- One cluster is a small graph; routing in the browser (and on the phone in mapper mode) is fast and works with the draft map.

## Cost model

Walking distance (m) plus penalties:

- outdoor edges: heavy penalty when "stay underground" is on
- stairs: excluded in step-free mode
- level changes: small penalty per change
- closed nodes or edges (`status_open = false`): excluded

Penalty values are tuning parameters, set during phase 3 field tests. Keep them in one shared config.

## Consequences

- Move to server-side routing (pgRouting) if the network grows past a few clusters.
- OSM data brings ODbL obligations on the combined database (open question in the spec).
