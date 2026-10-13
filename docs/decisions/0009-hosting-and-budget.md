# 0009: Hosting on the owner's PC first, a small Singapore server in Phase 4

Status: accepted · 2026-10-12

## Decision

The budget is as low as possible. No cloud server until Phase 4; only public files go to Cloudflare's free tiers before then. No GPU without the owner's explicit approval.

### Phases 1–3: the owner's PC

- PostGIS (`postgis/postgis:18-3.6`), the local S3 stand-in (RustFS, with SeaweedFS as the fallback), the API and the processing workers all run on the owner's Windows PC, under Docker Desktop with the WSL2 backend.
- The phone uploads over home Wi-Fi on the LAN.
- Raw bundles hold trajectories, which are personal data ([0005](0005-privacy-by-design.md)), so the PostGIS and RustFS data on the PC sit on an encrypted disk (BitLocker, for example).
- Raw bundles, the private full exports and a database dump are backed up to an external drive or a cheap S3 bucket in ap-southeast-1, encrypted at rest either way.

### Public files: Cloudflare free tiers

- The webapp's static build is served from Cloudflare Pages. Published map files (`indoor.json` and `street.json` under each version's immutable path, plus the short-TTL `latest.json` and `status.json`) are served from R2.
- Only public, non-personal files go to Cloudflare. R2 cannot be pinned to Singapore (`apac` is only a location hint), so nothing private goes there.

### Phase 4: one small server in Singapore

- The smallest x86 Singapore server (Lightsail-class) that runs the Node API and PostGIS, with a target of about US$12–24 a month (the stack review priced Lightsail at US$24 for 4 GB and US$44 for 8 GB). It must be x86 because the `postgis/postgis` image is amd64-only.
- Private bundles move to S3 in ap-southeast-1, with Block Public Access and encryption on. Keep them in S3 Standard until the pipeline settles: Glacier Instant Retrieval charges for retrieval and has a 90-day minimum, which hurts while early algorithm changes mean frequent re-runs.
- Postgres is backed up with WAL archiving to S3 (WAL-G or pgBackRest, chosen then), and a restore drill is run. Version history must survive, because rollback depends on it ([0004](0004-storage-and-versioning.md)).
- Localization runs on CPU, on the same box or a second small one. Lightsail-class CPU is burstable (about 20–30% baseline), which suits the API and the database but may not suit localization; the Phase 4 CPU benchmark on Funan data decides.
- Processing can stay on the owner's PC or move to the server; decided in Phase 4.
- The 3 s locate target becomes "measured and reported", not a gate ([0002](0002-photo-localization.md)).

### GPU

Only with the owner's explicit approval. Nothing in the MVP pipeline needs one. If one is ever approved:

- AWS g4dn spot in ap-southeast-1. T4 is the only GPU class in Singapore, and new accounts start with a G-instance quota of zero, so request an increase early.
- Or Cloud Run Jobs with an L4 GPU in asia-southeast1, which needs no quota ticket.

### Builds and accounts

- iOS builds start on the EAS Free plan and on GitHub macOS runners, which are free for the public repo. Xcode Cloud is an option. EAS Starter is paid for only if the native loop becomes the bottleneck ([0007](0007-expo-mapper-app.md)).
- Through Phase 3 the only subscription is the Apple Developer Program (US$99/yr); a domain and email add about US$1–2 a month, and S3 backups about US$2 a month if used. The owner creates the Apple membership, and an Expo account, when the Swift spike starts.

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
- Presigned part URLs must point at an address the phone can reach on the LAN, not `localhost`.
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
| GPU | None | None without the owner's approval |
