import { describe, expect, test } from "vitest";
import { formatMs, medianMs, runBenchmark, STAGES } from "../src/floorplan/benchmark.ts";
import { svgScene } from "../src/floorplan/svg.ts";

describe("runBenchmark", () => {
  test("plans the small synthetic corridor and times every stage", () => {
    const run = runBenchmark("small");
    expect(run.size).toBe("small");
    expect(run.stats.triangles).toBeGreaterThan(20_000);
    expect(run.polygons).toHaveLength(1);
    expect(run.polygons[0]?.holes.length).toBeGreaterThanOrEqual(5);
    // Pillars and the patch are holes; the strip across the corridor is a bridged gap.
    expect(run.gaps.length).toBeGreaterThanOrEqual(6);
    for (const stage of STAGES) expect(run.stats.timingsMs[stage]).toBeGreaterThanOrEqual(0);
    const sum = STAGES.reduce((total, stage) => total + run.stats.timingsMs[stage], 0);
    expect(run.stats.timingsMs.total).toBeCloseTo(sum, 6);
    expect(run.meshMs).toBeGreaterThan(0);
  });

  test("uses the clock it is given", () => {
    let t = 0;
    const run = runBenchmark("small", () => (t += 10));
    // Mesh: two reads, 10 ms apart.
    expect(run.meshMs).toBe(10);
    expect(run.stats.timingsMs.prepare).toBe(10);
  });
});

describe("medianMs and formatMs", () => {
  test("median of odd and even counts", () => {
    expect(medianMs([])).toBeNull();
    expect(medianMs([5])).toBe(5);
    expect(medianMs([9, 1, 5])).toBe(5);
    expect(medianMs([4, 1, 3, 2])).toBe(2.5);
  });

  test("one decimal below 100 ms", () => {
    expect(formatMs(12.345)).toBe("12.3");
    expect(formatMs(99.94)).toBe("99.9");
    expect(formatMs(214.6)).toBe("215");
  });
});

describe("svgScene", () => {
  const square = {
    outer: [
      [0, 0],
      [0, 10],
      [10, 10],
      [10, 0],
      [0, 0],
    ] as [number, number][],
    holes: [
      [
        [4, 4],
        [6, 4],
        [6, 6],
        [4, 6],
        [4, 4],
      ] as [number, number][],
    ],
    areaM2: 96,
  };

  test("draws the outline and holes as one path, in a viewBox with a margin", () => {
    const scene = svgScene([square], [], 1);
    expect(scene?.viewBox).toBe("-1 -1 12 12");
    expect(scene?.aspect).toBe(1);
    expect(scene?.outlines).toEqual(["M0 0L0 10L10 10L10 0ZM4 4L6 4L6 6L4 6Z"]);
    expect(scene?.gaps).toEqual([]);
  });

  test("rounds to centimetres and has nothing to draw without polygons", () => {
    const scene = svgScene([{ ...square, outer: square.outer.map(([x, z]) => [x + 0.123456, z]) }]);
    expect(scene?.outlines[0]?.startsWith("M0.12 0L0.12 10")).toBe(true);
    expect(svgScene([])).toBeNull();
  });
});
