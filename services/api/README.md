# @usg/api

The Underground SG API: Fastify 5 on Node 26, Kysely on node-postgres, the S3 API for object storage ([0006](../../docs/decisions/0006-typescript-backend.md)). It runs on the owner's PC through Phase 3, next to the compose stack ([0009](../../docs/decisions/0009-hosting-and-budget.md)). The package also holds the publish transaction (the automated gates, the diff apply, the snapshot builder, the private export and `latest.json`) as library functions with a CLI, `pnpm map`, and the local demo, `pnpm demo`.

Every route is read-only and safe to expose on the LAN, and through `pnpm dev:phone`'s tunnel ([docs/phone-testing.md](../../docs/phone-testing.md)); no write route may go through a tunnel before the owner's device-token auth exists (Phase 2). Nothing publishes or writes over HTTP: heavy work never runs in the API process ([CLAUDE.md](../../CLAUDE.md)), so the publish runs in a process of its own from the CLI (and later from a worker or the approval path), never from a route.

## Running it

```bash
docker compose up -d --wait
pnpm migrate
pnpm buckets
pnpm api
```

`pnpm api` is `pnpm --filter @usg/api start`, which is `node src/server.ts`: Node runs the TypeScript directly, with no build step. It listens on http://127.0.0.1:28000. Settings come from the root `.env` (copy [.env.example](../../.env.example)) through `loadRootEnv` in `@usg/scripts/env`; variables already set in the environment win.

| Variable | Default | What it is |
| --- | --- | --- |
| `API_HOST` | `127.0.0.1` | The address to listen on. `0.0.0.0` only when the phone needs the API over the LAN (see below) |
| `API_PORT` | `28000` | Below 49152, the start of Windows' dynamic range, where Hyper-V reserves blocks |
| `API_CORS_ORIGINS` | the Vite dev server and Metro on `localhost` and `127.0.0.1` (ports 5173 and 8081) | Origins that may read `/health`, `/map/latest` and `/openapi.json` from a browser or WebView, comma-separated. The public files and the glyphs are public data: any origin may read them, without credentials (`Access-Control-Allow-Origin: *`, as R2 will serve them), which covers the mapper app's map wherever Metro serves it from |
| `API_WEB_DIST` | empty | The webapp's build (`apps/web/dist`) to serve at `/`, for testing through one tunnel (`pnpm dev:phone` sets it). Empty: no page. In production Cloudflare Pages serves the build |
| `API_PUBLIC_FILES_URL` | empty | Where `GET /map/latest` points clients for the public files. Empty: this API's `/public/`. In production, the R2 bucket's public URL |
| `DATABASE_URL`, `S3_*` | | As for the rest of the stack. `pnpm map` and `pnpm demo` read only these (`pnpm demo` also reads `API_HOST` and `API_PORT` for the URLs it prints, falling back to the defaults if they are malformed) |
| `LOG_LEVEL` | `info` | Pino's level. Logs are JSON lines; they carry no credentials |

A setting that is missing or malformed stops the process with the variable's name, never its value. When PostGIS or RustFS isn't listening, `pnpm map`, `pnpm demo` and `pnpm db seed` say which (host and port, never credentials) and how to start the stack, as `pnpm buckets` does (`unreachableMessage` in `@usg/scripts/errors`).

Every S3 request has limits (`DEFAULT_S3_TIMEOUTS` in `src/storage.ts`): 3 s to connect and 30 s for the request and its response, so an endpoint that accepts connections and never answers fails a request instead of hanging it. A transaction that holds `map_head` (the publish, the pointer write, the reconcile job) also sets `idle_in_transaction_session_timeout` to 5 minutes, so nothing that hangs can hold the lock for good.

### The phone on the LAN

With the PC's Wi-Fi on the Public profile, use `pnpm dev:phone` instead: one ngrok tunnel to the API, which then needs no firewall rule ([docs/phone-testing.md](../../docs/phone-testing.md)).

The mapper app's dev build reaches the API over home Wi-Fi. Set `API_HOST=0.0.0.0` in `.env` and restart `pnpm api`; the log warns that it listens beyond this machine. The first time Node listens on the network, Windows Defender Firewall asks whether to allow it: allow **Private networks** only, never Public. The phone then uses `http://<the PC's LAN IP>:28000` (`ipconfig` shows the IP; a DHCP reservation on the router keeps it stable). Anyone on the Wi-Fi can then read every route, which is why every route is read-only and nothing private is served; set `API_HOST` back to `127.0.0.1` when you're done. The map's DOM component reads only the public files and the glyphs, which any origin may read; add `http://<the PC's LAN IP>:8081` to `API_CORS_ORIGINS` only if a DOM component calls another route.

## Routes

Response bodies follow the JSON Schemas in `packages/contracts/schemas/api/` (types `ApiDocuments` in `@usg/contracts`). Each route's response schema is that file inlined (`inlineSchema` in `@usg/contracts/validators`), and the serializer checks every JSON response against it before sending: a body that breaks its contract becomes a 500 and is not sent. Errors are `ErrorResponse`: a 4xx goes out as Fastify sends it; a 5xx says nothing about its cause (`src/error-handler.ts`), since a database or S3 error names hosts, ports, the database user and the store's own text: its body is the bare status, `{"statusCode":503,"error":"Service Unavailable","message":"Service Unavailable"}` when PostGIS or the object store can't be reached or timed out, 500 `Internal Server Error` otherwise, and the error's name, code and message go to the log.

| Route | What it does |
| --- | --- |
| `GET /health` | Whether the API reaches PostGIS and every bucket, with the API, Node, PostgreSQL, PostGIS, newest migration and RustFS versions (`HealthResponse`). The versions other than the API's go only to a request from this machine (a loopback address without `X-Forwarded-For`, `Forwarded` and the like); through a tunnel or from the LAN they are `null`. 200 when every check passes, 503 otherwise, with the same body. A failed check reports only a problem code (`unreachable`, `timeout`, `access_denied`, `not_migrated`, `missing_bucket`, `error`) and logs the details; buckets are reported by role, never by name. Each check times out after 3 s |
| `GET /map/latest` | The version `map_head` points at (`MapLatestResponse`): version, `published_at` in Singapore time, `snapshot_sha256`, `restores`, each version file's path and URL, and `demo: true` when the database holds the demo map. 404 before the first publish. For the owner's tools on the LAN; public clients read `latest.json`, which can lag `map_head` until the reconcile job runs. Never the publisher, the private export key or the note |
| `GET /public/*` | The local stand-in for Cloudflare: the public bucket, read-only ([snapshot-format.md](../../docs/snapshot-format.md#layout)). Only `latest.json`, `status.json` and `snapshots/<64 hex>/indoor.json` or `street.json`; anything else, listings included, is 404. Content-Type and Cache-Control as the format sets them. An object stored with a content coding (brotli, for version files) goes out as stored, with `Content-Encoding`, to a request whose `Accept-Encoding` accepts it, and decoded otherwise (no `Accept-Encoding` counts as identity only). ETag and `If-None-Match` for the stored representation; HEAD too. `Vary: Accept-Encoding` is added to CORS's `Vary: Origin`, never in its place. The object store gets 10 s to start answering (`PUBLIC_FILE_TIMEOUT_MS`), then the request is a 503 |
| `GET /glyphs/:fontstack/:range.pbf` | The glyph PBFs of `@usg/map-style`, for the mapper app's WebView over the LAN: the style's `glyphs` is `http://<api>/glyphs/{fontstack}/{range}.pbf`. The files are listed at start-up and a request is only looked up in that list, so nothing from a request becomes part of a path |
| `GET /openapi.json` | The OpenAPI 3.1 document, from the route schemas by `@fastify/swagger`, success responses included: the file routes list their content types |
| `GET /`, the webapp's files | Only with `API_WEB_DIST` (`src/routes/web.ts`, `src/web-dist.ts`): `index.html` at `/` and each file of the build, listed and read once at start-up (a request is only looked up in that list, so nothing from it becomes a path), brotli to clients that accept it, with ETags. Hashed `assets/` files are cached for good, `index.html` is `no-cache`. A GET that asks for `text/html` (not just `*/*`) for any other path gets `index.html`, except under `/public`, `/map`, `/health`, `/glyphs` and `/openapi.json`. The page has a Content-Security-Policy allowing exactly what MapLibre and OneMap need (scripts, styles and data from the API's origin, workers also from `blob:`, tiles and the logo from `https://www.onemap.gov.sg`), `X-Content-Type-Options: nosniff` and `Referrer-Policy`. Not in the OpenAPI document |

## Publishing

A structural change set reaches the public map in two steps, each a command of `pnpm map` (`src/cli/map.ts`), each its own process:

```bash
pnpm map gates <change-set-id>                 # run the automated gates; records gates_passed or gates_failed
pnpm map publish <change-set-id>...            # publish change sets whose gates passed, as a new version
pnpm map reconcile                             # repair latest.json from map_head, if a publish couldn't
```

`publish` takes `--by <contributor-id>` (default: the one contributor with tier `owner`, the demo's owner aside) and `--note <text>` (`map_versions.note`, private). `latest.json`'s `demo` flag follows the database (`src/demo-flag.ts`: `true` while it holds the demo map), so neither command has an option for it. Exit codes: 0 done, 1 refused or not fully done (the message says which), 2 bad usage.

### The automated gates (`src/publish/gates.ts`)

`runGates(db, changeSetId)` checks a pending structural change set and appends the outcome to `moderation_events` (actor `NULL`): `gates_passed` when no gate failed, `gates_failed` otherwise, with `detail` `{ "gates": [{ gate, result, reason, problems? }], "diff_sha256", "captures", "head_version" }`: what was checked, namely the diff's SHA-256 (of its jsonb as Postgres prints it), the linked captures and the version `map_head` named. It runs in a transaction of its own, holding `map_head FOR SHARE`, so its record is never rolled back with a publish that fails. The database refuses to set a publish path without a `gates_passed` that no later `gates_failed` overrides (`change_sets_guard`); these checks report the problems first, with details. A gate with nothing to check is recorded as `not_applicable`, never as `passed`.

| Gate | Passes when | Not applicable |
| --- | --- | --- |
| `diff` | The diff validates (`validateChangeSetDiff`) | Never |
| `privacy` | Every linked capture is `ready_for_review` or `approved` (it passed the privacy re-check) and not privacy-flagged | A manual edit: no captures, so no images |
| `restricted_zones` | No space, node, edge or POI the change set leaves in HEAD overlaps the interior of a restricted zone on its level (sharing an edge is fine). Edges are checked as drawn (the stored line with its ends on the nodes, or a straight line), an edge without a level against the levels of both its ends, and an edge the diff doesn't name is checked too when the diff moves one of its ends. A node without a level (a street exit) has no level whose zones apply. Problems name features and zones by id, never an outline. The publish checks again, against HEAD and the zones as they are then | When the diff doesn't validate (not run), or the change set leaves no public feature to check (a removal, a venue or level edit, an anchor) |
| `alignment_residuals`, `street_priors` | Not built yet (Phase 2): a change set with captures fails them | A manual edit: no captured segments |

### The publish transaction (`src/publish/publish.ts`)

`publish(db, storage, { changeSetIds, publishedBy, note?, demo? })` follows [0004](../../docs/decisions/0004-storage-and-versioning.md#approval-and-publish-order) and [diff-format.md](../../docs/diff-format.md#approval):

1. Lock `map_head` (`SELECT ... FOR UPDATE`): publishes are serialised.
2. Check every change set before anything changes: pending, structural, the owner's (Phase 1 publishes only through `owner_mapper`), its latest gates result `gates_passed` and recorded for the diff and captures it holds now (else "run them again"), no failed or privacy-flagged capture; the publisher has tier `owner`; and the database doesn't hold the demo map, unless `demo: true` says this is the demo's own publish (which is refused on a database that doesn't). Any problem throws `PublishRefusedError` with all of them. With no change sets it refuses too: every version except a rollback publishes one, and rollback is not built yet.
3. For each change set, oldest first (`created_at`, then id), the rebase check and then its diff under a savepoint (`src/publish/apply.ts`): adds and modifies parents first, removes last, `rev` 1 for an add and `base_rev + 1` for a modify, geometry through `ST_GeomFromGeoJSON`, `venues.permission` never written; levels' unique name per venue is deferred until the change set's entries are in, so two levels can swap names. A change set becomes `needs_rebase` (with a `needs_rebase` event listing why) and applies nothing when it fails the rebase check (which also refuses moving a level that has restricted zones to another venue), when the database refuses an entry or the change set (a constraint, or the restricted-zone trigger), or when HEAD would then hold a feature overlapping a restricted zone that it didn't before (`headOverlaps` in `src/publish/restricted-zones.ts`: the zones as they are now, and every edge as the public files draw it, which the trigger can't see). The others carry on. If none is left, the transaction commits those decisions and no version is made.
4. Rebuild `street_connectors`. Check the whole of HEAD against the restricted zones, street connectors of nodes with a level included; anything overlapping (a zone drawn over a published feature since, say) refuses the publish with `PublishRefusedError`, naming features and zones by id, before a file is written. Then build the snapshot inside the transaction.
5. Upload the two version files, brotli-compressed, to `snapshots/<snapshot_sha256>/`, before commit. A file already there is read back and reused if it decodes to the same bytes (a retried publish, a rollback, a change only to private rows), and is never overwritten (`ImmutableFileError` if it differs).
6. Write the private full export ([head-export-format.md](../../docs/head-export-format.md)) to the exports bucket at `head/<version>/<uuid>.json`, validated first.
7. Insert `map_versions`, set the change sets' `decision = auto_published`, `publish_path = owner_mapper` and `map_version_id`, append a `published` event for each (naming the gates event it relied on and the diff's SHA-256), and move `map_head`.
8. Commit.
9. Write `latest.json` (`updateLatest` in `src/publish/pointer.ts`, with `demo: true` while the database holds the demo) and, if there is none, an empty `status.json`, in a short transaction holding `map_head FOR SHARE`, and only while `map_head` still names this version: a newer publish can't commit meanwhile, so `latest.json` never moves back. If a newer version has already committed, `pointer.superseded` is true and the newer publish writes its own pointer. If the write fails the version stands, `pointer.updated` is false, and `reconcileLatest` (`pnpm map reconcile`) repairs it from `map_head`, under the same lock, after checking the version's files against `snapshot_sha256`. Neither ever replaces a `latest.json` that names a newer version.

`latest.json`'s `attribution` lists OpenStreetMap's for `street.json`; LTA's exit data joins it when the LTA exit import puts exit positions in a version.

The pieces, for other callers: `applyChangeSet`, `rebaseReasons`, `applyDiff` and `applyOrder` (`apply.ts`); `headOverlaps` (`restricted-zones.ts`); `buildSnapshot` and `rebuildStreetConnectors` (below); `buildHeadExport` (`export.ts`); `latestPointer`, `updateLatest`, `writeLatest`, `ensureStatus` and `reconcileLatest` (`pointer.ts`).

### The snapshot builder

- `buildSnapshot(db)` (`src/publish/snapshot.ts`) reads HEAD and the street graph and returns the two version files' bytes (compact UTF-8 JSON, before any content encoding), their SHA-256s, `snapshot_sha256` and the directory, as [snapshot-format.md](../../docs/snapshot-format.md) sets out. It selects the format's columns by name, so nothing private is read; sorts and orders members as the format says; writes coordinates with `ST_AsGeoJSON(geom, 7)`; rounds lengths and heights to 2 decimals in SQL; writes empty text as `null`; runs every line from its start node to its end node with its ends set exactly to their points (reversing a stored line that runs the other way, compared in SVY21, or drawing a straight line when HEAD has none); and writes polygon rings counterclockwise. It then parses the bytes back and runs `validateVersion`, and throws `SnapshotInvalidError` (with the problems) rather than return files that fail it. Given a transaction it reads what that transaction sees; otherwise it opens a read-only REPEATABLE READ transaction of its own.
- `rebuildStreetConnectors(db)` (`src/publish/street-connectors.ts`) replaces `street_connectors`: each exit and entrance to its nearest street node by SVY21 distance (ties to the lowest OSM node id), within `STREET_CONNECTOR_MAX_LENGTH_M` (100 m), with a straight line and its length in metres.
- Storage: `Storage` in `src/storage.ts` gives the three buckets by role as `ObjectStore`s (`get`, `head`, `put`, `exists`), over `@aws-sdk/client-s3` (`createS3Storage`, with the timeouts above) or in memory for tests (`createMemoryStorage`). There is no delete: a version's directory is never overwritten or deleted (only `pnpm demo --reset` removes the demo's, with its own S3 client).

## The demo

`pnpm demo` publishes made-up map data to the local stack, for trying the map end to end before anything is surveyed. `src/demo/dataset.ts` holds it: Funan B2 through the underground link to City Hall MRT's concourse (fare gates and a paid area) and up a ramp to Raffles City B1; an escalator between Funan B2 and B1; Exit B (North Bridge Road), Exit A (Stamford Road) and the Raffles City entrance (North Bridge Road) up stairs; toilets, a bookshop, a bakery, a pharmacy and an ATM; and four synthetic footpath nodes near the exits, so `street.json` and the street connectors aren't empty. Every name starts with `Demo:`, its street ids are far above any real OpenStreetMap id, and `latest.json` says `"demo": true`. It is separate from the real seed data (`db/seed/core-venues.ts`).

It goes through the real path: a demo owner contributor (tier `owner`), the venues and levels through the seed script's mechanism (`@usg/db/seed`), the footpaths into the street tables (standing in for the OSM import), the rest as one `owner_mapper` change set (a manual edit, no captures), `runGates`, then `publish`. Every id is fixed, so running it again changes nothing (it only checks `latest.json`), and a run after a reset publishes the same bytes.

```bash
pnpm demo            # publish the demo (or carry on where a run stopped)
pnpm api             # then http://127.0.0.1:28000/map/latest, /public/latest.json, ...
pnpm demo --reset    # wipe it, so it can run again
```

- Both refuse unless `DATABASE_URL` and `S3_ENDPOINT` are on this machine (loopback): demo data never goes anywhere but the local PostGIS and RustFS.
- "On this machine" is read as the drivers read `DATABASE_URL` (`isLocalHost` in `@usg/db/local`): a `host`, `hostaddr` or `service` query parameter, which node-postgres or dbmate would connect to instead of the URL's host, is refused.
- Both refuse when the database holds anything that isn't the demo's (another venue, a contributor, a capture, a restricted zone, a non-demo version), so the demo never mixes into a real map and `--reset` never wipes one. `--reset` also refuses when `latest.json` isn't the demo's.
- The other way round, the demo's owner contributor (`DEMO_OWNER` in `@usg/db/demo`) marks a database that holds the demo: `pnpm db seed` and `pnpm map publish` refuse real data there ("run `pnpm demo --reset` first"), and `latest.json` and `GET /map/latest` say `demo: true` for as long as it is there, also after the reconcile job rewrites the pointer.
- `--reset` recreates the local database from the migrations (`recreateLocalDatabase` in `@usg/db/local`): `map_versions` and `moderation_events` are write-once and `map_head` only moves forward, so no rule lets their rows be deleted. It then deletes the demo's `latest.json`, `status.json`, version directories and private exports, so nothing of the demo is left in the public bucket for an upload to R2 to find. (Version directories are otherwise never deleted; these are local, hold only demo data, and belong to versions the recreate has just removed.) The API can keep running; its connections are closed and it reconnects.

## Tests

| Command | What runs |
| --- | --- |
| `pnpm --filter @usg/api test` | `test/unit/` (part of `pnpm test`): config, the public file rules and `Accept-Encoding`, Singapore time, the Kysely types against `db/schema.sql`, the demo dataset and its local-only guard, the app with an in-memory bucket (`/public/*` with `Vary`, `/glyphs`, `/health` with nothing reachable, CORS (any origin for the public files and glyphs, the listed ones otherwise), OpenAPI and the response contracts, and bare 5xx bodies for an unreachable or unresolvable database, a store that fails naming its host and one that never answers), and, on real sockets, the S3 client's timeout and the CLIs' message for a refused connection (`stack-errors.test.ts`); the webapp's build (`web.test.ts`: the allow-list, traversal attempts, the SPA fallback's rules, caching, brotli and the page's security headers, and the real `apps/web/dist` when it is built) |
| `pnpm --filter @usg/api test:db` | `test/stack/` (part of `pnpm test:db`; needs the compose stack): the snapshot builder's golden files and rules; the diff apply, each rebase reason, and the savepoint (a level-name swap applies, a duplicate name, an entry the trigger refuses and a line drawn across a zone each give `needs_rebase` and apply nothing) (`apply.test.ts`); the gates and what their record names (`gates.test.ts`); the publish transaction (`publish.test.ts`: two concurrent publishes serialise, a failed `latest.json` update is repaired by the reconcile job, no change sets is refused, a rev conflict gives `needs_rebase` and publishes nothing, failed gates block, the public objects carry no private data, a change only to private rows reuses the files); what the publish checks again (`publish-guards.test.ts`: two change sets clear alone but crossing a zone together, a zone drawn after the gates, a diff or captures changed after the gates, a zone over a feature no change set touches or across a street connector, a refused change set beside a publishing one, the demo flag both ways); `latest.json` only moving forward (`pointer.test.ts`: a slow pointer write holds back the next publish, an overtaken pointer is left unwritten, the reconcile job holds `map_head` while it checks the files, a newer `latest.json` is never replaced); the demo, what it refuses beside it, and its reset (`demo.test.ts`); `/health` and `/map/latest` against PostGIS; and the S3 store and `/public/*` against RustFS |

The stack tests reuse `@usg/db`'s harness: its global setup migrates a template database and each test file gets its own copy (`useDatabase`); `test/stack/helpers.ts` adds a Kysely pool on it and scratch buckets per file (`usg-test-<epoch ms>-<hex>`, emptied and deleted afterwards; a crashed run's buckets go after an hour; `useScratchStorage` gives a public and an exports bucket), so the developer's own database and buckets are never touched. `test/stack/head.ts` reads HEAD rows in the diff format, to build diffs against the fixture. CI's `Database (postgis)` job runs them against service containers for PostGIS and RustFS.

The golden files and their fixture are described in [test/fixtures/README.md](test/fixtures/README.md).
