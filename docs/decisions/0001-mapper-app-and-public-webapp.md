# 0001: Native mapper app for capture, webapp for the public

Status: accepted · 2026-10-12

## Decision

Two clients:

- **Mapper app** (native iOS, Swift + ARKit): capture, instant on-device preview, editing, and testing against a private draft, all in one loop. Used by the owner and contributors.
- **Public webapp** (Next.js + MapLibre GL JS): map, routing, photo locate. No install.

## Why

- Only native code can read LiDAR, so capture must be native.
- Initial mapping needs a tight capture → check → fix loop while standing in the corridor. Splitting capture and viewing into separate apps would slow that loop (the owner's explicit concern).
- Public users should not need an install; a webapp covers map, routing and photo locate.

## Consequences

- Both clients render the same map style (`packages/map-style`, MapLibre GL JS on web, MapLibre Native on iOS) so mappers see what the public will see.
- Routing logic is needed on both clients; keep the cost model in one place and port or share it (see 0003).
- Building the iOS app needs a Mac with Xcode and an iPhone Pro with LiDAR.
