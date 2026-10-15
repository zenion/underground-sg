# Snapshot fixtures

| Path | What it is |
| --- | --- |
| `city-hall.ts` | A synthetic HEAD and street graph at real City Hall cluster coordinates: Funan B2 and B1, the underground link to City Hall MRT's concourse (fare gates, paid area, a lift to Exit A), the link into Raffles City B1 and a ramp to its North Bridge Road entrance, and OSM-style footpaths on North Bridge Road and Stamford Road. Names, hours, lengths and OSM ids are made up; nothing was recorded in a venue. It also plants private rows (an anchor with a reference photo, a restricted zone, venues' operator and permission, a node's height, extra OSM tags) that must never reach a public file |
| `snapshot/indoor.json`, `snapshot/street.json` | The golden files: what `buildSnapshot` makes of `city-hall.ts` after `rebuildStreetConnectors`, byte for byte (snapshot format v1, [docs/snapshot-format.md](../../../../docs/snapshot-format.md)) |

The golden files are the one artifact the producer and the consumers are tested against ([0003](../../../../docs/decisions/0003-routing.md), [0004](../../../../docs/decisions/0004-storage-and-versioning.md)): `test/stack/snapshot.test.ts` checks that the builder still writes exactly these bytes, and the `packages/routing` tests build their graph from the same files. Read them from another package through the export `@usg/api/test/fixtures/*`, for example:

```ts
import { readFileSync } from "node:fs";
import type { IndoorSnapshot, StreetSnapshot } from "@usg/contracts";

const read = (file: string) =>
  JSON.parse(readFileSync(new URL(import.meta.resolve(`@usg/api/test/fixtures/snapshot/${file}`)), "utf8"));
const indoor = read("indoor.json") as IndoorSnapshot;
const street = read("street.json") as StreetSnapshot;
```

(with `"@usg/api": "workspace:*"` in that package's devDependencies), or by a path relative to the repo root. They are valid against `validateVersion` and hold, among others: a one-way escalator, stairs and a ramp between levels, a lift whose two landings share a point, a paid-area edge and a customers-only edge, opening hours, an outdoor `street` edge, a level-less exit and entrance with their street connectors, and street edges tagged `steps`, `crossing` and `covered`.

The files are compact JSON with no trailing newline; Biome skips the directory and `.gitattributes` keeps git from touching their line endings. After a deliberate change to the builder or the fixture, regenerate them and review the diff, since it changes what routing reads:

```bash
pnpm --filter @usg/api exec vitest run --project stack test/stack/snapshot.test.ts -u
```
