# @usg/web

The public webapp: the published underground map over OneMap's street map, with a level switcher. A Vite + React single-page app with MapLibre GL JS 6 and the shared style in [`packages/map-style`](../../packages/map-style/README.md), built to static files for Cloudflare Pages ([0009](../../docs/decisions/0009-hosting-and-budget.md)). It reads the public map files the way [docs/snapshot-format.md](../../docs/snapshot-format.md) describes and never talks to the database.

## Running it

From the repo root:

```bash
pnpm web            # the dev server, with /public, /api and /map proxied to the API
pnpm web:fixtures   # fixture mode: a built-in demo snapshot, no API needed
```

Both serve http://localhost:5173 (the port is fixed: if it's taken, Vite stops rather than picking another).

- **`pnpm web`** proxies `/public/*`, `/api/*` and `/map/*` to the API, `services/api`, at `http://127.0.0.1` on the API's own port: `API_PORT` from the repo root's `.env`, 28000 when unset ([`plugins/api.ts`](plugins/api.ts)). The API serves the public bucket read-only at `GET /public/<key>`, standing in for Cloudflare ([snapshot-format.md](../../docs/snapshot-format.md#layout)). Set `VITE_API_URL` to use another address. Without the API the page shows "Can't reach the map server" (the proxy answers 502), and before the first publish "No map published yet" (the API answers 404 for `latest.json`).
- **`pnpm web:fixtures`** answers `/public/` itself with a small demo version from [`fixtures/demo-snapshot.ts`](fixtures/demo-snapshot.ts): synthetic features at real City Hall cluster coordinates (Funan's B1 and B2, a link to a City Hall MRT concourse, three exits), extending the examples in `packages/contracts`, with `demo: true` so the page shows its demo banner, and a `status.json` that closes one escalator and Exit B. `WEB_FIXTURE` picks another answer, to see the page's other states:

  | `WEB_FIXTURE` | `/public/` answers | The page shows |
  | --- | --- | --- |
  | `demo` (default) | the demo version | the map, with the demo banner |
  | `empty` | 404 for everything | No map published yet |
  | `down` | 503 for everything | Can't reach the map server |
  | `html` | an HTML page for `latest.json` | The map data couldn't be read |
  | `outdated` | `latest.json` with `schema_version` 2 | This page is out of date (reload) |

  In PowerShell: `$env:WEB_FIXTURE = "empty"; pnpm web:fixtures` (and `Remove-Item Env:WEB_FIXTURE` afterwards). In Git Bash: `WEB_FIXTURE=empty pnpm web:fixtures`.

Settings can also go in `apps/web/.env.local`, which is git-ignored:

```bash
VITE_HOST=true                      # listen on the LAN (see below)
VITE_API_URL=http://127.0.0.1:28000 # where pnpm web proxies /public, /api and /map (else API_PORT)
WEB_FIXTURE=demo                    # fixture mode's answer
```

### On a phone over home Wi-Fi

The phone and the PC must be on the same network.

```bash
pnpm web:fixtures --host    # or: pnpm web --host
```

Then open the Wi-Fi's address in Safari on the iPhone, such as `http://192.168.1.23:5173/`. Vite prints one `Network:` address per network adapter: use the one `ipconfig` lists under the Wi-Fi adapter. The others belong to `vEthernet` adapters (WSL, Hyper-V), which the phone can't reach. `--host` (or `VITE_HOST=true`) makes the server listen on every address; `VITE_HOST=192.168.1.23` listens on that one only.

**Let the phone through Windows Defender Firewall first.** If the PC's Wi-Fi has the Public network profile (`Get-NetConnectionProfile` shows it), the firewall blocks the phone, and it may not ask: its "allow access" prompt appears only where notifications are on, and they can be off. Safari then just times out. Either:

- Allow the dev server's port from the local network only. In an administrator PowerShell:

  ```powershell
  New-NetFirewallRule -DisplayName "Underground SG web dev" -Direction Inbound -Protocol TCP -LocalPort 5173 -RemoteAddress LocalSubnet -Profile Public -Action Allow
  ```

  and when you're done: `Remove-NetFirewallRule -DisplayName "Underground SG web dev"`.
- Or set the home Wi-Fi to Private: Settings > Network & internet > Wi-Fi > the network's properties > Network profile type: Private network. Check what the Private profile allows first (`Get-NetFirewallProfile -Name Private`): if its firewall is off, every port the PC listens on is then open to the network.

Also:

- The camera position and the level band are kept in the address (`#map=zoom/lat/lon&level=-2`), so a reload (iOS Safari reloads tabs it has put away) or a bookmark keeps the view and the band. A band the loaded version doesn't have shows the street band instead.
- Over `http://` on the LAN the page is not a secure context. Nothing in it needs one today; locating with the camera (Phase 4) will need HTTPS.

## Building

```bash
pnpm build                          # from the root: every package's build, this one's included
pnpm --filter @usg/web build        # this one only
pnpm --filter @usg/web preview      # serve dist/ on http://localhost:4173, proxying like pnpm web
pnpm --filter @usg/web exec vite preview --mode fixtures   # dist/ with the demo snapshot
```

`dist/` holds `index.html`, hashed JavaScript and CSS in `assets/` (MapLibre in a chunk of its own, and its worker as a separate module file), and the glyphs under `glyphs/`. On 2026-10-15 the build was about 2.1 MB, 0.5 MB gzipped: the app with React 250 kB (78 kB gzipped), MapLibre 1.03 MB (275 kB) and its CSS 83 kB (10 kB), the worker 508 kB (143 kB), and the glyphs 268 kB, fetched one range at a time as labels need them.

`VITE_PUBLIC_BASE` sets where the built page looks for the public map files: a path on the same origin (the default, `/public`) or an `https://` URL such as the R2 bucket's, which must then allow the page's origin through CORS. It is read at build time.

## How it works

| Path | What it does |
| --- | --- |
| `src/data/load.ts` | `loadMap`: `latest.json`, then the version's `indoor.json` and `street.json` from the paths it gives, then `status.json`. The result is a `DataState`: `loading`, `no-version` (404 for `latest.json`), `unreachable` (a network error, or HTTP errors other than 404), `invalid` (not JSON, the wrong shape, a missing version file; `outdated` only for a higher integer `schema_version`, which a reload can fix) or `ready` |
| `src/data/shapes.ts` | Hand-written shape checks for the four files, so Ajv and the Node validators stay out of the bundle: every field the page or the style reads, with its type, enum and geometry. `latest.json`'s paths must be its version's own `snapshots/<sha256>/` files (`checkLatestPointer`), so a bad pointer can't send the page elsewhere. `status.json` must also pass `checkStatusOverlay` (one entry per feature, windows covering `generated_at`), or it counts as having no entries. The checks across the version's features (`checkIndoorSnapshot` and the others) only warn, in the console |
| `src/data/status.ts` | `status.json` narrowed to the loaded version's nodes and edges, for `applyStatus`. A missing or unreadable `status.json` is an empty one |
| `src/data/bands.ts` | The level switcher's bands, top to bottom: one per `ordinal`, the street band (0) always among them. A band's label is its levels' signed names ("B2 · Concourse"), ordered by `sort_key` then name, at most three; its description lists the levels by venue ("City Hall MRT Concourse · Funan B2") |
| `src/map/MapView.tsx` | The MapLibre map: the style from `createMapStyle` with empty sources (so the street map shows while the version loads, and when it can't), then, from `style.load` (not `load`, which waits for every OneMap tile in view), the version as the sources' data, `applyStatus` for closures and `applyBand` for the switcher. If MapLibre can't get a WebGL 2 context its constructor throws; `onError` reports it and the page says the browser can't draw the map. North-up and flat (no rotation or pitch). The attribution control is expanded on every screen size, with the level switcher and the zoom buttons stacked above it in the bottom-right corner, in reach of a thumb |
| `src/map/hash.ts` | The level band in the URL hash beside MapLibre's camera (`#map=18.5/1.2925/103.852&level=-2`), read at startup and on `hashchange`, written when the switcher changes; the street band leaves it out |
| `src/ui/ErrorBoundary.tsx` | The last resort around the page: any other exception shows "Something went wrong" with a Reload button, not a blank page |
| `src/map/camera.ts` | Opens on City Hall at zoom 17; zoom 11 to 21, within OneMap's bounds. Zoom 21 is past OneMap's last tile zoom (20 for HD tiles), so the basemap overzooms there |
| `plugins/glyphs.ts` | Serves `packages/map-style/glyphs` at `/glyphs/` in the dev server and copies the PBFs and `OFL.txt` into `dist/glyphs/` |
| `plugins/api.ts` | Where `pnpm web` proxies: `VITE_API_URL`, or `http://127.0.0.1` on the API's `API_PORT` |
| `plugins/fixtures.ts`, `fixtures/demo-snapshot.ts` | Fixture mode |

MapLibre GL JS 6 loads its worker from next to its own module by default, which the bundler moves, so `MapView.tsx` gives it the worker file's URL (`maplibre-gl/dist/maplibre-gl-worker.mjs?url`).

The page is mobile first: the map fills the screen, the page never scrolls, cards and controls keep clear of the notch and the home indicator (`viewport-fit=cover` and the safe-area insets), and the switcher's buttons are at least 44 px tall.

## Tests

`pnpm --filter @usg/web test` runs in Node: MapLibre needs WebGL, so the tests cover the logic, and the map itself is checked in a browser.

- `onemap-tiles.test.ts`: OneMap serves tiles as `Content-Type: image/undefined` with `nosniff`. The test runs MapLibre 6.14's own raster tile path (`RasterTileSource.loadTile`) against responses with those headers, with a stand-in decoder that goes by the bytes as a browser's does: a PNG is decoded and uploaded, an HTML page fails, an empty 200 becomes a transparent tile.
- `load.test.ts`, `shapes.test.ts`, `urls.test.ts`: loading against a fake server, every state and message, and the shape checks (including which `schema_version` values mean a newer format, and a `status.json` with two entries for one feature).
- `bands.test.ts`, `hash.test.ts`, `status.test.ts`, `camera.test.ts`: the switcher's bands and labels, the band to show for the one asked for, the band in the URL hash, what `applyStatus` is given, the camera limits, the glyph URL and the version line in Singapore time.
- `demo-snapshot.test.ts`: the demo passes `@usg/contracts/validators` (the schemas and the checks across files), `latest.json`'s sizes and hashes match the served files, and each edge's and street connector's `length_m` matches its line (measured in SVY21, plus the climb for stairs and escalators).
- `plugins.test.ts`: the glyph middleware (including requests that try to leave the directory), fixture mode's scenarios and the API proxy's target.

### Checking it in a browser

Run `pnpm web:fixtures` and open http://localhost:5173, at desktop size and at a phone's (390 px wide in the browser's device mode):

- OneMap's Grey tiles load, with OneMap's logo and all three attributions expanded at the bottom.
- The street band shows the exits labelled with their streets ("Exit B · North Bridge Road"), Exit B as a closed (hollow red) ring, and the other bands faded.
- Switching to "B2 · Concourse" draws Funan's B2 and the City Hall concourse in full and dims the basemap; the stairs from B2 to Exit B and the escalator from B2 to B1 show on both of their end bands; at zoom 18 and above the space and POI labels render ("Funan – City Hall link" uses the 8192-8447 glyph range; the Chinese in "Information · 询问处" is drawn with a local font).
- The network log shows `/glyphs/Noto%20Sans%20Regular/0-255.pbf` and `8192-8447.pbf` with 200 and no 404s, and at zoom 21 no tile requests above zoom 20.
- Choosing a band adds `&level=<ordinal>` to the address; a reload comes back on the same view and band, in the dev server too (React's development mode mounts the map twice, and the first map's `remove()` must not take the camera out of the address).
- With OneMap's tile requests made to hang (the page loaded in a same-origin iframe whose `fetch` never answers for `onemap.gov.sg/maps/tiles`), `map.loaded()` stays false, and the indoor features, the closures and the band from the address still draw.
- With `HTMLCanvasElement.prototype.getContext` returning null for WebGL in such an iframe, the page shows "This browser can't draw the map" with the header and a Reload button, and no uncaught error. An exception thrown while rendering shows "Something went wrong".

Checked on 2026-10-15 in the desktop app's browser (Chromium), at 800 x 600 and at 375 and 390 px wide, against the dev server and a production build; the last three checks on the dev server at 800 x 600, and the band after a reload on the production build too. Not yet checked in Safari.
