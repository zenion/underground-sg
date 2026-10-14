# @usg/mapper

The mapper app ([ADR 0007](../../docs/decisions/0007-expo-mapper-app.md)): Expo SDK 57, TypeScript, Expo Router, React Native's New Architecture. For now it is a shell that runs in the App Store's **Expo Go**, because there is no Apple Developer account yet and so no development build. LiDAR capture needs the Swift module `capture-native`, which needs a development build (below).

| Tab | What it does | In Expo Go |
| --- | --- | --- |
| Map | OneMap tiles around City Hall MRT, with polygon and point drawing: maplibre-gl v6 and terra-draw in an Expo DOM component (a WebView). The count of drawn features lives in the native screen. The map is mounted only while its tab is showing, so it is gone on the Capture screen (ADR 0007) | Yes (tiles need a connection) |
| Floor plan | Runs `@usg/floorplan` on a synthetic corridor generated on the phone (about 25k, 106k or 1.1M triangles) and shows each stage's time and the plan. This is the Hermes measurement for spike criterion 4 | Yes |
| Capture | Looks for the `CaptureNative` module and shows the device, whether LiDAR is expected on it, and whether the map is unmounted | Explains that capture needs a development build |
| About | App and SDK versions, the JavaScript engine (Hermes check), the API base URL and whether `GET /health` answers | Yes (the API doesn't exist yet, so "not reachable" is expected) |

## Run it on the iPhone with Expo Go (from Windows)

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

If the phone can't reach the PC on the LAN (the QR code opens but loading times out), try the LAN fixes first: the Wi-Fi set as a **private** network in Windows, the Windows Firewall rule for Node.js (`node.exe`) allowed on private networks, both devices on the same Wi-Fi and not a guest network, and Local Network access for Expo Go in the iPhone's Settings, Privacy & Security. Only then use Expo's tunnel:

```bash
pnpm mapper --tunnel
```

The first time, Expo CLI asks to install `@expo/ngrok` globally, and a yes runs `npm install -g @expo/ngrok@^4.1.0`: npm, outside the repo's pnpm checks (`minimumReleaseAge`, `trustPolicy`, no install scripts), with whatever versions of its dependencies npm resolves that day, plus ngrok's own closed-source agent binary. Say yes only knowingly. Installing a pinned version yourself first, which Expo CLI then finds, narrows that: `npm install -g @expo/ngrok@4.1.3` (published 2023-11-17, BSD-2-Clause, no install scripts), though its own dependencies (`got`, `uuid`, `yaml`) still come from caret ranges. Through a tunnel the app can't derive the API's address, so set `EXPO_PUBLIC_API_URL` (below). Metro inside WSL needs mirrored networking or `--tunnel` too; run it on Windows-native Node.

JavaScript changes reach the phone by Fast Refresh while Metro runs. Shake the phone for Expo Go's developer menu (reload, performance monitor).

### What to look at tomorrow

- **Map:** pan and zoom, draw a polygon (tap the corners, then tap the first or last corner to finish), add a point, then Edit: tap a shape and drag a corner, a midpoint or the whole shape, and Delete. The count above the map follows. Switch to Capture and back: the map reloads and the shapes come back. This is the phone half of the backlog's Done-when for the map; desktop Chrome is below.
- **Floor plan:** the big number is the floor-plan total in Hermes on the iPhone 17 Pro Max; run each size a few times and note the medians. The backlog's threshold is about 2 s (on a recorded mesh, which comes with the capture module). The time grows with the triangle count, and how many floor triangles ARKit makes per m² isn't known yet, so **Dense** (the realistic layout as 5 cm squares, 1.1M triangles) shows how much margin a fine mesh would leave; generating it takes a moment and is shown apart. For reference: Node with its JIT takes about 12 ms on the realistic mesh and 37 ms on the dense one, `node --jitless` about 215 ms and 834 ms (`packages/floorplan/README.md`), and a desktop Chromium browser about 26 ms on the realistic mesh with `pnpm --filter @usg/mapper web`. Expo Go runs a development bundle (`__DEV__` on), compiled to Hermes bytecode by Metro.
- **Capture:** the model, iOS version and the LiDAR line. If iOS is 26.4 to 26.6.0 the screen warns about the LiDAR drift regression (CLAUDE.md).

## Desktop Chrome

```bash
pnpm --filter @usg/mapper web
```

opens the whole app at <http://localhost:8081>. The map is the same DOM component, rendered in the page, so drawing and editing work with the mouse.

## What needs a development build

- The `capture-native` Swift module (ARKit, keyframes, blur, bundle writer): Expo Go runs only the native code it ships with.
- A development build needs the Apple Developer Program membership (US$99 a year), an Expo account, the phone registered with `eas device:create`, and Developer Mode on the phone. Then `eas build --profile development --platform ios` with the `development` profile in `eas.json` (`developmentClient: true`, internal distribution). `expo-dev-client` is already installed; Expo Go ignores it.
- **Confirm the bundle identifier** in `app.config.ts` (`com.zenion.usg.mapper` is a placeholder) before the first EAS build: it can't change once the app is registered with Apple. `NSCameraUsageDescription` and `NSLocalNetworkUsageDescription` are placeholders for that build; Expo Go uses its own.

## Configuration

The API base URL is the dev server's host (the PC that serves the JavaScript, from `expo-constants` `hostUri`) with port `EXPO_PUBLIC_API_PORT`, default 28000. `EXPO_PUBLIC_API_URL` replaces it, for example through a tunnel or for another machine. Expo inlines `EXPO_PUBLIC_` variables when it bundles: put them in `apps/mapper/.env.local` (git-ignored) or the shell, then restart Metro.

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
| `test` | Vitest on the pure logic in `test/` (API URL, health check, features, the benchmark, SVG paths, the OneMap style, device checks) |

Each script except `test` first runs `scripts/maplibre-worker.mts`. maplibre-gl v6 finds its worker script next to its own module (`import.meta.url`), which a Metro bundle doesn't have, so the script copies `maplibre-gl/dist/maplibre-gl-worker.mjs` into the git-ignored `src/map/generated/maplibre-worker.ts` as a string, and the map hands it to `setWorkerUrl()` as a `blob:` URL. That works the same over the LAN, through a tunnel, in a browser and from `file://` in a release build.

## Layout

```
app.config.ts, eas.json
scripts/maplibre-worker.mts
src/
  app/            Expo Router tabs: _layout, index (Map), floorplan, capture, about
  map/            draw-map.tsx (the DOM component), style.ts (OneMap style and attribution),
                  features.ts, worker.ts, presence.ts (counts mounted maps)
  floorplan/      the on-phone benchmark and SVG paths
  capture/        device checks
  about/          API URL, health check, JavaScript engine
  config.ts       reads EXPO_PUBLIC_ variables
test/             Vitest
```

`src/map/style.ts` is the only place that knows the base style, so `@usg/map-style` can replace it. The OneMap tile URL and attribution come from <https://www.onemap.gov.sg/docs/maps/> (checked 2026-10-15); the attribution keeps OneMap's wording and logo, with the logo's size as attributes because MapLibre v6 strips `style` attributes from attribution HTML. OpenStreetMap and LTA attribution are shown too (CLAUDE.md).

## Versions

Expo SDK 57 (React Native 0.86.3, React 19.2.3). Dependencies are pinned to exact versions installed with the SDK's expected ranges, but a few Expo packages sit a patch or two behind the newest: pnpm's supply-chain settings in `pnpm-workspace.yaml` refuse versions under a day old, and refuse a version with weaker publish trust than an earlier one. Expo SDK 58 moved to trusted publishing on 2026-09-29, and SDK 57 patches published since then have no provenance, so pnpm reads them as possible takeovers. `expo-doctor` therefore reports patch mismatches for `expo`, `expo-router`, `expo-constants`, `expo-linking`, `expo-dev-client` and `@expo/metro-runtime`; Expo Go only needs the SDK's major version to match. `react-native-reanimated`, `react-native-worklets` and `react-native-gesture-handler` (2.32.0) are direct dependencies although the app doesn't import them yet: they are peers of Expo Router (the last through its drawer), and pnpm would otherwise install their newest versions as peers (gesture-handler 3.3.0, where SDK 57 expects ~2.32.0), which autolinking would then compile into the first development build. `typescript` is excluded from Expo's version check because the workspace uses TypeScript 7 (`catalog:`), while Expo expects 6; Babel strips the types when Metro bundles, so Expo never runs `tsc`.
