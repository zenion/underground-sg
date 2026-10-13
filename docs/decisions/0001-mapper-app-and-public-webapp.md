# 0001: Native mapper app for capture, webapp for the public

Status: accepted · 2026-10-12 · amended 2026-10-12

Amended after the [stack review](../reviews/2026-10-12-stack-review.md): the mapper app is now Expo with one Swift module instead of a pure Swift app, and the webapp is a Vite + React SPA instead of Next.js.

## Decision

Two clients:

- **Mapper app** (`apps/mapper`): an Expo app (React Native, TypeScript) with one local Swift module, `apps/mapper/modules/capture-native`, for ARKit capture, Vision blur and the bundle writer. Capture, instant on-device preview, editing, and testing against a private draft, all in one loop. The owner is the only mapper through Phase 3; contributors join in Phase 4. Details in [0007](0007-expo-mapper-app.md).
- **Public webapp** (`apps/web`): a Vite + React SPA with MapLibre GL JS v6, built as static files and served from Cloudflare. Map, routing, photo locate. No install. The moderation UI is an authenticated route in the same app that calls the API.

## Why

- Only native code can read LiDAR, so capture must be native. Only that part needs to be: one Swift module owns ARKit and every image, and the rest of the app is TypeScript.
- Initial mapping needs a tight capture → check → fix loop while standing in the corridor. Splitting capture and viewing into separate apps would slow that loop (the owner's explicit concern).
- The owner develops on Windows without a Mac. With Expo, TypeScript changes reload on the phone straight from Windows, and only Swift changes need a cloud build. A pure Swift app would turn every UI change into a cloud build.
- One language across both clients and the server ([0006](0006-typescript-backend.md)) means routing, the map style, the floor-plan code and the data contracts exist once.
- Public users should not need an install; a webapp covers map, routing and photo locate.
- The webapp needs no server rendering: it loads published files and routes on the client. A static build on Cloudflare's free tier is enough ([0009](0009-hosting-and-budget.md)). Next.js would only earn its place for server rendering or SEO pages.

## Consequences

- Both clients render the same style (`packages/map-style`) with the same renderer, so mappers see what the public will see. The web uses MapLibre GL JS directly. The mapper app runs maplibre-gl-js with terra-draw inside an Expo DOM component, which also gives it polygon editing. `@maplibre/maplibre-react-native` v11 is kept as the fallback for read-only views.
- Routing is one TypeScript router in `packages/routing`, imported by both `apps/web` and `apps/mapper`. There is no port to keep in step ([0003](0003-routing.md)).
- Builds no longer need a Mac: iOS builds run on EAS Build or GitHub macOS runners, and a rented cloud Mac is the escape hatch. The native boundary, the build and debug loop, and the Phase 1 spike that tests all of this are in [0007](0007-expo-mapper-app.md).
- Capture still needs a LiDAR device. The owner captures with an iPhone 17 Pro Max.
- The moderation UI ships in the public webapp's bundle as an authenticated route. The API enforces access, not the client, so the bundle holds no secrets and no private data.
