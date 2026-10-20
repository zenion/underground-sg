# Testing on the iPhone

How to try the webapp and the mapper app end to end on the iPhone 17 Pro Max, without an Apple Developer account: Safari for the webapp, and the App Store's **Expo Go** (SDK 57) for the mapper app. One command on the PC starts everything:

```bash
pnpm dev:phone
```

This is for testing at a desk. Captures in a venue use the walk build, whose JavaScript is embedded: no Metro, no tunnel and no signal needed underground. Never walk a venue with the app loaded through dev:phone: recordings and anything pose-bearing (poses, transforms, floor triangles, GNSS fixes) must never pass through Metro or a tunnel ([ADR 0010](decisions/0010-capture-recording-and-replay.md)). The development build connects through the same Metro endpoint with `pnpm dev:phone --dev-client` (below). Screenshots and screen recordings for a bug report, and anything shared with Claude Code, show only screens without the camera view: never share a screenshot of the capture view with an AI agent, and delete one if it gets taken (Recently Deleted too).

The PC's Wi-Fi has the Public network profile, so Windows Firewall blocks the phone on the LAN. Everything goes through ngrok instead, and the phone can be on any network, cellular included. One ngrok agent, signed in to the owner's paid account, runs two endpoints, both https, with request inspection off:

- **The API** on the owner's reserved domain (`NGROK_DOMAIN` in `.env`, for example `https://example.ngrok.app`), forwarding to `127.0.0.1:28000`. The API also serves the webapp's build there, so Safari, the public map files and the mapper app's map use one https origin.
- **Metro** on a random ngrok address that changes every run (`https://<random>.ngrok.app`), forwarding to Metro on this PC. ngrok's Traffic Policy refuses Metro's debugger and its other PC-only endpoints at ngrok's edge (below). Expo Go opens it as `exps://<random>.ngrok.app`; the app reaches the API through the reserved domain (`EXPO_PUBLIC_API_URL`).

Nothing else is exposed: the API, Metro, PostGIS and RustFS listen on this PC's loopback only, dev:phone checks on every run that nothing it started answers on the PC's network addresses, and the Vite dev server isn't started. Why it is set up this way, and what may and may not go through a tunnel: [ADR 0009](decisions/0009-hosting-and-budget.md#remote-access-during-phases-13).

## Before you start

On the PC, already done:

- Docker Desktop is installed. **Start it** and wait until it says Engine running.
- `.env` at the repo root has `NGROK_DOMAIN` set to your reserved ngrok domain. ngrok 3 is signed in to the paid account (its authtoken is in ngrok's own config; `ngrok config check` checks it). Expo's own tunnel and `@expo/ngrok` aren't used.
- Expo CLI is signed in: `pnpm --filter @usg/mapper exec expo whoami` prints `xennion`.

On the iPhone:

- Install **Expo Go** from the App Store (version 57, for SDK 57).
- In Expo Go, sign in to the **same Expo account** as the PC (`xennion`): Home, the avatar at the top right. Since 2026-09-03 Expo Go on iOS opens a project from a dev server only when Expo CLI and Expo Go are signed in to the same account.

## Start it

At the repo root, in Windows Terminal (PowerShell or Git Bash):

```bash
pnpm dev:phone
```

It takes a minute or two. In order, it:

1. checks Docker, and starts PostGIS and RustFS (`docker compose up -d --wait`) if they aren't running;
2. applies the migrations and creates the buckets (`pnpm migrate`, `pnpm buckets`), and checks that ngrok has its configuration and whether Expo CLI is signed in;
3. builds the webapp and starts the API on `127.0.0.1:28000`, serving the build at `/`;
4. publishes the demo map (`pnpm demo`) if no map is published yet, and only when the stack is on this PC;
5. starts ngrok with the API's endpoint and, when Expo CLI is signed in, Metro's, and waits until `https://<NGROK_DOMAIN>/health` answers through it;
6. starts Metro for Expo Go on `localhost:8081`, then checks through the tunnel that the app's manifest loads the JavaScript over https from the Metro endpoint, that ngrok refuses Metro's debugger, and that nothing answers on the PC's network addresses.

When everything runs, dev:phone prints a summary with a QR code:

```text
Ready to test on the iPhone

  Safari:   https://example.ngrok.app   (map version 1 (the demo map))
  Expo Go:  signed in as xennion on this PC; sign in to the same account in Expo Go.
            Scan this QR code with the iPhone's Camera app, or in Expo Go enter
            exps://0123456789ab.ngrok.app
            (https; a new address each run. Not Metro's exp:// address above: that is http.)
            The app reaches the API at https://example.ngrok.app.

  (the QR code)
  Logs:     .data/dev-phone
  Stop:     Ctrl+C here. It stops Metro, the tunnel and the API this started, nothing else.
```

Options: `pnpm dev:phone --clear` clears Metro's cache, and `pnpm dev:phone --no-demo` doesn't publish the demo map.

## In Safari

Open the Safari URL from the summary (`https://<NGROK_DOMAIN>`). This is the first time the webapp runs in real Safari, so note anything that looks wrong:

- The yellow **Demo data** banner at the top, and the card with "Street" and "Map version 1".
- OneMap's grey street map, with OneMap's logo and all three attributions (OneMap, OpenStreetMap, LTA) expanded at the bottom.
- On the street band, the exits with their streets ("Demo: Exit A · Stamford Road").
- The **level switcher** at the bottom right: Street, B1, B2 · Concourse. B2 · Concourse draws Funan's B2 and the City Hall concourse in full and dims the street map; zoom in (zoom 18 and up) for the space and POI labels ("Demo: Funan link", "Demo: ATM").
- The address keeps the view and the band (`#map=…&level=-2`): a reload comes back to the same place.
- Nothing hidden behind the notch or the home indicator; the switcher's buttons are easy to hit.

## In Expo Go

Open the app: scan the QR code dev:phone printed with the iPhone's **Camera** app and tap the banner to open it in Expo Go, or in Expo Go tap **Enter URL manually** and type the `exps://…ngrok.app` URL from the summary. Use that one, not the `exp://` address Metro prints itself: `exp://` is plain HTTP. The first load bundles the app through the tunnel, which takes up to a minute; shake the phone for Expo Go's menu (Reload).

- **Map:** the published map is under the drawing tools. Under the hint it shows **DEMO DATA · Map version 1 · 15 Oct 2026, 9:11 am**; the level switcher sits above the attribution, bottom right; labels render when you zoom in. The drawing tools work as soon as the map's style has loaded, before every tile is in. Draw a polygon (tap the corners, then the first or last corner to finish), add a point, then Edit (drag a corner, a midpoint or the whole shape) and Delete. The count at the top follows. Switch to Capture and back: the map reloads and the shapes come back. If the line says "Can't reach the API…" or "No map published yet", see Troubleshooting.
- **Floor plan:** run **Small 25k**, **Realistic 106k** and **Dense 1.1M** three times each. **Report back** the big "Floor plan total" for each run (or the median of each size), Dense's mesh-generation time, and whether the phone got warm. Expo Go runs a development bundle, so these are upper bounds; the backlog's threshold is about 2 s on a recorded mesh.
- **Capture:** says that LiDAR capture needs a development build (the Swift module isn't in Expo Go), and shows the model, the iOS version and the LiDAR line. If iOS is 26.4 to 26.6.0 it warns about the LiDAR drift regression.
- **About:** Running in Expo Go, JavaScript engine Hermes, Base URL `https://<NGROK_DOMAIN>` from EXPO_PUBLIC_API_URL, and **GET /health: OK**.

An error screen (LogBox) on the phone shows the stack without source lines: ngrok refuses Metro's `/symbolicate` from outside the PC. Metro's terminal on the PC shows the same error with its source. Debugging the app from the PC (React Native DevTools) doesn't work through the tunnel either, by design; use the LAN route in [apps/mapper/README.md](../apps/mapper/README.md) for that.

What to send back: anything wrong in Safari, the Floor plan numbers, whether the Map tab showed the published map and drawing worked, and the iOS and Expo Go versions (About shows the SDK; Expo Go's own version is in its Settings).

## With the development build

Once the development build is installed (EAS `development` profile, Developer Mode on), serve it instead of Expo Go:

```bash
pnpm dev:phone --dev-client
```

Everything else is the same: the API on the reserved domain, Metro on a random https address behind the same ngrok rules. The summary prints a QR code for the build's deep link (`exp+underground-sg://expo-development-client/?url=…`): scan it with the Camera app, or open **Underground SG Mapper** and in its launcher tap **Enter URL manually** and type the `https://…ngrok.app` address. No Expo sign-in is needed for the development build. Swift changes need a new build (`eas build --profile development --platform ios`; the first took about 5 minutes); TypeScript changes reload through Metro.

Both the development and the walk build compile the session recorder (`USG_RECORDER=1` in their `eas.json` profiles), but only the walk build records. The walk build (`eas build --profile walk`, [apps/mapper/README.md](../apps/mapper/README.md#the-build-profiles-and-the-recorder-switch)) is Release with its JavaScript embedded: it never connects to Metro or `dev:phone`, and installing it replaces the development build (the same bundle identifier) and keeps the app's data. Reinstall the development build to go back to desk testing, after exporting and copying off any recordings: the development build can't export them.

## Walks, recordings and the build checks

Two tabs serve the session recorder ([the lean recorder design](reviews/2026-10-21-lean-recorder-design.md), section 10; [ADR 0010](decisions/0010-capture-recording-and-replay.md)):

- **Walk**: the corridor walk. Venues, then record **Off** or **Lean** (Lean only when the build can record; otherwise it says why, with the module's refusal code), the motion and location permissions (Lean only), **Start**, **Mark start** with the street-facing toggle, the node tag row, then **Mark end** or **Mark end and end the session here** (hold the phone still for the 5 s countdown; the recording closes a few seconds later and the session stops by itself), Saving, and a summary of counts and durations. A red REC badge sits over the camera while the recording window is open. **Live mesh** turns the mesh drawing off and on; it is display only and changes nothing that is recorded. The tab bar is hidden while a session runs, so the map stays unmounted. On iOS 26.4 to 26.6.0 the screen warns about the LiDAR drift regression, but the walk can go ahead. The **Debug** card shows the module's figures (counts, rates, sizes and timings, never a position or a time of day), the boundary trace's counts, the module's log ring and the log check.
- **Recordings**: each recording's id, state, length, size, age in days and venues; **Export** (the walk build only) with its progress; **Delete**, after a confirmation; how to copy an export to the PC; the self-test; and what recovery did at launch.

Never take a screenshot or a screen recording of the Walk or Capture screen while the camera runs, and never share one with Claude Code. Report results as codes, counts and pass or fail.

### B2: the development build after the native glue

Built on EAS cloud (`pnpm --filter @usg/mapper exec eas build --platform ios --profile development`), then served with `pnpm dev:phone --dev-client`. At a desk:

1. **Refusals, with their codes.** Capture tab, Camera check: **Try Lean (must be refused)** shows `ERR_RECORD_REFUSED` with the refusal code (`debugBuild`, `notWalkBuild`, `notEmbedded` or `devClient`). Refusal checks: **Try an export** shows `ERR_EXPORT_REFUSED`, and **Try location** shows a code without iOS asking anything. On the Walk tab, Lean is disabled with the same reason.
2. **Never a location prompt.** iOS never asks for location, and Settings, Privacy & Security, Location Services doesn't list Underground SG Mapper.
3. **Status at 5 Hz with the delegate off the main thread.** Camera check, Start: the camera and the live mesh keep rendering and stay smooth, and the status rows update about five times a second. Debug, Show figures: the frame work p50 and p95 (about 0.3 ms or less) and the frame rate are there.
4. **Marks and tags at a desk.** Walk tab with record Off: Start, Mark start, a few tags, then Mark end and end the session here (the countdown, then the session stops). Every mark and tag resolves and the summary counts them; nothing on screen shows a position or a time. `ERR_NO_FLOOR_HIT` or `ERR_TRACKING` mean aim at the floor, or move slowly until tracking is normal, and mark again.
5. **The self-test.** Recordings, **Run the self-test**: passed; protection `completeUnlessOpen` while writing and `complete` after closing; excluded from backup; Compression and SHA-256 match; the MB/s figures; Documents holds `exports` or nothing.
6. **Heat and frame-gap baseline.** A 15-minute record-off session, walking around indoors: when the Thermal row reaches fair and serious, and from Debug, the frames skipped and the largest gap. The module doesn't send the memory figures to the Debug card yet.

JavaScript fixes after B2 reach the development build through `pnpm dev:phone --dev-client`. A walk build gets them only when it is built.

### W1: the first walk build

Built on EAS cloud by the owner, interactively, so it creates the signing credentials ([apps/mapper/README.md](../apps/mapper/README.md#the-first-walk-build-w1)). Later walk builds can run on a GitHub runner: Actions, **Walk build**, Run workflow (`.github/workflows/walk-build.yml`; it needs the `walk` environment with the owner as required reviewer and the `EXPO_TOKEN` secret in that environment). Review the first run's log before sharing anything about it. Check:

1. It installs over the development build, opens and runs a capture in airplane mode, has no dev menu (shake the phone) and makes no Metro connection.
2. Walk tab: Lean is enabled, and Start with Lean works (the REC badge appears at Mark start).
3. Documents holds only `exports/`: Apple Devices, Files, Underground SG Mapper (or the self-test's Documents row).
4. **The log check**, with the device log running (below) during a test capture: Debug, Show figures, **Log check**. The log must show no `usg-log-check` line. In the development build the same check does show the marker, which proves the check reaches the log. A `[redacted capture error]` line may appear in the walk build, if React Native logs the non-fatal error at all in a release build (only this check on the phone shows whether it does). The marker filter can't show that line: to look for it, run the check again with the log filtered to the app's process (below). If it appears, it must not hold the marker.
5. **A kept self-test, exported.** Recordings, **Run and keep it for export**, then Export it, copy it to the PC (below) and validate it with `--parts`. Claude Code may run the validator on it: its output is aggregate (counts, pass or fail).
6. **A short rehearsal recording at a public place** (the owner's call, design Q6): Mark start, Mark end, Mark end and end the session here. Then the variants: a background close (go to the Home Screen mid-recording: it closes as `background`), a Stop cut-back (Stop after an end mark: `stop`, cut back), and a force-quit mid-recording, which the next launch recovers as `interrupted` (Recordings, Recovery at launch). Export each, copy, validate on the PC, then delete them on the phone and in `.data/holding/`.
7. **Lock mid-recording.** The recording closes as `background`; after unlocking, its files read `complete` (the self-test's protection rows show the same classes).
8. **Heat.** A 15-minute Lean session against B2's record-off baseline: when the Thermal row reaches fair and serious, the frames skipped and the largest gap, and the recorder's Written and Write backlog figures.

### Copying a recording to the PC

Recordings never pass through Metro, a tunnel or a synced folder. With the walk build:

1. Recordings, **Export** the recording, one at a time, so `exports` holds only it. Keep the app open and the phone unlocked until it says Exported.
2. Connect the iPhone by USB and unlock it. Open the **Apple Devices** app on the PC, select the iPhone, then **Files**, then **Underground SG Mapper**.
3. In Explorer, create `.data\holding\<recording id>\` in the repo checkout (the id is on the recording's card).
4. Drag `exports` from Apple Devices straight into that folder. Never save it into Downloads, Documents, Desktop or a OneDrive folder: they are synced or backed up.
5. Validate it: `node packages/contracts/src/recording-validator/cli.ts --parts .data/holding/<recording id>/exports/replay-<recording id>`.
6. Only once that passes, **Delete** the recording on the phone (it removes the recording and its export there).

The Recordings screen shows the same steps with the recording's id filled in.

### Device logs and crash logs (pymobiledevice3)

[pymobiledevice3](https://github.com/doronz88/pymobiledevice3) reads the iPhone's log over USB from Windows (offline tooling, so Python is fine; `pipx install pymobiledevice3`). The Apple Devices app provides the USB driver. With the iPhone connected, unlocked and trusted:

- Live device log, filtered to the log check's marker: `pymobiledevice3 syslog live -m usg-log-check` (`pymobiledevice3 syslog live --help` lists the filters; without one it shows every process). It prints only lines that hold the marker, so in the walk build it prints nothing when the guard works, and nothing either if the check never reached the log: the development build's run, which does print the marker, is what shows the check reaches it.
- Live device log of the app's process, to look for a `[redacted capture error]` line: `pymobiledevice3 syslog live -pn <process name>`, with the app's process name as the unfiltered log shows it.
- Crash logs: `pymobiledevice3 crash pull .data/crash/` copies them into the git-ignored `.data/crash/`.

If a command asks for a tunnel (some services do on iOS 17 and later), start `pymobiledevice3 remote tunneld` in an administrator terminal first. Device logs and crash logs stay in `.data/` on the PC and are never pasted into a conversation with Claude Code: report only whether the marker appeared, and crash counts.

## Stop it

Press **Ctrl+C** in the terminal. Metro stops, then dev:phone stops ngrok and the API: every process it started, with their children, and nothing else (your own `node` or `ngrok` windows are left alone). The reserved domain then answers ngrok's "endpoint offline" page, and the Metro address is gone for good. PostGIS and RustFS keep running; `docker compose stop` stops them and keeps the data.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `NGROK_DOMAIN is not set` | Add `NGROK_DOMAIN=<your reserved domain>` to `.env` at the repo root. The authtoken never goes in `.env`: `ngrok config add-authtoken <token>` stores it in ngrok's own config |
| `ngrok has no valid configuration` | `ngrok config add-authtoken <token>` with the token from https://dashboard.ngrok.com, then `ngrok config check` |
| `Docker isn't running` | Start Docker Desktop, wait for Engine running, run `pnpm dev:phone` again |
| `Something already listens on 127.0.0.1:28000` or `on port 8081` | `pnpm api` or `pnpm mapper` (or an earlier dev:phone) is still running: stop it with Ctrl+C in its terminal |
| `https://… already answers: another ngrok agent holds the domain` | An ngrok you started yourself is still online with the domain: close it. dev:phone never stops processes it didn't start |
| `ngrok: …` lines, or `ngrok stopped while starting` | `ngrok config check`; check on https://dashboard.ngrok.com that the domain is yours and that the plan allows two endpoints (Hobbyist and up); https://status.ngrok.com. The details are in `.data/dev-phone/ngrok.log` |
| `Metro isn't running: Expo CLI isn't signed in` | `pnpm --filter @usg/mapper exec expo login` with the account Expo Go uses, then start dev:phone again. Safari still works meanwhile |
| `Metro isn't running: couldn't check the Expo sign-in: …` | `expo whoami` couldn't reach Expo's API (offline, DNS, an Expo outage, or `EXPO_OFFLINE` set). Safari still works; start dev:phone again when Expo answers |
| `Metro's manifest through the tunnel is wrong`, or `ngrok didn't refuse /json/version` | dev:phone stopped rather than serve the app over plain HTTP or with its debugger open. Something changed in Expo CLI or ngrok: report it, with the message |
| `Something answers on this PC's network address` | A process listens beyond loopback on the API's port or 8081 (perhaps one dev:phone didn't start): the LAN could reach it whenever the firewall lets it through. Find it (`netstat -ano`) and stop it |
| Expo Go won't open the project, or asks you to sign in | Sign in to Expo Go with the account `expo whoami` prints on the PC (`xennion`) |
| `Unable to resolve module …usg-wt-mapper…` | Metro's cache is shared with the other checkouts: `pnpm dev:phone --clear` |
| Map tab: "No map published yet" | Nothing is published: dev:phone publishes the demo map unless `--no-demo` was given or the stack isn't on this PC; run `pnpm demo` and tap Retry |
| Map tab: "Can't reach the API…"; About: not reachable; Safari: "Can't reach the map server" | Is dev:phone still running? Open `https://<NGROK_DOMAIN>/health` in Safari on the phone: JSON means the API is fine; ngrok's error page means the tunnel is down |
| The API stopped | The end of `.data/dev-phone/api.log` says why |

## What goes through the tunnel

- **The API's endpoint (the reserved domain):** only read-only routes: the webapp's files at `/`, `/public/*` (the public map files), `/glyphs/*`, `/health`, `/map/latest` and `/openapi.json`. Through the tunnel `/health` reports the checks without the software versions, which only the PC itself gets. TLS ends at ngrok's edge, so ngrok can see this traffic: acceptable for public map data, never for capture bundles, session recordings, anything pose-bearing or locate photos. No write route may be exposed this way until the owner's device-token auth exists (Phase 2). The domain is fixed, so anyone who knows it can read these routes while dev:phone runs: stop it when you're done.
- **Metro's endpoint (a random address per run):** Metro's development server, which serves the app's JavaScript and assets but also, to anything it takes for the PC, a debugger that runs code in the app on the phone. Every request through a tunnel reaches Metro from loopback, so Metro and Expo CLI would take it for the PC; ngrok's Traffic Policy therefore refuses, at ngrok's edge: anything but GET and HEAD; the debugger, its page list and DevTools (`/json`, `/inspector/debug`, `/inspector/network`, `/open-debugger`, `/debugger-frontend`, `/_expo/debugger`); opening files in the PC's editor (`/open-stack-frame`); symbolication (`/symbolicate`); the event stream with the app's console output (`/events`); `/status`; and Expo's dev pages and plugins (the full list is `METRO_LOCAL_ONLY_PATHS` in `scripts/dev-phone-lib.ts`). Metro's message socket stays open for the phone, but nothing through the tunnel can send it reload or dev-menu commands. Metro reads only the app, the packages it imports and `node_modules` (`apps/mapper/metro.config.js`), never `.env` files, `.data/` or `db/private/`. Anyone with the address can still download the app's development bundle, which holds the PC's paths, while dev:phone runs; the address changes every run.
- **Request inspection is off** for both endpoints, and ngrok's local web interface with it: ngrok's inspector keeps request bodies.
- **Logs** stay in the git-ignored `.data/dev-phone/` (`api.log`, `ngrok.log`, and `ngrok.yml`, the endpoint configuration dev:phone writes each run). They never hold the authtoken, and `ngrok.log` leaves out the visitors' IP addresses that ngrok logs for each connection.
