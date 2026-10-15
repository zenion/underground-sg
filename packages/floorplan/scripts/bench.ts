// Times buildFloorplan on the realistic synthetic mesh (src/synthetic.ts), with the grid lined up
// and on the session axes, and on the dense variant (about 1.1M triangles): median per stage.
//
//   pnpm --filter @usg/floorplan bench [--runs 15] [--jitless]
//
// --jitless reruns the benchmark in `node --jitless`, which has only V8's interpreter: a rough
// stand-in for Hermes, which has no JIT either. Node can't strip TypeScript types without
// WebAssembly, which --jitless turns off, so the files are stripped to JavaScript in a temporary
// directory first.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildFloorplan, type FloorplanOptions, type StageTimings } from "../src/index.ts";
import { type CorridorMesh, syntheticCorridorMesh } from "../src/synthetic.ts";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "15" },
    jitless: { type: "boolean", default: false },
  },
});
const runs = Number(values.runs);
if (!(Number.isInteger(runs) && runs > 0)) throw new Error("--runs takes a positive integer");

if (values.jitless) {
  process.exitCode = runJitless(runs);
} else {
  bench(runs);
}

function bench(count: number): void {
  const realistic = syntheticCorridorMesh("realistic");
  const dense = syntheticCorridorMesh("dense");
  const mode = process.execArgv.includes("--jitless")
    ? "node --jitless (interpreter only)"
    : "node";
  console.log(`${mode} ${process.version}, median of ${count} runs after 2 warm-up runs`);
  const cases: [string, CorridorMesh, FloorplanOptions][] = [
    ["realistic, grid lined up with the walls (default)", realistic, {}],
    ["realistic, grid on the session axes (gridAngleRad 0)", realistic, { gridAngleRad: 0 }],
    ["dense, grid lined up with the walls (default)", dense, {}],
  ];
  for (const [name, mesh, options] of cases) {
    for (let i = 0; i < 2; i++) buildFloorplan(mesh.triangles, options);
    const timings: StageTimings[] = [];
    let last = buildFloorplan(mesh.triangles, options);
    for (let i = 0; i < count; i++) {
      last = buildFloorplan(mesh.triangles, options);
      timings.push(last.stats.timingsMs);
    }
    const { stats } = last;
    console.log(
      `\n${name}: ${stats.triangles} triangles (${mesh.floorTriangles} floor, ` +
        `${mesh.noiseTriangles} noise), grid ${stats.gridWidth} x ${stats.gridHeight} ` +
        `(${stats.gridWidth * stats.gridHeight} cells), ${stats.polygons} polygon, ` +
        `${stats.holes} holes, ${stats.vertices} vertices`,
    );
    console.log("| Stage | ms |\n| --- | ---: |");
    for (const stage of Object.keys(timings[0] ?? {}) as (keyof StageTimings)[]) {
      const sorted = timings.map((t) => t[stage]).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      console.log(`| ${stage} | ${median.toFixed(1)} |`);
    }
  }
}

/** Strips src/ and this script to JavaScript and runs it with --jitless. */
function runJitless(count: number): number {
  const out = mkdtempSync(join(tmpdir(), "usg-floorplan-bench-"));
  try {
    const files = [
      ...readdirSync(join(PACKAGE_DIR, "src")).map((name) => join("src", name)),
      join("scripts", "bench.ts"),
    ];
    for (const file of files) {
      const source = readFileSync(join(PACKAGE_DIR, file), "utf8");
      const javascript = stripTypeScriptTypes(source).replace(
        /(from\s+"\.{1,2}\/[^"]+)\.ts"/g,
        '$1.js"',
      );
      const target = join(out, file.replace(/\.ts$/, ".js"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, javascript);
    }
    writeFileSync(join(out, "package.json"), '{ "type": "module" }\n');
    const child = spawnSync(
      process.execPath,
      ["--jitless", join(out, "scripts", "bench.js"), "--runs", String(count)],
      { stdio: "inherit" },
    );
    return child.status ?? 1;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
