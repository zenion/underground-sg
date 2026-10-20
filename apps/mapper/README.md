# @usg/mapper

The mapper app ([ADR 0007](../../docs/decisions/0007-expo-mapper-app.md)): Expo SDK 57, TypeScript, Expo Router, React Native's New Architecture. It runs in the App Store's **Expo Go** for the map and the floor-plan benchmark, and in the app's own **development build** (`eas build --profile development`, then `pnpm dev:phone --dev-client`, [docs/phone-testing.md](../../docs/phone-testing.md)) for everything native: LiDAR capture needs the Swift module `capture-native`, which Expo Go can't load (below).

| Tab | What it does | In Expo Go |
| --- | --- | --- |
| Map | The published map from the API over OneMap's street map, with the webapp's style (`@usg/map-style`), a level switcher and a demo badge, and polygon and point drawing on top: maplibre-gl v6 and terra-draw in an Expo DOM component (a WebView). The count of drawn features lives in the native screen. The map is mounted only while its tab is showing, so it is gone on the Capture screen (ADR 0007) | Yes (tiles and the published map need a connection) |
| Floor plan | Runs `@usg/floorplan` on a synthetic corridor generated on the phone (about 25k, 106k or 1.1M triangles) and shows each stage's time and the plan. This is the Hermes measurement for spike criterion 4 | Yes |
| Capture | The `capture-native` module's checks (ARKit's LiDAR and tracking support, video formats) and a camera check: the camera with the live mesh, Start and Stop, and the module's 5 Hz status. Also the device, whether LiDAR is expected on it, and whether the map is unmounted | Explains that capture needs a development build |
| About | App and SDK versions, the JavaScript engine (Hermes check), the API base URL and whether `GET /health` answers | Yes |

## Run it on the iPhone with Expo Go (from Windows)

The easiest way: `pnpm dev:phone` at the repo root starts the API and Metro (on loopback, `--localhost`) behind two endpoints of one ngrok agent, Metro's with its debugger refused at ngrok's edge, with `EXPO_PUBLIC_API_URL` and `EXPO_PACKAGER_PROXY_URL` set, so the phone needs neither the LAN nor a firewall rule ([docs/phone-testing.md](../../docs/phone-testing.md)). The rest of this section is the LAN route, and the once-only setup both need.

Once:

1. Install **Expo Go** from the App Store on the iPhone. Its App Store build supports SDK 57 (version 57.0.9, 2026-09-02).
2. Create a free Expo account at <https://expo.dev/signup>. Since 2026-09-03 Expo Go on iOS opens a project from a dev server only when Expo CLI and Expo Go are signed in to the same account ([changelog](https://expo.dev/changelog/expo-go-57-login)). Sign in on the phone (Expo Go, Home, the avatar at the top right) and on the PC:

   ```bash
   pnpm --filter @usg/mapper exec expo login
   ```

3. `pnpm install` at the repo root.

Each time:

1. Put the phone and the PC on the same Wi-Fi network (not a guest network, which usually keeps devices apart).
2. At the repo root:

   ```bash
   pnpm mapper
   ```

   That is `pnpm --filter @usg/mapper start --go` (`pnpm --filter @usg/mapper start -- --go` works too). `--go` matters: expo-dev-client is installed, so without it Expo CLI serves the project to a development build instead.
3. The first time, Windows Firewall asks whether Node.js may use the network: allow it on **private** networks. If the home Wi-Fi is set as a public network in Windows, set it to private.
4. Scan the QR code in the terminal with the iPhone's Camera app and open it in Expo Go. iOS asks Expo Go for **Local Network** access the first time: allow it.

If the phone can't reach the PC on the LAN (the QR code opens but loading times out), try the LAN fixes first: the Wi-Fi set as a **private** network in Windows, the Windows Firewall rule for Node.js (`node.exe`) allowed on private networks, both devices on the same Wi-Fi and not a guest network, and Local Network access for Expo Go in the iPhone's Settings, Privacy & Security. Only then use Expo's tunnel, knowing what it exposes (below), or `pnpm dev:phone`:

```bash
pnpm mapper --tunnel
```

The first time, Expo CLI asks to install `@expo/ngrok` globally, and a yes runs `npm install -g @expo/ngrok@^4.1.0`: npm, outside the repo's pnpm checks (`minimumReleaseAge`, `trustPolicy`, no install scripts), with whatever versions of its dependencies npm resolves that day, plus ngrok's own closed-source agent binary. Say yes only knowingly. Installing a pinned version yourself first, which Expo CLI then finds, narrows that: `npm install -g @expo/ngrok@4.1.3` (published 2023-11-17, BSD-2-Clause, no install scripts), though its own dependencies (`got`, `uuid`, `yaml`) still come from caret ranges. Through a tunnel the app can't derive the API's address, so set `EXPO_PUBLIC_API_URL` (below). Expo's tunnel forwards all of Metro to anyone with its `exp.direct` address, and every request through it reaches Metro from loopback, which Metro and Expo CLI trust as the PC: the debugger (which runs code in the app on the phone), opening files in the PC's editor and symbolication included, over plain HTTP. Keep the address to yourself and stop Metro when done; `pnpm dev:phone` doesn't use Expo's tunnel for these reasons ([ADR 0009](../../docs/decisions/0009-hosting-and-budget.md#remote-access-during-phases-13)). Expo CLI 57 on Windows doesn't find a global `@expo/ngrok` by itself (it runs `npm.cmd` without a shell, which Node refuses, and looks under `%LOCALAPPDATA%\npm`), so `pnpm mapper --tunnel` asks to install it again; npm's global folder (`npm root -g`) on `NODE_PATH` for that command works around it. Metro inside WSL needs mirrored networking or `--tunnel` too; run it on Windows-native Node.

JavaScript changes reach the phone by Fast Refresh while Metro runs. Shake the phone for Expo Go's developer menu (reload, performance monitor).

### What to look at tomorrow

- **Map:** the published map shows under the drawing tools ("DEMO DATA · Map version 1 · …" under the hint), with the level switcher above the attribution; with no map published it says so, and without the API it says it can't reach it, with Retry. Pan and zoom, draw a polygon (tap the corners, then tap the first or last corner to finish), add a point, then Edit: tap a shape and drag a corner, a midpoint or the whole shape, and Delete. The count above the map follows. Switch to Capture and back: the map reloads and the shapes come back. This is the phone half of the backlog's Done-when for the map; desktop Chrome is below.
- **Floor plan:** the big number is the floor-plan total in Hermes on the iPhone 17 Pro Max; run each size a few times and note the medians. The backlog's threshold is about 2 s (on a recorded mesh, which comes with the capture module). The time grows with the triangle count, and how many floor triangles ARKit makes per m² isn't known yet, so **Dense** (the realistic layout as 5 cm squares, 1.1M triangles) shows how much margin a fine mesh would leave; generating it takes a moment and is shown apart. For reference: Node with its JIT takes about 12 ms on the realistic mesh and 37 ms on the dense one, `node --jitless` about 215 ms and 834 ms (`packages/floorplan/README.md`), and a desktop Chromium browser about 26 ms on the realistic mesh with `pnpm --filter @usg/mapper web`. Expo Go runs a development bundle (`__DEV__` on), compiled to Hermes bytecode by Metro.
- **Capture:** the model, iOS version and the LiDAR line. If iOS is 26.4 to 26.6.0 the screen warns about the LiDAR drift regression (CLAUDE.md).

## Desktop Chrome

```bash
pnpm --filter @usg/mapper web
```

opens the whole app at <http://localhost:8081>. The map is the same DOM component, rendered in the page, so drawing and editing work with the mouse.

## What needs a development build

- The `capture-native` Swift module ([modules/capture-native/README.md](modules/capture-native/README.md)): ARKit, and later the keyframes, blur, bundle writer and recorder. Expo Go runs only the native code it ships with.
- A development build needs the Apple Developer Program membership (US$99 a year), an Expo account, the phone registered with `eas device:create`, and Developer Mode on the phone. Then `eas build --profile development --platform ios` with the `development` profile in `eas.json` (`developmentClient: true`, internal distribution). `expo-dev-client` is already installed; Expo Go ignores it.
- **Walks use the walk build**, not the development build: the same capture module in release configuration, without the dev client, with the JavaScript embedded (EAS internal distribution), so a capture in a venue needs no Metro, no tunnel and no signal ([ADR 0010](../../docs/decisions/0010-capture-recording-and-replay.md)). Both builds compile the session recorder, but only the walk build records; the `walk` profile is a backlog task.
- **Bundle identifier:** `com.xennion.usg.mapper`, from the owner's domain (confirmed 2026-10-17). It can't change once the app is registered with Apple. `NSCameraUsageDescription` and `NSLocalNetworkUsageDescription` are placeholders for that build; Expo Go uses its own.

## The capture port and the walk flow

The session recorder's TypeScript side (the lean recorder design's PR4, [ADR 0010](../../docs/decisions/0010-capture-recording-and-replay.md)), ready for the native glue and the walk screen:

- **`src/capture/native.ts`**: the `CaptureNative` port. `moduleCaptureNative(CaptureNative)` adapts the module object; it is null in Expo Go and on the web. Builds before the native glue have no `CaptureSession` class, so `openSession()` is null, `listRecordings()` empty and the recorder calls reject with `ERR_RECORDER_NOT_COMPILED`, as the module does without the recorder. The module's types, `CaptureSession` included, are in `modules/capture-native/src/types.ts`. The screens use the port, never the module directly.
- **`src/capture/redacted.ts`**: every session time and pose (`t`, a mark's hit, facing and camera, a tag's position and camera) reaches the app as a `Redacted` value. `String()`, a template literal, `JSON.stringify`, Node's `util.inspect` and React Native's console all give `[redacted]`; only `unwrap()` reads it, and only the code that uses the value calls it.
- **`src/capture/boundary-trace.ts`**: the boundary trace ([session-recording.md](../../docs/session-recording.md), `boundary.jsonl`). The adapter records every session event and result before it wraps anything; the trace holds lines until the window opens (the last 2 s, at most 256 lines), numbers them from 0 at the open, and sends them to `appendBoundary` every second, at 64 lines, when the app's state changes, and with `final` when the recording finalizes and before stop or discard. Values are JSON text with sorted keys, bounded to 16,384 code points (else the too-large marker). The recorder's plumbing gets no line.
- **`src/capture/log-guard.ts`**: in the walk build, from launch (`_layout.tsx`), every `console` method and `nativeLoggingHook` do nothing, and an uncaught error reaches React Native's handler as "[redacted capture error]" with only its stack frames. In other builds it does nothing.
- **The no-pose lint** (`scripts/no-pose-logging.mts`, run by `test/no-pose-logging.test.ts`): no `console.*` call, `Error` construction, `.message` or `.stack` assignment, `throw` or template literal in `src/` or the module's TypeScript may mention a pose, transform, camera, hit, position, GNSS, facing, raw or session-time name, a name declared `Redacted`, `SessionTime` or one of the module's raw `Native…` types, or `unwrap`; `console` is never read into another name; and the app never imports a `node:` module. It works on names, not inferred types, so the adapter declares its raw values with their `Native…` types. The rule is in the script's header; the test plants cases that must fail. Rename a variable that only sounds like one rather than adding an exemption.
- **`src/walk/`**: the walk flow as a pure reducer (`flow.ts`: venues, record Off or Lean, permissions, Start, Mark start with the street-facing toggle, tags, Mark end or Mark end and end the session here after a 5 s hold-still countdown timed from the tap, Saving, the summary), the corridor's venues with the seed's ids (`venues.ts`, checked against `db/seed/core-venues.ts`) and the minimal node tag row (`tags.ts`).

## Configuration

The API base URL is the dev server's host (the PC that serves the JavaScript, from `expo-constants` `hostUri`) with port `EXPO_PUBLIC_API_PORT`, default 28000. `EXPO_PUBLIC_API_URL` replaces it, for example through a tunnel or for another machine; `pnpm dev:phone` sets it to the ngrok domain. The Map tab loads the published map from `<api>/public/latest.json` and the version files it names, and the glyphs from `<api>/glyphs/`; the API lets any origin read those, so the map's WebView, served by Metro, can. Put `EXPO_PUBLIC_` variables in `apps/mapper/.env.local` (git-ignored) or the shell, then restart Metro (it doesn't watch `.env` files: `metro.config.js` blocks them). A production bundle (`expo export`, `pnpm build`) inlines their values; `metro.config.js` puts them in Metro's cache key, so an export after a change never reuses code with the old value.

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.20:28000
```

When the API exists it has to listen on all interfaces (not only `localhost`), and Windows Firewall has to let its port through, for the phone to reach it.

## Scripts

| Script | What it does |
| --- | --- |
| `start` | Metro (`expo start`); add `--go` for Expo Go |
| `web` | The app in a browser |
| `build` | `expo export --platform ios` into `dist/ios`: the Hermes bytecode bundle and the map's DOM-component bundle. Proves the JavaScript compiles; `pnpm build` at the root and CI run it |
| `build:web` | `expo export --platform web` into `dist/web` |
| `typecheck` | `tsc` |
| `test` | Vitest on the pure logic in `test/` (API URL, health check, features, the benchmark, SVG paths, loading and checking the published map, the level bands and the camera, device checks, the capture port, `Redacted`, the boundary trace against the recording schema, the log guard, the walk flow, venues and tags), the no-pose lint over the source, and `metro.config.js` (what Metro may read, the cache key) |

Each script except `test` first runs `scripts/maplibre-worker.mts`. maplibre-gl v6 finds its worker script next to its own module (`import.meta.url`), which a Metro bundle doesn't have, so the script copies `maplibre-gl/dist/maplibre-gl-worker.mjs` into the git-ignored `src/map/generated/maplibre-worker.ts` as a string, and the map hands it to `setWorkerUrl()` as a `blob:` URL. That works the same over the LAN, through a tunnel, in a browser and from `file://` in a release build.

## Layout

```
app.config.ts, eas.json, metro.config.js (what Metro may read, and its cache key)
native-dependencies.json   the reviewed native packages (ADR 0010), checked against autolinking
modules/capture-native/    the Swift module: its README has the layout and how it is tested
scripts/maplibre-worker.mts, encoder-check.mts (and -lib): the macOS CI job's encoder check;
                           no-pose-logging.mts: the no-pose lint, run by its test
src/
  app/            Expo Router tabs: _layout, index (Map), floorplan, capture, about
  map/            draw-map.tsx (the DOM component), published.ts (loads and checks the published
                  map), bands.ts (the level switcher's bands), camera.ts, features.ts, worker.ts,
                  presence.ts (counts mounted maps)
  floorplan/      the on-phone benchmark and SVG paths
  capture/        device checks, the wording of the module's status, the CaptureNative port
                  (native.ts), Redacted, the boundary trace and the walk build's log guard
  walk/           the walk flow reducer, the corridor's venues, the tag row
  about/          API URL, health check, JavaScript engine
  config.ts       reads EXPO_PUBLIC_ variables
test/             Vitest
```

The style is `@usg/map-style`'s, the webapp's: OneMap's Grey HD tiles, the indoor and street layers with the level filter (`applyBand`), the glyphs, and OneMap's, OpenStreetMap's and LTA's attribution, expanded on every screen size (CLAUDE.md). `src/map/published.ts` checks the files by hand, for what the style and the switcher read, so Ajv and the Node validators stay out of the bundle; `checkLatestPointer` from `@usg/contracts` keeps the version files under their own `snapshots/<sha256>/` directory. A 404 counts as "no map published" only when it is the API's own JSON one, not a tunnel's error page.

## Versions

Expo SDK 57 (React Native 0.86.3, React 19.2.3). Dependencies are pinned to exact versions installed with the SDK's expected ranges, but a few Expo packages sit a patch or two behind the newest: pnpm's supply-chain settings in `pnpm-workspace.yaml` refuse versions under a day old, and refuse a version with weaker publish trust than an earlier one. Expo SDK 58 moved to trusted publishing on 2026-09-29, and SDK 57 patches published since then have no provenance, so pnpm reads them as possible takeovers. `expo-doctor` therefore reports patch mismatches for `expo`, `expo-router`, `expo-constants`, `expo-linking`, `expo-dev-client` and `@expo/metro-runtime`; Expo Go only needs the SDK's major version to match. `react-native-reanimated`, `react-native-worklets` and `react-native-gesture-handler` (2.32.0) are direct dependencies although the app doesn't import them yet: they are peers of Expo Router (the last through its drawer), and pnpm would otherwise install their newest versions as peers (gesture-handler 3.3.0, where SDK 57 expects ~2.32.0), which autolinking would then compile into the first development build. `typescript` is excluded from Expo's version check because the workspace uses TypeScript 7 (`catalog:`), while Expo expects 6; Babel strips the types when Metro bundles, so Expo never runs `tsc`.
