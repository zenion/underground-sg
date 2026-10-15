// The demo's dataset and guards, without a database: the dataset is well formed and plainly demo
// data, and the demo refuses any stack that isn't on this machine.

import { validateChangeSetDiff } from "@usg/contracts/validators";
import { checkDataset } from "@usg/db/seed";
import { describe, expect, test } from "vitest";
import { DEMO_IDS, DEMO_SEED, demoDiff, demoEdgeLines } from "../../src/demo/dataset.ts";
import { assertLocalStack, DemoRefusedError } from "../../src/demo/demo.ts";

const s3 = (endpoint: string) => ({
  endpoint,
  region: "us-east-1",
  accessKeyId: "usg-local",
  secretAccessKey: "usg-local-only-secret",
});

describe("the demo dataset", () => {
  const diff = demoDiff(new Map([...demoEdgeLines().keys()].map((id) => [id, 12.34])));

  test("its venues and levels are a well-formed seed dataset", () => {
    expect(checkDataset(DEMO_SEED)).toEqual([]);
  });

  test("its change set is a valid structural diff of adds only", () => {
    expect(validateChangeSetDiff(diff, "structural")).toEqual({ valid: true, problems: [] });
    expect(new Set(diff.map((entry) => entry.op))).toEqual(new Set(["add"]));
    expect(diff.map((entry) => entry.id).sort()).toEqual(
      [...DEMO_IDS.spaces, ...DEMO_IDS.nodes, ...DEMO_IDS.edges, ...DEMO_IDS.pois].sort(),
    );
  });

  test("every name it gives is plainly demo data", () => {
    const names = [
      ...DEMO_SEED.venues.map((venue) => venue.name),
      ...diff.flatMap((entry) => {
        const name = (entry.after as { name?: string | null } | null)?.name;
        return typeof name === "string" ? [name] : [];
      }),
    ];
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) expect(name).toMatch(/^Demo: /);
  });
});

describe("assertLocalStack", () => {
  test.each([
    ["postgres://usg:x@localhost:25432/usg", "http://localhost:29000"],
    ["postgres://usg:x@127.0.0.1:25432/usg", "http://127.0.0.1:29000"],
    ["postgres://usg:x@[::1]:25432/usg", "http://[::1]:29000"],
  ])("accepts %s with %s", (databaseUrl, endpoint) => {
    expect(() => assertLocalStack({ databaseUrl, s3: s3(endpoint) })).not.toThrow();
  });

  test("refuses a database elsewhere", () => {
    expect(() =>
      assertLocalStack({
        databaseUrl: "postgres://usg:x@db.example.com:5432/usg",
        s3: s3("http://localhost:29000"),
      }),
    ).toThrow(DemoRefusedError);
  });

  test.each([
    "postgres://usg:x@localhost:25432/usg?host=remote.example",
    "postgres://usg:x@localhost:25432/usg?hostaddr=10.0.0.1",
    "postgres://usg:x@127.0.0.1:25432/usg?sslmode=disable&HOST=remote.example",
    "postgres://usg:x@localhost:25432/usg?service=prod",
  ])("refuses %s: the drivers would connect to another server", (databaseUrl) => {
    expect(() => assertLocalStack({ databaseUrl, s3: s3("http://localhost:29000") })).toThrow(
      /query parameter naming another server/,
    );
  });

  test("refuses an S3 endpoint elsewhere, such as R2 or a LAN address", () => {
    for (const endpoint of ["https://abc.r2.cloudflarestorage.com", "http://192.168.1.20:29000"]) {
      expect(() =>
        assertLocalStack({ databaseUrl: "postgres://usg:x@localhost:25432/usg", s3: s3(endpoint) }),
      ).toThrow(/S3_ENDPOINT points at/);
    }
  });
});
