# @usg/recording

Session recordings on the PC ([docs/session-recording.md](../../docs/session-recording.md), [ADR 0010](../../docs/decisions/0010-capture-recording-and-replay.md)). For now it holds the synthetic replay sets, `pnpm rec synth`, and the git check that keeps every other recording out of the public repo. The reader, `meshAt(t)`, `deriveBundle` and the `pull | import | ls | review | delete` commands come after the first corridor walk ([backlog](../../docs/backlog.md#session-recordings-packagescontracts-packagesrecording-appsmapper)).

| Entry | What it is |
| --- | --- |
| `.` (`src/index.ts`) | Environment-neutral, so the mapper app's trace-playing fake can share it: the set builders and `deflateRaw` |
| `./node` (`src/node/index.ts`) | Node only: writing sets (`synthesize`, `writeSet`, the output-path check), UUIDv5 and SHA-256, and the git check (`checkIndex`, `checkPush`) |

## Synthetic replay sets

```sh
pnpm rec synth                    # rewrites packages/recording/fixtures/synthetic/<set>/
pnpm rec synth --out .data/synth  # or anywhere under the git-ignored .data/
```

Sets are generated files, as `pnpm gen`'s output is: never edit them by hand. CI runs `pnpm rec synth` and fails on any difference, fails if they hold no tracked `recording.json`, and runs `validate-recording` on them. `pnpm rec synth` refuses an output path outside `fixtures/synthetic/` and `.data/`, symbolic links resolved. In `fixtures/synthetic/` it also removes every directory that isn't a set, so CI's diff shows anything copied in beside them. A set's directory must not be named `rec-*` or `replay-*`: `.gitignore` ignores those anywhere and re-includes only `fixtures/synthetic/**/rec-*/`.

**`corridor-lean`** is one `lean` recording (`rec-<uuidv5>/`, `origin: synthetic`, `build.profile: synthetic`) with no bundles, as a lean recording made before the blur passes has none. It records 37 s of a walk along a synthetic stand-in for the Exit F link: the owner marks a street-facing start anchor at the street door, walks 39 m down a ramp to B1 at 1.3 m/s, marks the end anchor with End the session here, and the recording closes 5 s later (`end_anchor`). It has every file a lean recording has: frames at 60 Hz with one dropped frame and a moment of limited tracking, IMU and device motion at 100 Hz, the altimeter, telemetry, events, actions, a boundary trace with status at 5 Hz, the mark results and a binary floor-triangles result, and the mesh history.

- **The mesh** is `@usg/floorplan/synthetic`'s small corridor (40 m by 6 m with a side hall, pillars, an unscanned patch and noise), lifted onto the walk's floor heights and cut into 5 m mesh anchors. A triangle appears once the camera has been within 6 m of it, so anchors are added part-scanned and updated as the walk goes on, one anchor moves 3 mm without new geometry (`anchors.jsonl` only), a phantom anchor is added and removed, and the final snapshot repeats each anchor's last block. Blocks are raw DEFLATE from `deflateRaw`, a small encoder in this package whose output depends only on its input: Node's zlib is Chromium's fork, whose output can depend on the CPU, and CI compares bytes.
- **Coordinates.** Poses and the mesh are in the session's ARKit frame, with no georeference. The only real-world values are the GNSS fixes in `location.jsonl`, near the public street door of Esplanade MRT's Exit F, inside the window and within 30 s of the street-facing mark. The door's position is approximate (`EXIT_F_DOOR`); replace it with LTA's MRT Station Exit data once that is imported.
- **Determinism.** Noise comes from seeded PRNGs, numbers are rounded before they are written, UUIDs are UUIDv5 in a fixed namespace, and times are fixed, so every run on every platform writes the same bytes. `.gitattributes` marks the sets `-text`, so no checkout converts line endings and breaks the digests in `recording.json`.

Add a set by writing its builder beside `src/synthetic/corridor-lean.ts`, listing it in `syntheticSets()` (`src/node/synth.ts`), naming its directory in `SYNTHETIC_SET_NAMES` (`src/synthetic/sets.ts`, the names the git check allows) and adding its `validate-recording` step to CI.

## The git check

A pushed branch of the public repo is already published, so the same check runs in CI and in a pre-push hook kept in the repo, [`.githooks/pre-push`](../../.githooks/pre-push). `pnpm install` points git at it (`core.hooksPath`, through the root `prepare` script, [`scripts/install-hooks.ts`](../../scripts/install-hooks.ts)), except in CI and outside a git checkout.

```sh
pnpm check:tracked                  # the index (git ls-files)
node packages/recording/scripts/check-tracked.ts --require-sets   # as CI runs it
```

It fails on:

- any tracked `recording.json` that doesn't say `origin: synthetic` (or isn't JSON), wherever it is;
- `recording.json`, `frames.jsonl`, `boundary.jsonl`, `location.jsonl`, `history.bin`, `poses.jsonl`, `gnss.jsonl`, `parts.json`, `*.part`, anything under a `candidates/` directory, or `capture-*/manifest.json`, outside the generated sets (`fixtures/synthetic/<set>/` for a `<set>` in `SYNTHETIC_SET_NAMES`, so a directory copied in beside them is outside) and the hand-made fixture directories, matched without regard to case;
- with `--require-sets` (CI), no synthetic `recording.json` in the generated sets.

The hook checks every commit the push would publish (each pushed ref's commits that no remote-tracking ref has), not only the tip, so a recording committed and deleted again is still refused. Without Node the hook fails, and so does the push. Output names paths, commits and problem codes, never file contents.

**Hand-made fixture directories:** none today (`HAND_MADE_FIXTURE_DIRS` in `src/node/tracked.ts`). The validators' tests build their recordings and bundles in code, and the Swift goldens in `apps/mapper/modules/capture-native/Tests/CaptureCoreTests/Golden/` are named by type (`GnssLine.jsonl`, `RecordingManifest.json`), which no rule matches. Add a directory there only for synthetic files, in a reviewed change.

## Tests

`pnpm --filter @usg/recording test`: the encoder against `inflateRawSync`; the set against `validate-recording`, against itself across runs and against the tracked copy, and its mesh, coordinates and floor plan; the output-path refusals; the check's rules, and planted `origin: device` recordings and `gnss.jsonl` files in throwaway git repos. `pnpm test:repo` (the `repo` project, an uncached Turborepo task, part of `pnpm check` and CI) checks this repo's own tree and the pre-push hook refusing a real push to a local bare remote: neither the index nor `.githooks/` is in the package's Turborepo hash, so a cached pass could hide a broken hook.
