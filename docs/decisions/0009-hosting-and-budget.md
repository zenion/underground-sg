# 0009: Hosting on the owner's PC first, a small Singapore server in Phase 4

Status: accepted · 2026-10-12 · amended 2026-10-15, 2026-10-17

## Decision

The budget is as low as possible. No cloud server until Phase 4; only public files go to Cloudflare's free tiers before then. No GPU without the owner's explicit approval.

### Phases 1–3: the owner's PC

- PostGIS (`postgis/postgis:18-3.6`), the local S3 stand-in (RustFS, with SeaweedFS as the fallback), the API and the processing workers all run on the owner's Windows PC, under Docker Desktop with the WSL2 backend. PostGIS and RustFS are defined in `docker-compose.yml`, with their ports bound to 127.0.0.1; the multipart-upload task (Phase 2) opens RustFS's S3 port to the LAN for the phone. The root key pair in `.env.example` is public, so before that port leaves 127.0.0.1 the root credentials in `.env` are replaced with generated ones, and the API gets a non-root access key limited to the bundles bucket.
- RustFS holds three buckets, named in `.env.example`: raw capture bundles (private), the private full exports (private), and the public files (`indoor.json` and `street.json` per version, `latest.json`, `status.json`). Keeping public files in a bucket of their own means a public-read rule or a sync to R2 can never reach private data; in Phase 4 the private buckets move to S3 in ap-southeast-1 and the public one is R2. In Phase 2 a fourth private bucket, `usg-recordings`, takes the owner's session recordings over the LAN, never `usg-bundles` ([0010](0010-capture-recording-and-replay.md)); `pnpm buckets` creates it then.
- On the PC, the API stands in for Cloudflare: it serves the public bucket read-only at `GET /public/<key>`, only the files [snapshot-format.md](../snapshot-format.md#layout) lists, so no bucket gets a public-read rule. The webapp's dev server proxies `/public/` to it.
- In Phase 1, before the upload API exists, bundles and session recordings reach the PC over USB, exported to the app's Documents folder and pulled with `pnpm rec pull` ([0010](0010-capture-recording-and-replay.md)). From Phase 2 the phone uploads over home Wi-Fi on the LAN.
- Raw bundles and recordings hold trajectories, which are personal data ([0005](0005-privacy-by-design.md)), so the PostGIS and RustFS data and `.data/` (recordings and venue fixtures) on the PC sit on an encrypted disk (BitLocker, for example).
- Raw bundles, recordings, the private full exports and a database dump are backed up to an external drive or a cheap S3 bucket in ap-southeast-1, encrypted at rest either way. The backup script honours `pnpm rec delete`'s deletion list, and backup sets are kept at most 30 days, so a deleted recording leaves every backup within 30 days. Until the script exists, `.data/` is backed up only to the BitLocker-encrypted backup drive, never to OneDrive or another consumer cloud sync ([0010](0010-capture-recording-and-replay.md)).

### Remote access during Phases 1–3

Testing on the phone goes through tunnels, not the LAN: the PC's Wi-Fi has the Public profile, so Windows Firewall blocks the phone, and opening a port on the LAN would take a firewall rule per test. `pnpm dev:phone` sets it up ([phone-testing.md](../phone-testing.md)). It is for desk testing only (amended 2026-10-17):

- **Never for a walk.** Captures in a venue use the walk build, whose JavaScript is embedded: no Metro, no tunnel and no console forwarding, and no signal needed underground ([0010](0010-capture-recording-and-replay.md)). Session recordings and anything pose-bearing (poses, transforms, floor triangles, GNSS fixes, boundary traces) never go through a tunnel or Metro, and neither do capture bundles, anchor photos or locate photos.
- **Development builds use the same endpoint.** Once a development build exists, dev:phone's development-build mode starts Metro for the dev client behind the same Metro endpoint and Traffic Policy.

- **One ngrok agent on the owner's paid account, with two https endpoints.** The reserved domain forwards to the API on `127.0.0.1`; for tunnel testing the API also serves the webapp's build (`API_WEB_DIST`), so Safari, the public files and the mapper app share one https origin. A random ngrok address, new each run, forwards to Metro for Expo Go. Everything still listens on loopback only, Metro included (`expo start --localhost`), and dev:phone checks on every run that nothing it started answers on the PC's network addresses, so the LAN can't reach them whatever the firewall profile. The Vite dev server, PostGIS and RustFS are never exposed.
- **Request inspection is off** for both endpoints (`inspect_db_size: -1`), with the agent's local web interface: ngrok's local inspector keeps request bodies, which must never hold a locate photo.
- **TLS terminates at ngrok's edge, so ngrok sees the traffic.** That is acceptable for public map data and the read-only routes, and not for capture bundles or locate photos: before either goes through a tunnel, it needs end-to-end TLS (a TLS-passthrough tunnel with the certificate on the PC) or another path, such as the LAN for uploads ([0002](0002-photo-localization.md#privacy-path-release-blocking), [0005](0005-privacy-by-design.md)).
- **Read-only until auth exists.** Every route the tunnel exposes is read-only today; no write route may be exposed until the owner's device-token auth exists (Phase 2). Even then, the bundle and recording upload routes refuse requests that arrive through the tunnel, the way `/health` already tells the PC from tunnel clients.
- **Metro's development server is not the PC's to everyone who reaches it.** Through any tunnel its requests arrive from loopback, which Metro and Expo CLI trust as the PC: anyone with the address could attach a debugger and run code in the app on the phone, open files in the PC's editor or read any file Metro watches. So ngrok's Traffic Policy on the Metro endpoint allows only GET and HEAD, refuses the debugger, DevTools, editor, symbolication, event-stream, status and Expo dev-page endpoints at ngrok's edge, and makes no client of Metro's message socket count as the PC; dev:phone stops if a check through the tunnel finds the debugger answering or the manifest pointing at plain HTTP. Metro reads only the app, the packages it imports and `node_modules`, never `.env` files, `.data/` or `db/private/` (`apps/mapper/metro.config.js`). What stays reachable by anyone with the run's address is the app's development code, which holds the PC's paths.
- **`/health` gives its software versions only to the PC itself**, not through a proxy or tunnel.
- The public files and the glyphs are public data, so the API lets any origin read them, without credentials, as Cloudflare will serve them; the mapper app's map, a DOM component served by Metro, has no fixed origin. Other routes keep the listed origins (`API_CORS_ORIGINS`).

### Public files: Cloudflare free tiers

- The webapp's static build is served from Cloudflare Pages. Published map files (`indoor.json` and `street.json` under each version's immutable path, plus the short-TTL `latest.json` and `status.json`) are served from R2.
- Only public, non-personal files go to Cloudflare. R2 cannot be pinned to Singapore (`apac` is only a location hint), so nothing private goes there.

### Phase 4: one small server in Singapore

- The smallest x86 Singapore server (Lightsail-class) that runs the Node API and PostGIS, with a target of about US$12–24 a month (the stack review priced Lightsail at US$24 for 4 GB and US$44 for 8 GB). It must be x86 because the `postgis/postgis` image is amd64-only.
- Private bundles move to S3 in ap-southeast-1, with Block Public Access and encryption on. Keep them in S3 Standard until the pipeline settles: Glacier Instant Retrieval charges for retrieval and has a 90-day minimum, which hurts while early algorithm changes mean frequent re-runs.
- Postgres is backed up with WAL archiving to S3 (WAL-G or pgBackRest, chosen then), and a restore drill is run. Version history must survive, because rollback depends on it ([0004](0004-storage-and-versioning.md)).
- Localization runs on CPU, on the same box or a second small one. Lightsail-class CPU is burstable (about 20–30% baseline), which suits the API and the database but may not suit localization; the Phase 4 CPU benchmark on corridor data decides.
- Processing can stay on the owner's PC or move to the server; decided in Phase 4.
- The 3 s locate target becomes "measured and reported", not a gate ([0002](0002-photo-localization.md)).

### GPU

Only with the owner's explicit approval. Nothing in the MVP pipeline needs one. If one is ever approved:

- AWS g4dn spot in ap-southeast-1. T4 is the only GPU class in Singapore, and new accounts start with a G-instance quota of zero, so request an increase early.
- Or Cloud Run Jobs with an L4 GPU in asia-southeast1, which needs no quota ticket.

### Builds and accounts

- iOS builds start on the EAS Free plan and on GitHub macOS runners, which are free for the public repo. Xcode Cloud is an option. EAS Starter is paid for only if the native loop becomes the bottleneck ([0007](0007-expo-mapper-app.md)). EAS Free builds are low priority, with peak queues over 90 minutes and one macOS build at a time, so recorder iterations default to `eas build --local` on a GitHub macOS runner, and EAS Free is kept for the spike's planned builds.
- A build on a GitHub runner signs with EAS-managed credentials through an `EXPO_TOKEN` repository secret; no signing file is committed. Its .ipa is never uploaded as an Actions artifact of the public repo, where any signed-in GitHub user could download it: the ad hoc profile inside lists the iPhone's UDID and the developer team (amended 2026-10-17). The runner hands it to EAS instead, whose internal-distribution install link is private to the Expo account. If an artifact is ever unavoidable, it is encrypted to a key only the owner holds and kept with `retention-days: 1`. The run's logs are public too, so they must show no device ids or credentials.
- The native crash reporter (EAS Observe or Sentry, chosen in its backlog task) may keep its data outside Singapore. Its data region and transfer terms are recorded here when it is chosen (PDPA's Transfer Limitation Obligation), and it carries no poses, GNSS, recording values, screenshots or view hierarchies ([0005](0005-privacy-by-design.md)).
- Through Phase 3 the only subscriptions are the Apple Developer Program (US$99/yr) and the owner's existing paid ngrok plan, used for phone testing (`pnpm dev:phone`; its usage stays within the plan's included amount); a domain and email add about US$1–2 a month, and S3 backups about US$2 a month if used. The owner joins the Apple Developer Program now, before the spike's first build, and creates the free Expo account now, for Expo Go ([0007](0007-expo-mapper-app.md)).

### OneMap

- Raster tiles only; OneMap has no vector tiles. Tiles need no token. A OneMap account is needed for the search API, not for tiles.
- The API token lasts 3 days. Keep it server-side only and refresh it.
- The official style's `mapbox://` glyph URLs break MapLibre text layers, so `packages/map-style` uses its own glyphs.
- Tiles are served with `Content-Type: image/undefined`; test that MapLibre renders them.
- The TileJSON says maxzoom 19 while the style says 20, so indoor zooms overzoom the raster.
- Render the exact OneMap logo and attribution on every map view.
- Email SLA before any tile caching or offline packs.

## Why

- The owner asked for the lowest possible budget.
- Through Phase 3 the owner is the only mapper and the only user of the API. The public map is a set of static files, so nothing public needs an always-on server until contributors and localization arrive in Phase 4.
- Uploading over home Wi-Fi on the LAN costs nothing, needs no public endpoint, and keeps raw bundles on a disk in Singapore.
- Cloudflare serves public files with free egress, and immutable versioned files cache well.
- A GPU is hard to justify before measuring. An always-on g4dn in Singapore costs about US$540 a month on demand (2026-10-12), and scaling to zero breaks the 3 s target because of model load time. CPU-first localization uses 3–5 candidates, about 512 keypoints, pre-filters and a retrieval-only answer when matching runs out of time ([0002](0002-photo-localization.md)).

## Consequences

- The public map does not depend on the owner's PC being on. Uploads, processing and moderation do.
- Session recordings take PC disk and backup space: about 2.4 GB per 15-minute standard walk with its bundles, an estimate the spike checks ([0010](0010-capture-recording-and-replay.md)).
- Presigned part URLs must point at an address the phone can reach on the LAN, not `localhost`.
- While `pnpm dev:phone` runs, anyone who knows the reserved domain can read the API's read-only routes (`/health` without the versions), and anyone with the run's Metro address can download the app's development bundle. Stop it after testing.
- Phone testing depends on the owner's paid ngrok plan (two endpoints in one agent, Traffic Policy, random addresses), a running cost listed below. Expo's free tunnel isn't used: see Alternatives.
- The snapshot writer publishes from the PC to Cloudflare. R2 credentials, storage keys and the OneMap token live in `.env` files, which are git-ignored.
- Private data stays in Singapore: on the owner's PC, then in S3 ap-southeast-1 and on the Singapore server. Public, non-personal files may be served from Cloudflare's global edge.
- The hostname that serves `POST /locate` is DNS-only, not proxied through Cloudflare, and nothing in front of it buffers request bodies to disk ([0002](0002-photo-localization.md)).
- Lightsail may not support IAM instance roles; verify in Phase 4. If it does not, presigning needs scoped, rotated keys, or use EC2 with an instance profile.
- If Phase 2 data switches on COLMAP and it needs a GPU, that needs the owner's approval like any other GPU use.
- OneMap's licence can be revoked and its raster overzooms at indoor zooms; both are risks in the spec.

## Alternatives considered

- **An always-on cloud server from Phase 1.** The stack review first priced this at about US$45–80 a month all in. Not needed while the owner is the only user of the API.
- **R2 for private bundles.** R2 cannot be pinned to Singapore, so private data could end up stored outside it.
- **GPU localization from the start.** See Why: too costly before a CPU benchmark shows it is needed.
- **The phone on the LAN for testing** (a firewall rule for the dev ports on the Public profile, or the Wi-Fi set to Private). Rejected for testing because each port needs a rule and the Private profile may open every port; uploads still use the LAN in Phase 2.
- **A tunnel per service** (Vite, the API, RustFS). One endpoint for the API, which serves the build, plus one for Metro, exposes the least.
- **Expo's own tunnel for Metro** (`expo start --tunnel`, an `exp.direct` address; the first version of dev:phone, 2026-10-15). Rejected the same day: it carries Metro's debugger and other PC-only endpoints to anyone with the address (Expo trusts loopback, and the tunnel's agent connects from loopback), with no way to filter them; Expo Go loaded the app over plain HTTP; the address stayed the same across runs; its agent kept a request inspector on the PC; and Expo's shared ngrok account refused new sessions that evening (ERR_NGROK_108, its 5,000-session limit), which the owner can't fix.

## Costs

Figures as of 2026-10-12; sources are in the [stack review](../reviews/2026-10-12-stack-review.md). Recheck before paying for anything.

| Item | Phases 1–3 | Phase 4 |
| --- | --- | --- |
| Apple Developer Program | US$99/yr | US$99/yr |
| iOS builds | EAS Free plan and GitHub runners: none (EAS Starter US$19 a month only if needed) | Same |
| Server for the API and PostGIS | None (owner's PC) | About US$12–24 a month: the owner's target, not a quote (the review priced Lightsail at US$24–44) |
| Localization compute | None | CPU, same box or a second small one; priced after the benchmark |
| S3 and backups | External drive, or about US$2 a month | About US$2–5 a month |
| Cloudflare, domain, email | About US$1–2 a month | About US$1–2 a month |
| ngrok, for phone testing | The owner's existing paid plan. On 2026-10-15: Hobbyist US$10 a month or Pay-as-you-go US$20 a month, each with that much usage included; endpoint hours US$0.02, counted only while traffic flows | Same, while still used |
| GPU | None | None without the owner's approval |
