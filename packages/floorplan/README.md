# @usg/floorplan

Turns the floor triangles of an ARKit scene mesh into an approximate walkable outline, plus a coverage grid that shows what the scan never observed. The mapper app runs it on the phone for the floor-plan preview right after the end anchor ([spec: Mapper mode](../../docs/spec.md#mapper-mode-the-fast-loop), [ADR 0007](../../docs/decisions/0007-expo-mapper-app.md)); processing can run the same code in Node. It is pure TypeScript with no dependencies, because Hermes has no WebAssembly.

The preview is approximate. LiDAR reaches about 5 m, glass and polished floors leave holes, and redrawing an outline is a normal part of the flow. Server extraction is the authority.

## Use

```ts
import {
  buildFloorplan,
  CELL_BRIDGED,
  CELL_HOLE,
  toDisplayGeoJSON,
  traceCoverage,
} from "@usg/floorplan";

// `triangles`: the Float32Array of x,z pairs from the capture module's floorTriangles.
const { polygons, coverage, stats } = buildFloorplan(triangles);

// For display only: an approximate placement on the base map (see "Display conversion").
// `startAnchor` is the start anchor's [x, z] in the session; `heading` the bearing of -z.
const transform = { lon: 103.852, lat: 1.2931, local: startAnchor, headingDeg: heading };
const outline = toDisplayGeoJSON(polygons, transform);
const gaps = toDisplayGeoJSON(traceCoverage(coverage, [CELL_BRIDGED, CELL_HOLE]), transform);
```

## Input

`buildFloorplan(triangles, options?)` takes the floor-classified faces of the scene mesh (`ARMeshClassification` floor, value 2 in `mesh/scene.ply`) projected onto ARKit's horizontal plane: a `Float32Array` (or `Float64Array`) of x,z pairs in metres, 3 vertices per triangle, which is what the capture module's `floorTriangles` returns ([capture-bundle.md](../../docs/capture-bundle.md#coordinate-frame-and-time-base): the session's world frame, right-handed, y up). Heights are not used, so a segment that changes level is flattened into one plan, and floor the scan saw on another level is drawn into the plan too: the floor below over an atrium balustrade or through glass, or an escalator's far landing. Whether `floorTriangles` should return x,y,z instead, so that a height band around the walked floor can drop those faces, is open until the floor-triangle export task ([backlog](../../docs/backlog.md)).

Triangles with a non-finite coordinate, an area under 1e-9 m², or a height under 0.02% of their longest edge (slivers, such as a steep face classified as floor) are skipped and counted in `stats.skippedTriangles`. A length that is not a multiple of 6 throws `RangeError`.

## Output

- **`polygons`**: walkable outlines in the session's x/z metres, largest first. Each has an `outer` ring, `holes` and `areaM2` (outer minus holes). Rings are closed (the last point repeats the first, as in GeoJSON).
- **`coverage`**: one byte per grid cell: `CELL_OBSERVED` (a floor triangle covered the cell's centre), `CELL_BRIDGED` (never observed, but the close filled it in, so the preview guessed), `CELL_HOLE` (never observed and enclosed by walkable cells: a pillar, or floor the scan missed) or `CELL_OUTSIDE`. Bridged and hole cells are the gaps to re-walk. `traceCoverage(coverage, states)` outlines the cells in the given states as polygons for the overlay, and `coverageCellCenter(coverage, col, row)` gives a cell's centre in x/z. The grid may be rotated against the session axes (see the pipeline); `angleRad`, `originU` and `originW` describe it.
- **`stats`**: input and skipped triangles, the grid's angle and size, counts of observed, walkable, bridged and hole cells, removed islands, rings, output vertices, polygons and holes, and `timingsMs` for each stage.

### Conventions

- Points are `[x, z]` in the session's frame, metres.
- Orientation is as seen from above, looking down ARKit's y axis, which is what a map shows: outer rings counter-clockwise, holes clockwise. Seen from above with x to the right, z points down the page, so in raw (x, z) terms an outer ring has a *negative* shoelace sum. `ringArea(ring)` returns the area as seen from above (positive for counter-clockwise), so callers never need the sign rule.
- Any rotation and translation (such as the server's alignment into SVY21) keeps that orientation, and so does `toDisplayGeoJSON`: its output follows RFC 7946 (exterior rings counter-clockwise in lon/lat).

## Pipeline

| Stage | What it does | Default |
| --- | --- | --- |
| Grid angle | Lines the grid up with the walls: the angle that makes the sharpest projections of a sample of vertices onto the grid axes (sum of squared counts in 0.2 m bins; 3°, then 0.25° and 0.05° steps). The sample is 2,048 triangles drawn at random with a fixed seed (all of them when there are fewer), so the angle is the same on every run; taking every nth triangle instead would, on a mesh stored row by row, sample a lattice whose own sharp projections pulled the grid up to 27° off the walls. The search resolves about one bin over the corridor's length (0.4° on 30 m, under 0.1° on 150 m). ARKit's heading is arbitrary, so a corridor often runs diagonally in the session frame; aligning gives a tight grid and straight outlines. `gridAngleRad` sets an angle instead, for example from a door's facing | `"auto"` |
| Extent | The triangles' extent along the grid axes plus padding. More than `maxCells` cells throws `FloorplanExtentError` (with `code` `FLOORPLAN_EXTENT`), which names the extent: a segment is one corridor, hall or level, so this means stray triangles far away | 4,000,000 cells |
| Rasterise | Sets each cell whose centre lies in a triangle (inclusive edges). Triangles tile the floor, so centre sampling neither double-counts nor biases; a triangle too small to hold a centre sets its centroid's cell. `maxCells` bounds the memory but not the time, which grows with each triangle's size, so rasterising stops with `FloorplanWorkError` (`code` `FLOORPLAN_WORK`) after 16 row and cell visits per grid cell plus 8 per triangle: thousands of large overlapping triangles would otherwise take minutes. The synthetic meshes use 4% to 10% of that | 0.1 m cells |
| Close | Dilate, then erode by a disc of `closeRadiusM`: bridges gaps up to about twice the radius (people, reflections, missed patches) and fills holes narrower than that. Never removes an observed cell. It also rounds the corners of the holes it keeps | 0.2 m (gaps up to about 0.4 m) |
| Islands | Labels the 4-connected walkable areas and removes those under `minIslandAreaM2` (stray triangles beyond the walls) | 0.5 m² |
| Trace | Marching squares, walking each outline with walkable cells on its left, so outer rings come out counter-clockwise and holes clockwise. Saddles keep diagonal cells apart, matching the 4-connected labels. The scan order also classifies each ring and names its area, so holes pair with their outer ring without point-in-polygon tests | |
| Simplify | Douglas-Peucker on each closed ring (iterative, so long rings are safe on Hermes' stack), then the orientation is checked again and holes under `minHoleAreaM2` and polygons under `minPolygonAreaM2` are dropped | 0.04 m; 0.1 m²; 0.5 m² |
| Coverage | Marks bridged cells, then flood-fills each hole from its traced ring to mark hole cells, at a cost of the holes' area | |

Every pass over the grid runs only inside each row's occupied column range, so empty parts of the grid cost almost nothing, and everything lives in typed arrays: no per-cell objects. The simplification tolerance is under half a cell on purpose: marching squares cuts each square corner by half a cell, and at half a cell or more Douglas-Peucker drops one of the two corner vertices and skews the wall beside it (an L-shaped corridor lost 1% of its area that way).

The defaults are starting points. Tune them with `pnpm test:venue` once recorded meshes exist (below).

## Display conversion

`toDisplayGeoJSON(polygons, transform)` and `localToLonLat(x, z, transform)` place local geometry on the map **for display only**. `transform` is the WGS84 position of a reference point (`lon`, `lat`, for example the start anchor's street prior or a GNSS fix), that point's position in the session frame (`local`, default the session origin), and `headingDeg`, the bearing of the session's −z axis (ARKit's forward at session start) in degrees clockwise from true north. `headingFromDirection(dx, dz, bearingDeg)` derives the heading from any session direction whose bearing is known, such as a door's facing. Each feature carries `approximate: true` and `areaM2`; coordinates are rounded to 1e-8° (about 1 mm).

The conversion is a local tangent plane (equirectangular) approximation using the WGS84 ellipsoid's radii of curvature at the reference latitude. At Singapore's latitude (about 1.3°N), against Vincenty's direct formula, it is at most 0.2 mm off for points 300 m from the reference (tested at City Hall and Esplanade MRT; the test bound is 1 mm). A spherical earth would be 1.7 m off at 300 m, mostly north-south, which is why the ellipsoid's radii are used. The real errors are elsewhere: each degree of heading error moves a point 300 m away by 5.2 m, and the reference position is metres off. So nothing converted here is ever uploaded as a position; the server's network adjustment is the authority ([ADR 0008](../../docs/decisions/0008-anchors-and-georeferencing.md)).

## Performance

Two synthetic meshes from `src/synthetic.ts`, the same layout at two densities:

- **realistic** (`syntheticCorridorMesh("realistic")`): a 150 m × 6 m underground link with three side halls and an exit stub, 13 pillars, an unscanned patch, two unmeshed strips, 1.5% of triangles dropped, triangles from 0.1 m to 0.5 m on a side with jittered vertices, 950 noise triangles (strays beyond the walls, overlapping duplicates, slivers), rotated 34° as an arbitrary session heading would leave it: 106,077 triangles, about 75 per m² of floor.
- **dense** (`syntheticCorridorMesh("dense")`): the same layout and noise, with the floor as 5 cm squares on a lattice in the session's axes, as a voxel-based reconstruction might mesh it, so every wall is a staircase: 1,105,344 triangles, about 790 per m².

Median of 21 runs (9 for `--jitless`) on Node 26.12, Intel Core i9-14900KF, Windows 11 (2026-10-15):

| Stage | realistic, JIT, ms | realistic, `--jitless`, ms | dense, JIT, ms | dense, `--jitless`, ms |
| --- | ---: | ---: | ---: | ---: |
| prepare (checks, grid angle, extent) | 2.7 | 72.3 | 13.4 | 370.6 |
| rasterise | 3.1 | 44.6 | 17.1 | 357.6 |
| close | 4.2 | 73.3 | 3.9 | 73.7 |
| islands | 1.7 | 14.5 | 1.7 | 14.7 |
| trace | 0.4 | 5.5 | 0.4 | 5.5 |
| simplify | 0.0 | 0.3 | 0.3 | 7.1 |
| coverage | 0.3 | 4.5 | 0.2 | 4.3 |
| **total** | **12.4** | **215.2** | **37.1** | **833.8** |

For both, the aligned grid is 1510 × 290 cells (438k). The realistic mesh gives 364 vertices and the dense one 1190, from its staircase walls. On the session axes (`gridAngleRad: 0`) the realistic grid is 1304 × 958 (1.25M cells) and the outline has 1913 vertices; it takes 10.8 ms (165.4 ms `--jitless`), because the angle search costs about 45 ms in the interpreter and the empty cells cost almost nothing. Alignment is kept as the default for its smaller memory and cleaner outlines. Memory is about 8 bytes per grid cell (four byte masks and an Int32 label grid) plus 4 bytes per walkable cell: about 4 MB here, and 32 MB at the 4M-cell limit. The input itself is 24 bytes per triangle (26 MB for the dense mesh).

The time depends on the mesh's density more than on the algorithm. Checking the input and rasterising cost about 0.6 µs per triangle in `--jitless`, and the angle search and grid stages about 150 ms for this layout, so 2 s under `--jitless` is about 3 million floor triangles. How many floor triangles ARKit makes per m² isn't published; the floor-triangle export task records it from the first recorded mesh.

Hermes has no JIT, so on the phone it will be much slower than the JIT columns. `node --jitless` (V8's interpreter only) is a rough stand-in; Hermes's interpreter and the phone's CPU differ, so the on-phone benchmark in the backlog is the number that counts, on a recorded mesh. The backlog's threshold is about 2 s: roughly a 9× margin over the realistic mesh's `--jitless` figure, but only 2.4× over the dense one's. If the phone misses it, ADR 0007 moves only the rasterise step into Swift, behind the same signature. On a dense mesh that saves only about half the per-triangle time: the input checks and the extent pass in `prepare` cost about as much again.

Reproduce with:

```bash
pnpm --filter @usg/floorplan bench            # Node with the JIT
pnpm --filter @usg/floorplan bench --jitless  # interpreter only
```

`--jitless` turns off WebAssembly, which Node's TypeScript type stripping needs, so the script first strips the sources to JavaScript in a temporary directory with `module.stripTypeScriptTypes` (experimental in Node 26: it prints a warning). `test/benchmark.test.ts` checks the same mesh's result in `pnpm test` with a generous 5 s bound, so only a pathological regression fails it.

## Synthetic meshes

`@usg/floorplan/synthetic` exports the seeded mesh generator the tests use, so the mapper app can time the pipeline in Hermes on the phone before any recorded mesh exists. `syntheticCorridorMesh("realistic")` and `syntheticCorridorMesh("dense")` are the benchmark meshes above (the first is also `uplCorridorMesh()`); `syntheticCorridorMesh("small")` is a 40 m × 6 m corridor with one side hall, 4 pillars, the unscanned patch and one unmeshed strip: 24,546 triangles. Each returns the triangles plus what an ideal plan contains (walkable area, holes). The dense mesh's plan comes out about 1.6% larger, because the close fills the walls' voxel steps, and its holes about 30% smaller for the same reason. Nothing in it was recorded in a venue.

## Tests

`pnpm test` (the `unit` Vitest project) runs on synthetic meshes generated in code with a seeded PRNG (`src/synthetic.ts`): an L-shaped corridor at several headings and offsets, the grid angle on meshes stored in lattice order, a corridor with a pillar, disconnected areas, gaps narrower and wider than the close, a noisy triangle soup, empty and degenerate input, the extent and work limits, the coverage states (including an island inside a hole), the display conversion against Vincenty's formula at City Hall coordinates, environment neutrality, and the three synthetic corridors.

`pnpm test:venue` (the `venue` project, an uncached Turborepo task) runs the pipeline on meshes recorded in a venue, which never go in git (CLAUDE.md fixture rule). Put them in the git-ignored `.data/fixtures/floorplan/` at the repo root as either:

- `*.ply` (preferred): a bundle's `mesh/scene.ply` in the layout of [capture-bundle.md](../../docs/capture-bundle.md#meshsceneply); its floor faces are projected onto x/z, as `floorTriangles` does. It keeps the heights and every face's classification, so the same fixtures can tune a height filter later; or
- `*.f32`: a `floorTriangles` result saved as raw little-endian float32 x,z pairs. It has lost the heights, so save the `.ply` as well when you can.

The test checks the output's invariants and prints each mesh's counts and timings: triangles, observed, walkable and gap cells, polygons, holes and vertices. Areas are printed as cell counts, not square metres; whether square metres are fine to print is a question for the owner. With no files it reports one skipped test.

The venue tests print no values, so an AI agent may run them (CLAUDE.md: aggregate results only). They assert through `check(condition, message)` and `checkWellFormed(polygons, what)` in `test/check.ts`, which throw a plain `CheckError` whose message names only the file and the item ("station.ply polygons: outer ring of polygon 3 is not closed"). They never use Vitest's matchers, whose failure diffs print both values, or snapshot matchers. A pipeline error is rethrown with only its `code` or name, since `FloorplanExtentError` carries the mesh's extent, and the log leaves out the grid angle, which is the corridor's heading in the session frame, and the grid's width and height, which at 0.1 m cells give the floor's extent along the corridor. `test/value-free.test.ts`, in the `unit` project, reads every file in `test/venue/` and every file under `test/` they import (not the library in `src/`, which has no dependencies), and fails anywhere but in a comment that starts a line on `expect`, `assert`, `should`, `chai` or a snapshot matcher, and on `gridWidth`, `gridHeight`, `gridAngleRad` or `extentM`; planted sources show it catching each, through an imported helper and the test context too. The unit tests' `expectWellFormed` runs the same `checkWellFormed`.

## Environment neutrality

Both entries, `.` and `./synthetic`, run in Hermes, browsers and Node: no Node or DOM globals, no `node:` imports, no `eval` or `new Function`, no WebAssembly, no dependencies. Timings use `performance.now()` when the global exists, else `Date.now()`, or the `now` option. `pnpm typecheck` also runs `tsc -p tsconfig.neutral.json`, which compiles both entries with only the ES2024 library, and `test/neutral.test.ts` checks that the entries reach only this package's files and that the source uses none of the APIs above.

`biome.json` here turns off `noNonNullAssertion` for `src/`: with `noUncheckedIndexedAccess`, every typed-array read in the hot loops would otherwise need `?? 0`, a runtime check per access that Hermes, without a JIT, can't optimise away.

## Limits

- One plan per segment: heights are ignored, so floors at different levels overlap, including floor below seen across an atrium (see Input).
- The output's size is bounded only through the grid, at a few ring vertices per cell at worst: a pathological mesh (a lattice of tiny holes, say) can trace a hundred thousand rings and take hundreds of MB. Processing should lower `maxCells` for untrusted bundles (Phase 4).
- Douglas-Peucker can make two rings touch, or a ring cross itself, where the walkable area is one or two cells wide. Map rendering doesn't mind; code that needs valid polygons (PostGIS) should run `ST_MakeValid`.
- Areas touching only at a corner are separate, and so are a hole's diagonal neighbours: walkable cells connect through edges only.
- The close's disc rounds the corners of the holes it keeps (a 1 m pillar shows as about 0.86 m²), and bridged cells are guesses: the coverage grid marks them.
