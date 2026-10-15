import { describe, expect, test } from "vitest";
import {
  buildFloorplan,
  CELL_BRIDGED,
  CELL_HOLE,
  CELL_OBSERVED,
  CELL_OUTSIDE,
  coverageCellCenter,
  DEFAULT_FLOORPLAN_OPTIONS,
  FloorplanExtentError,
  FloorplanWorkError,
  ringArea,
  traceCoverage,
} from "../src/index.ts";
import { sampleTriangles, scanTriangles } from "../src/prepare.ts";
import { prng, rect, Triangles, transform } from "../src/synthetic.ts";
import { bounds, expectWellFormed, insidePolygon, insideRing } from "./helpers.ts";

// Synthetic meshes in a design frame of metres: x along the corridor, z across it. Rotations and
// offsets stand in for an ARKit session's arbitrary heading and origin.

const lShape = (): Triangles =>
  new Triangles().addRect(rect(0, 0, 20, 3)).addRect(rect(17, 3, 20, 15));

describe("L-shaped corridor", () => {
  test("gives one polygon with the right area, few vertices and no holes", () => {
    const { polygons, stats } = buildFloorplan(lShape().toFloat32());
    expectWellFormed(polygons);
    expect(polygons).toHaveLength(1);
    const [polygon] = polygons;
    expect(polygon?.holes).toEqual([]);
    // 96 m², give or take half-cell corner cuts and the close rounding the inner corner.
    expect(polygon?.areaM2).toBeCloseTo(96, 0);
    // Six corners, each cut into two vertices by marching squares.
    expect(polygon?.outer.length).toBeLessThanOrEqual(13);
    expect(bounds([polygon?.outer ?? []])).toEqual([
      expect.closeTo(0, 1),
      expect.closeTo(0, 1),
      expect.closeTo(20, 1),
      expect.closeTo(15, 1),
    ]);
    expect(stats.gridAngleRad).toBe(0);
    expect(stats.polygons).toBe(1);
    expect(stats.holes).toBe(0);
  });

  test("comes out the same at any heading and offset", () => {
    const reference = buildFloorplan(lShape().toFloat32()).polygons[0];
    for (const [angle, tx, tz] of [
      [0.5236, 3, -2],
      [1.1, -120, 45],
      [2.7, 500, -800],
      [-0.9, 0.3, 0.7],
    ] as const) {
      const result = buildFloorplan(transform(lShape().values, angle, tx, tz));
      expectWellFormed(result.polygons);
      expect(result.polygons).toHaveLength(1);
      const polygon = result.polygons[0];
      expect(polygon?.areaM2).toBeCloseTo(reference?.areaM2 ?? 0, 1);
      expect(polygon?.outer.length).toBeLessThanOrEqual(13);
      // The grid lines up with the walls, modulo 90°.
      const quarter = Math.PI / 2;
      const expected = ((angle % quarter) + quarter) % quarter;
      const off = Math.abs(result.stats.gridAngleRad - expected);
      expect(Math.min(off, quarter - off)).toBeLessThan(0.002);
      // The corner at design (20, 15) maps to where the transform puts it.
      const corner = transform([20, 15], angle, tx, tz);
      const nearest = Math.min(
        ...(polygon?.outer ?? []).map(([x, z]) =>
          Math.hypot(x - (corner[0] ?? 0), z - (corner[1] ?? 0)),
        ),
      );
      expect(nearest).toBeLessThan(0.1);
    }
  });

  test("a fixed grid angle of 0 needs more cells and vertices for a diagonal corridor", () => {
    const diagonal = transform(lShape().values, Math.PI / 6);
    const aligned = buildFloorplan(diagonal);
    const fixed = buildFloorplan(diagonal, { gridAngleRad: 0 });
    expect(fixed.stats.gridAngleRad).toBe(0);
    expect(fixed.polygons[0]?.areaM2).toBeCloseTo(aligned.polygons[0]?.areaM2 ?? 0, 0);
    expect(fixed.stats.gridWidth * fixed.stats.gridHeight).toBeGreaterThan(
      aligned.stats.gridWidth * aligned.stats.gridHeight,
    );
    expect(fixed.stats.vertices).toBeGreaterThan(aligned.stats.vertices);
  });
});

describe("grid angle", () => {
  // One jittered lattice of `step` squares stored column by column, as a scanner may store a mesh.
  // Every nth triangle of such a mesh is itself a lattice with sharp projections, so an angle
  // search on every nth triangle lined the grid up with that lattice: 26.7° and 9.4° off here,
  // with grids of 197 x 304 and 414 x 133 cells and over 300 vertices.
  const latticeCorridor = (lengthM: number, widthM: number, step: number): number[] => {
    const random = prng(3);
    const nx = Math.round(lengthM / step);
    const nz = Math.round(widthM / step);
    const xs = new Float64Array((nx + 1) * (nz + 1));
    const zs = new Float64Array((nx + 1) * (nz + 1));
    for (let i = 0; i <= nx; i++) {
      for (let j = 0; j <= nz; j++) {
        const edge = i === 0 || j === 0 || i === nx || j === nz;
        const k = i * (nz + 1) + j;
        xs[k] = i * step + (edge ? 0 : (random() * 2 - 1) * 0.15 * step);
        zs[k] = j * step + (edge ? 0 : (random() * 2 - 1) * 0.15 * step);
      }
    }
    const values: number[] = [];
    const vertex = (k: number): void => {
      values.push(xs[k] ?? 0, zs[k] ?? 0);
    };
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const a = i * (nz + 1) + j;
        const b = a + nz + 1;
        for (const k of [a, b, b + 1, a, b + 1, a + 1]) vertex(k);
      }
    }
    return values;
  };

  test("lines up with the walls when the mesh is stored in lattice order", () => {
    const quarter = Math.PI / 2;
    for (const [lengthM, step, heading] of [
      [30, 0.1, 0.2],
      [40, 0.07, 0.2],
    ] as const) {
      const { polygons, stats } = buildFloorplan(
        transform(latticeCorridor(lengthM, 6, step), heading, 3, -2),
      );
      const off = Math.abs(stats.gridAngleRad - (heading % quarter));
      const label = `${lengthM} m at ${step} m, heading ${heading}`;
      // The search resolves about one 0.2 m bin over the corridor's length: 0.4° on 30 m.
      expect(Math.min(off, quarter - off), label).toBeLessThan((0.5 * Math.PI) / 180);
      // 6 m is 60 cells plus padding.
      expect(stats.gridHeight, label).toBeLessThan(75);
      // Straight walls a cell or so off the grid's axis still leave steps, hence not 8.
      expect(stats.vertices, label).toBeLessThan(100);
      expect(polygons).toHaveLength(1);
      expect(polygons[0]?.areaM2).toBeCloseTo(lengthM * 6, -1);
    }
  });

  test("samples distinct valid triangles, the same on every run", () => {
    const mesh = new Triangles().addRect(rect(0, 0, 40, 6), 0.1);
    // Every third triangle degenerate.
    for (let t = 0; t < mesh.count; t += 3) mesh.values.fill(0, t * 6, t * 6 + 6);
    const triangles = mesh.toFloat32();
    const scan = scanTriangles(triangles);
    const sample = sampleTriangles(scan);
    expect(sample.length).toBeGreaterThan(1900);
    expect(sample.length).toBeLessThanOrEqual(2048);
    expect(new Set(sample).size).toBe(sample.length);
    for (const t of sample) expect(scan.valid[t]).toBe(1);
    expect(sampleTriangles(scanTriangles(triangles))).toEqual(sample);
    // At most 2048 valid triangles: all of them.
    const small = scanTriangles(new Triangles().addRect(rect(0, 0, 4, 2), 0.1).toFloat32());
    expect([...sampleTriangles(small)]).toEqual(Array.from({ length: 1600 }, (_, t) => t));
  });
});

describe("corridor with a pillar", () => {
  const pillar = rect(14, 2.5, 15, 3.5);
  const corridor = (): Triangles => new Triangles().addRect(rect(0, 0, 30, 6), 0.25, [pillar]);

  test("keeps the pillar as a clockwise hole", () => {
    const { polygons, stats } = buildFloorplan(corridor().toFloat32());
    expectWellFormed(polygons);
    expect(polygons).toHaveLength(1);
    const [polygon] = polygons;
    expect(polygon?.holes).toHaveLength(1);
    const hole = polygon?.holes[0] ?? [];
    expect(ringArea(hole)).toBeLessThan(0);
    // The close rounds the hole's corners, so it is a little under 1 m².
    expect(-ringArea(hole)).toBeGreaterThan(0.8);
    expect(-ringArea(hole)).toBeLessThan(1.01);
    expect(insideRing(hole, 14.5, 3)).toBe(true);
    expect(insidePolygon(polygon ?? { outer: [], holes: [], areaM2: 0 }, 14.5, 3)).toBe(false);
    expect(polygon?.areaM2).toBeCloseTo(180 + ringArea(hole), 1);
    expect(stats.holes).toBe(1);
  });

  test("keeps the hole when the corridor is rotated", () => {
    const { polygons } = buildFloorplan(transform(corridor().values, 2.2, 40, -7));
    expectWellFormed(polygons);
    expect(polygons).toHaveLength(1);
    expect(polygons[0]?.holes).toHaveLength(1);
    const [x, z] = transform([14.5, 3], 2.2, 40, -7);
    expect(insideRing(polygons[0]?.holes[0] ?? [], x ?? 0, z ?? 0)).toBe(true);
  });

  test("fills a pillar narrower than the close bridges, and holes under minHoleAreaM2", () => {
    const thin = new Triangles().addRect(rect(0, 0, 30, 6), 0.125, [rect(14, 2.5, 14.25, 3.5)]);
    expect(buildFloorplan(thin.toFloat32()).polygons[0]?.holes).toEqual([]);
    expect(
      buildFloorplan(corridor().toFloat32(), { minHoleAreaM2: 1.5 }).polygons[0]?.holes,
    ).toEqual([]);
  });
});

describe("disconnected areas", () => {
  test("give separate polygons, largest first", () => {
    const mesh = new Triangles().addRect(rect(0, 0, 10, 4)).addRect(rect(20, 0, 35, 4));
    const { polygons } = buildFloorplan(mesh.toFloat32());
    expectWellFormed(polygons);
    expect(polygons).toHaveLength(2);
    expect(polygons[0]?.areaM2).toBeCloseTo(60, 0);
    expect(polygons[1]?.areaM2).toBeCloseTo(40, 0);
    expect(insidePolygon(polygons[0] ?? { outer: [], holes: [], areaM2: 0 }, 27, 2)).toBe(true);
    expect(insidePolygon(polygons[1] ?? { outer: [], holes: [], areaM2: 0 }, 5, 2)).toBe(true);
  });

  test("areas touching only at a corner stay apart", () => {
    const mesh = new Triangles().addRect(rect(0, 0, 5, 5)).addRect(rect(5, 5, 10, 10));
    const { polygons } = buildFloorplan(mesh.toFloat32(), { closeRadiusM: 0 });
    expect(polygons).toHaveLength(2);
  });
});

describe("gaps", () => {
  const twoParts = (gap: number): Float32Array =>
    new Triangles()
      .addRect(rect(0, 0, 10, 3))
      .addRect(rect(10 + gap, 0, 20 + gap, 3))
      .toFloat32();

  test("narrower than the close radius are bridged", () => {
    const { polygons, stats } = buildFloorplan(twoParts(0.15));
    expect(DEFAULT_FLOORPLAN_OPTIONS.closeRadiusM).toBe(0.2);
    expectWellFormed(polygons);
    expect(polygons).toHaveLength(1);
    expect(polygons[0]?.areaM2).toBeCloseTo(60.45, 0);
    // One column of 30 cells, less a notch at each wall: the disc can't fill the end cells.
    expect(stats.bridgedCells).toBe(28);
  });

  test("up to about twice the radius are bridged too", () => {
    expect(buildFloorplan(twoParts(0.35)).polygons).toHaveLength(1);
  });

  test("wider than twice the radius are kept", () => {
    for (const gap of [0.5, 0.8, 2]) {
      const { polygons } = buildFloorplan(twoParts(gap));
      expectWellFormed(polygons);
      expect(polygons, `gap ${gap} m`).toHaveLength(2);
    }
  });

  test("follow the configured radius, and stay open without a close", () => {
    expect(buildFloorplan(twoParts(0.8), { closeRadiusM: 0.5 }).polygons).toHaveLength(1);
    expect(buildFloorplan(twoParts(0.15), { closeRadiusM: 0 }).polygons).toHaveLength(2);
  });
});

describe("noisy triangle soup", () => {
  test("still gives one corridor of about the right area", () => {
    const random = prng(7);
    const mesh = new Triangles();
    // A 40 m x 4 m corridor of jittered triangles with 3% dropped.
    const step = 0.2;
    for (let x = 0; x < 40 - 1e-9; x += step) {
      for (let z = 0; z < 4 - 1e-9; z += step) {
        const j = (): number => (random() - 0.5) * 0.06;
        const ax = x + (x > 0 ? j() : 0);
        const az = z + (z > 0 ? j() : 0);
        if (random() > 0.03) mesh.add(ax, az, x + step, z, x + step, z + step);
        if (random() > 0.03) mesh.add(ax, az, x + step, z + step, x, z + step);
      }
    }
    // Overlapping duplicates, strays beyond the walls and slivers.
    for (let k = 0; k < 400; k++) {
      const x = random() * 39;
      const z = random() * 3.5;
      mesh.add(x, z, x + 0.3 * random(), z + 0.2, x + 0.1, z + 0.4 * random());
    }
    for (let k = 0; k < 150; k++) {
      const x = random() * 40;
      const z = random() < 0.5 ? -1 - random() * 3 : 5 + random() * 3;
      mesh.add(x, z, x + 0.1, z, x, z + 0.1);
    }
    for (let k = 0; k < 40; k++) mesh.add(k, 1, k + 0.5, 1.5, k + 1, 2);
    const triangles = transform(mesh.values, 0.3, 10, 10);
    const { polygons, stats } = buildFloorplan(triangles);
    expectWellFormed(polygons);
    expect(polygons).toHaveLength(1);
    expect(polygons[0]?.holes).toEqual([]);
    expect(polygons[0]?.areaM2).toBeGreaterThan(160 * 0.97);
    expect(polygons[0]?.areaM2).toBeLessThan(160 * 1.03);
    expect(stats.removedIslands).toBeGreaterThan(100);
    expect(stats.skippedTriangles).toBe(40);
    expect(stats.bridgedCells).toBeGreaterThan(0);
  });
});

describe("empty and degenerate input", () => {
  test("no triangles give no polygons and an empty grid", () => {
    const { polygons, coverage, stats } = buildFloorplan(new Float32Array(0));
    expect(polygons).toEqual([]);
    expect(coverage.width).toBe(0);
    expect(coverage.height).toBe(0);
    expect(coverage.cells).toHaveLength(0);
    expect(stats.triangles).toBe(0);
    expect(stats.polygons).toBe(0);
    expect(traceCoverage(coverage, [CELL_HOLE])).toEqual([]);
  });

  test("degenerate and non-finite triangles are skipped and counted", () => {
    const junk = [
      [0, 0, 0, 0, 0, 0], // one point
      [0, 0, 1, 1, 2, 2], // collinear
      [5, 5, 5, 5, 6, 6], // repeated vertex
      [Number.NaN, 0, 1, 0, 0, 1],
      [0, Number.POSITIVE_INFINITY, 1, 0, 0, 1],
      [Number.NEGATIVE_INFINITY, 0, 1, 0, 0, 1],
      [1e-6, 0, 0, 1e-6, 0, 0], // 5e-13 m²
    ];
    const onlyJunk = buildFloorplan(Float32Array.from(junk.flat()));
    expect(onlyJunk.polygons).toEqual([]);
    expect(onlyJunk.stats.skippedTriangles).toBe(junk.length);

    const clean = buildFloorplan(lShape().toFloat32());
    const mixed = new Triangles();
    mixed.values.push(...junk.flat(), ...lShape().values, ...junk.flat());
    const dirty = buildFloorplan(mixed.toFloat32());
    expect(dirty.polygons).toEqual(clean.polygons);
    expect(dirty.stats.skippedTriangles).toBe(2 * junk.length);
    expect(dirty.stats.triangles).toBe(clean.stats.triangles + 2 * junk.length);
  });

  test("slivers are skipped, as when a steep face classified as floor is projected", () => {
    // A 1 m x 0.1 mm sliver, and a 2 cm x 1 cm triangle that is small but well shaped.
    const sliver = Float32Array.from([10, 10, 11, 10, 10.5, 10.0001]);
    expect(buildFloorplan(sliver).stats.skippedTriangles).toBe(1);
    const small = Float32Array.from([10, 10, 10.02, 10, 10, 10.01]);
    expect(buildFloorplan(small).stats.skippedTriangles).toBe(0);
  });

  test("one tiny triangle still marks a cell, then goes as an island", () => {
    const tiny = Float32Array.from([1, 1, 1.02, 1, 1, 1.02]);
    const kept = buildFloorplan(tiny, {
      minIslandAreaM2: 0,
      minPolygonAreaM2: 0,
      simplifyToleranceM: 0,
    });
    expect(kept.stats.observedCells).toBe(1);
    expect(kept.polygons).toHaveLength(1);
    expect(buildFloorplan(tiny).polygons).toEqual([]);
  });

  test("input that isn't whole triangles is refused", () => {
    expect(() => buildFloorplan(new Float32Array(7))).toThrow(RangeError);
    expect(() => buildFloorplan(new Float32Array(4))).toThrow(/multiple of 6/);
  });

  test("bad options are refused", () => {
    const mesh = lShape().toFloat32();
    for (const options of [
      { cellSizeM: 0 },
      { cellSizeM: -0.1 },
      { cellSizeM: Number.NaN },
      { closeRadiusM: -1 },
      { closeRadiusM: 30 },
      { minIslandAreaM2: Number.POSITIVE_INFINITY },
      { simplifyToleranceM: -0.01 },
      { minPolygonAreaM2: Number.NaN },
      { minHoleAreaM2: -1 },
      { gridAngleRad: Number.NaN },
      { maxCells: 0 },
      { maxCells: 1.5 },
      { maxCells: 2 ** 29 },
    ]) {
      expect(() => buildFloorplan(mesh, options), JSON.stringify(options)).toThrow(RangeError);
    }
  });
});

describe("extent limit", () => {
  test("triangles kilometres apart throw a clear error", () => {
    const far = new Triangles().addRect(rect(0, 0, 2, 2)).addRect(rect(9000, 4000, 9002, 4002));
    let error: unknown;
    try {
      buildFloorplan(far.toFloat32());
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FloorplanExtentError);
    const extent = error as FloorplanExtentError;
    expect(extent.code).toBe("FLOORPLAN_EXTENT");
    expect(extent.name).toBe("FloorplanExtentError");
    expect(extent.maxCells).toBe(DEFAULT_FLOORPLAN_OPTIONS.maxCells);
    expect(extent.cells).toBeGreaterThan(extent.maxCells);
    expect(extent.message).toMatch(
      /^Floor triangles span [\d.]+ m by [\d.]+ m, which needs \d+ grid cells/,
    );
    expect(extent.message).toContain("stray triangles");
  });

  test("absurd coordinates throw instead of allocating", () => {
    const absurd = Float32Array.from([
      0,
      0,
      1,
      0,
      0,
      1,
      1e30,
      1e30,
      1e30 + 1e24,
      1e30,
      1e30,
      1e30 + 1e24,
    ]);
    expect(() => buildFloorplan(absurd)).toThrow(FloorplanExtentError);
  });

  test("maxCells and cellSizeM set the limit", () => {
    const mesh = lShape().toFloat32();
    expect(() => buildFloorplan(mesh, { maxCells: 10_000 })).toThrow(FloorplanExtentError);
    expect(buildFloorplan(mesh, { maxCells: 10_000, cellSizeM: 0.25 }).polygons).toHaveLength(1);
  });
});

describe("work limit", () => {
  // 2,000 copies of one 60 m triangle: the grid (about 366k cells) is within maxCells, but
  // rasterising every copy would visit 360M cells. The limit stops it after a few dozen.
  const copies = (count: number): Float32Array => {
    const triangle = [0, 0, 60, 0, 0, 60];
    return Float32Array.from({ length: count * 6 }, (_, i) => triangle[i % 6] ?? 0);
  };

  test("many large overlapping triangles throw a clear error instead of taking minutes", () => {
    let error: unknown;
    try {
      buildFloorplan(copies(2000));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FloorplanWorkError);
    const work = error as FloorplanWorkError;
    expect(work.code).toBe("FLOORPLAN_WORK");
    expect(work.name).toBe("FloorplanWorkError");
    expect(work.validTriangles).toBe(2000);
    expect(work.rasterised).toBeGreaterThan(20);
    expect(work.rasterised).toBeLessThan(50);
    expect(work.limit).toBe(16 * work.cells + 8 * 2000);
    expect(work.message).toMatch(/^Floor triangles overlap far more than a scan's/);
  });

  test("a few overlapping copies are fine", () => {
    const { polygons } = buildFloorplan(copies(5));
    expect(polygons).toHaveLength(1);
    expect(polygons[0]?.areaM2).toBeCloseTo(1800, -1);
  });
});

describe("coverage grid", () => {
  // A 20 m x 4 m corridor with a 1 m x 1 m pillar, an unscanned 0.15 m strip across it and an
  // unscanned 1.2 m x 1 m patch (not a pillar, but the scan can't tell).
  const pillar = rect(5, 1.5, 6, 2.5);
  const patch = rect(12, 1, 13.2, 2);
  const strip = rect(9, 0, 9.15, 4);
  const mesh = (): Triangles =>
    new Triangles()
      .addRect(rect(0, 0, 9, 4), 0.25, [pillar])
      .addRect(rect(9.15, 0, 20, 4), 0.125, [patch]);

  test("marks observed, bridged and hole cells", () => {
    const { polygons, coverage, stats } = buildFloorplan(mesh().toFloat32());
    expect(polygons).toHaveLength(1);
    expect(polygons[0]?.holes).toHaveLength(2);
    const counts = [0, 0, 0, 0];
    for (const state of coverage.cells) counts[state] = (counts[state] ?? 0) + 1;
    expect(counts[CELL_OBSERVED]).toBe(stats.observedCells);
    expect(counts[CELL_BRIDGED]).toBe(stats.bridgedCells);
    expect(counts[CELL_HOLE]).toBe(stats.holeCells);
    expect(counts[CELL_OUTSIDE]).toBe(
      coverage.width * coverage.height - stats.observedCells - stats.bridgedCells - stats.holeCells,
    );
    // 80 m² less the pillar, the patch and the strip.
    expect(stats.observedCells).toBeCloseTo((80 - 1 - 1.2 - 0.6) / 0.01, -2);
    // The strip is bridged: about 0.15 m x 4 m, plus the rounded hole corners.
    expect(stats.bridgedCells).toBeGreaterThan(50);
    expect(stats.bridgedCells).toBeLessThan(110);
    // The pillar and the patch are holes, less their rounded corners.
    expect(stats.holeCells).toBeGreaterThan(180);
    expect(stats.holeCells).toBeLessThanOrEqual(220);
  });

  test("an island inside a hole is walkable, and a removed speck in it stays observed", () => {
    // A 12 m square hall around an unscanned 6 m square, with a 2 m island in the middle of
    // that and a 0.25 m speck (too small to keep) beside the island.
    const ring = [rect(0, 0, 12, 3), rect(0, 9, 12, 12), rect(0, 3, 3, 9), rect(9, 3, 12, 9)];
    const mesh = new Triangles();
    for (const r of ring) mesh.addRect(r);
    mesh.addRect(rect(5, 5, 7, 7)).addRect(rect(4, 4, 4.25, 4.25));
    const { polygons, coverage, stats } = buildFloorplan(mesh.toFloat32());
    expectWellFormed(polygons);
    expect(polygons).toHaveLength(2);
    expect(polygons[0]?.holes).toHaveLength(1);
    expect(polygons[1]?.areaM2).toBeCloseTo(4, 0);
    expect(stats.removedIslands).toBe(1);
    const at = (x: number, z: number): number => {
      for (let row = 0; row < coverage.height; row++) {
        for (let col = 0; col < coverage.width; col++) {
          const [cx, cz] = coverageCellCenter(coverage, col, row);
          if (Math.abs(cx - x) < 0.05 && Math.abs(cz - z) < 0.05) {
            return coverage.cells[row * coverage.width + col] ?? -1;
          }
        }
      }
      return -1;
    };
    expect(at(4.15, 4.15)).toBe(CELL_OBSERVED);
    expect(at(6.05, 6.05)).toBe(CELL_OBSERVED);
    expect(at(3.55, 6.05)).toBe(CELL_HOLE);
    expect(at(8.45, 8.45)).toBe(CELL_HOLE);
    expect(at(-0.25, 6.05)).toBe(CELL_OUTSIDE);
    // The hole less the island, the speck and the corners the close rounds off.
    expect(stats.holeCells).toBeGreaterThan(3150);
    expect(stats.holeCells).toBeLessThan(3200);
  });

  test("cell centres map back to the session frame, also when the grid is rotated", () => {
    const angle = 0.7;
    const { coverage } = buildFloorplan(transform(mesh().values, angle, 5, 5));
    expect(coverage.angleRad).toBeCloseTo(angle, 2);
    const states = new Map<number, [number, number][]>();
    for (let row = 0; row < coverage.height; row++) {
      for (let col = 0; col < coverage.width; col++) {
        const state = coverage.cells[row * coverage.width + col] ?? 0;
        const centre = coverageCellCenter(coverage, col, row);
        // Back to the design frame.
        const [x, z] = transform([centre[0] - 5, centre[1] - 5], -angle);
        const list = states.get(state) ?? [];
        list.push([x ?? 0, z ?? 0]);
        states.set(state, list);
      }
    }
    const within = (
      r: { x0: number; z0: number; x1: number; z1: number },
      [x, z]: [number, number],
    ) => x > r.x0 - 0.1 && x < r.x1 + 0.1 && z > r.z0 - 0.1 && z < r.z1 + 0.1;
    for (const p of states.get(CELL_HOLE) ?? []) {
      expect(within(pillar, p) || within(patch, p), `hole cell at ${p}`).toBe(true);
    }
    for (const p of states.get(CELL_OBSERVED) ?? []) {
      expect(within(rect(0, 0, 20, 4), p), `observed cell at ${p}`).toBe(true);
      expect(within(rect(5.1, 1.6, 5.9, 2.4), p), `observed cell in the pillar at ${p}`).toBe(
        false,
      );
    }
    expect((states.get(CELL_BRIDGED) ?? []).some((p) => within(strip, p))).toBe(true);
  });

  test("traceCoverage outlines the gaps to re-walk", () => {
    const { coverage } = buildFloorplan(transform(mesh().values, 0.4, -3, 8));
    const holes = traceCoverage(coverage, [CELL_HOLE], { minAreaM2: 0.5 });
    expectWellFormed(holes);
    expect(holes).toHaveLength(2);
    const [patchX, patchZ] = transform([12.6, 1.5], 0.4, -3, 8);
    const [pillarX, pillarZ] = transform([5.5, 2], 0.4, -3, 8);
    expect(
      insidePolygon(holes[0] ?? { outer: [], holes: [], areaM2: 0 }, patchX ?? 0, patchZ ?? 0),
    ).toBe(true);
    expect(
      insidePolygon(holes[1] ?? { outer: [], holes: [], areaM2: 0 }, pillarX ?? 0, pillarZ ?? 0),
    ).toBe(true);
    const gaps = traceCoverage(coverage, [CELL_BRIDGED, CELL_HOLE]);
    expectWellFormed(gaps);
    const [stripX, stripZ] = transform([9.07, 2], 0.4, -3, 8);
    expect(gaps.some((gap) => insidePolygon(gap, stripX ?? 0, stripZ ?? 0))).toBe(true);
    // Everything observed, traced, gives the corridor with three holes.
    const observed = traceCoverage(coverage, [CELL_OBSERVED], { minAreaM2: 1 });
    expect(observed.length).toBeGreaterThanOrEqual(2);
  });
});

describe("stats", () => {
  test("time each stage with the given clock", () => {
    let ticks = 0;
    const { stats } = buildFloorplan(lShape().toFloat32(), { now: () => ticks++ });
    expect(stats.timingsMs).toEqual({
      prepare: 1,
      rasterise: 1,
      close: 1,
      islands: 1,
      trace: 1,
      simplify: 1,
      coverage: 1,
      total: 7,
    });
  });

  test("use performance.now() by default", () => {
    const { timingsMs } = buildFloorplan(lShape().toFloat32()).stats;
    for (const value of Object.values(timingsMs)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(5_000);
    }
    expect(timingsMs.total).toBeGreaterThan(0);
  });

  test("count cells, rings and vertices", () => {
    const { stats, polygons } = buildFloorplan(lShape().toFloat32());
    expect(stats.triangles).toBe(lShape().count);
    expect(stats.observedCells).toBe(9600);
    expect(stats.walkableCells).toBe(stats.observedCells + stats.bridgedCells);
    expect(stats.rings).toBe(1);
    expect(stats.vertices).toBe((polygons[0]?.outer.length ?? 0) - 1);
    expect(stats.gridWidth).toBeGreaterThan(200);
    expect(stats.gridHeight).toBeGreaterThan(150);
  });
});

describe("ringArea", () => {
  test("is positive for rings counter-clockwise as seen from above", () => {
    // Seen from above with x to the right, z points down the page, so this square goes right,
    // up the page (towards -z), left and back down: counter-clockwise.
    const square: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, -1],
      [0, -1],
      [0, 0],
    ];
    expect(ringArea(square)).toBe(1);
    expect(ringArea(square.slice(0, 4))).toBe(1);
    expect(ringArea([...square].reverse())).toBe(-1);
  });
});
