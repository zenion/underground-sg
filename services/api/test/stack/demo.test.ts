// `pnpm demo` (src/demo/) against PostGIS and RustFS, in a database and buckets of the test file's
// own: the demo goes through the real path and publishes a version whose files are valid and
// clearly demo data; running it again changes nothing; while it is there, the seed and the publish
// refuse real data, and latest.json and GET /map/latest say demo, even once the reconcile job has
// rewritten the pointer; it refuses a database holding anything else; and --reset removes the
// demo's pointer, version files and exports. (The reset's database recreate is stubbed here;
// db/test/db/local.test.ts tests recreateLocalDatabase.)

import { brotliDecompressSync } from "node:zlib";
import { DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import type { IndoorSnapshot, LatestPointer, StreetSnapshot } from "@usg/contracts";
import { validateVersion } from "@usg/contracts/validators";
import { SeedError, seed } from "@usg/db/seed";
import { coreVenues } from "@usg/db/seed/core-venues";
import { useDatabase } from "@usg/db/test/harness";
import pg from "pg";
import { describe, expect, test } from "vitest";
import { buildApp } from "../../src/app.ts";
import type { StackConfig } from "../../src/config.ts";
import { DEMO_CHANGE_SET, DEMO_IDS, DEMO_NODE, DEMO_OWNER } from "../../src/demo/dataset.ts";
import { DemoRefusedError, nonDemoData, resetDemo, runDemo } from "../../src/demo/demo.ts";
import { reconcileLatest } from "../../src/publish/pointer.ts";
import { PublishRefusedError, publish } from "../../src/publish/publish.ts";
import { headRow, insertChangeSet } from "./head.ts";
import { listKeys, stackConfig, useKysely, useScratchStorage } from "./helpers.ts";

const db = useDatabase();
const kysely = useKysely(db);
const scratch = useScratchStorage();

async function publicJson<T>(key: string): Promise<T> {
  const b = scratch.publicBucket;
  const output = await b.client().send(new GetObjectCommand({ Bucket: b.name(), Key: key }));
  const bytes = Buffer.from((await output.Body?.transformToByteArray()) ?? []);
  const decoded = output.ContentEncoding === "br" ? brotliDecompressSync(bytes) : bytes;
  return JSON.parse(decoded.toString("utf8")) as T;
}

/** The stack's settings, on the test file's database and buckets. */
function config(): StackConfig {
  const stack = stackConfig();
  return {
    databaseUrl: db.url.href,
    s3: stack.s3,
    buckets: {
      bundles: scratch.exportsBucket.name(),
      exports: scratch.exportsBucket.name(),
      public: scratch.publicBucket.name(),
    },
  };
}

let snapshot: string;

describe("pnpm demo", () => {
  test("publishes the demo through the real path: seed, change set, gates, publish", async () => {
    const result = await runDemo(kysely(), scratch.storage());
    expect(result).toMatchObject({ alreadyPublished: false, version: 1 });
    snapshot = result.snapshotSha256;
    expect(result.steps).toEqual([
      "seeded venues and levels: 3 venues and 4 levels added",
      "street footpaths: 7 added",
      `change set ${DEMO_CHANGE_SET}: 43 entries (a manual edit, no captures)`,
      "gates passed: diff passed, privacy not_applicable, restricted_zones passed, alignment_residuals not_applicable, street_priors not_applicable",
      "published version 1: 2 files uploaded, 0 already there",
    ]);
    expect(
      await kysely()
        .selectFrom("change_sets")
        .select(["decision", "publish_path", "map_version_id"])
        .where("id", "=", DEMO_CHANGE_SET)
        .executeTakeFirstOrThrow(),
    ).toEqual({ decision: "auto_published", publish_path: "owner_mapper", map_version_id: 1 });
  });

  test("its files are valid, say demo, and join every exit to the street", async () => {
    const latest = await publicJson<LatestPointer>("latest.json");
    expect(latest).toMatchObject({ version: 1, snapshot_sha256: snapshot, demo: true });
    const indoor = await publicJson<IndoorSnapshot>(latest.files.indoor.path);
    const street = await publicJson<StreetSnapshot>(latest.files.street.path);
    expect(validateVersion(indoor, street)).toEqual({ valid: true, problems: [] });

    const names = indoor.features.flatMap((f) => {
      const name = (f.properties as { name?: string | null }).name;
      return f.properties.feature_type !== "level" && typeof name === "string" ? [name] : [];
    });
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) expect(name).toMatch(/^Demo: /);

    const connectors = indoor.features.filter(
      (f) => f.properties.feature_type === "street_connector",
    );
    expect(connectors.map((c) => (c.properties as { node_id: string }).node_id).sort()).toEqual(
      [DEMO_NODE.exitB, DEMO_NODE.exitA, DEMO_NODE.rafflesCityEntrance].sort(),
    );
    expect(street.features.filter((f) => f.properties.feature_type === "street_node")).toHaveLength(
      4,
    );
    expect(street.features.filter((f) => f.properties.feature_type === "street_edge")).toHaveLength(
      3,
    );
    const streetNames = indoor.features.flatMap((f) => {
      const name = (f.properties as { street_name?: string | null }).street_name;
      return typeof name === "string" ? [name] : [];
    });
    expect([...new Set(streetNames)].sort()).toEqual(["North Bridge Road", "Stamford Road"]);
  });

  test("running it again changes nothing", async () => {
    const keys = await listKeys(scratch.publicBucket.client(), scratch.publicBucket.name());
    const again = await runDemo(kysely(), scratch.storage());
    expect(again).toMatchObject({ alreadyPublished: true, version: 1, snapshotSha256: snapshot });
    expect(again.steps).toEqual([
      "seeded venues and levels: 0 venues and 0 levels added",
      "street footpaths: 0 added",
      "already published; latest.json is current",
    ]);
    expect(await kysely().selectFrom("map_versions").select("id").execute()).toEqual([{ id: 1 }]);
    expect(await listKeys(scratch.publicBucket.client(), scratch.publicBucket.name())).toEqual(
      keys,
    );
    expect(await nonDemoData(kysely())).toEqual([]);
  });
});

describe("while the database holds the demo", () => {
  test("the seed script refuses to load real venues beside it", async () => {
    const client = new pg.Client({ connectionString: db.url.href });
    await client.connect();
    try {
      await expect(seed(client, coreVenues)).rejects.toThrow(SeedError);
      await expect(seed(client, coreVenues)).rejects.toThrow(/Run `pnpm demo --reset` first/);
    } finally {
      await client.end();
    }
    expect(await nonDemoData(kysely())).toEqual([]);
  });

  test("the publish refuses real data, whoever publishes it", async () => {
    const poi = await headRow(kysely(), "pois", DEMO_IDS.pois[0] ?? "");
    const id = await insertChangeSet(
      kysely(),
      DEMO_OWNER,
      [
        {
          op: "modify",
          feature_type: "poi",
          id: poi.id,
          base_rev: poi.rev,
          before: poi.row,
          after: { ...poi.row, name: "A real shop" },
        },
      ],
      1,
    );
    try {
      const refused = await publish(kysely(), scratch.storage(), {
        changeSetIds: [id],
        publishedBy: DEMO_OWNER,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(PublishRefusedError);
      expect((refused as PublishRefusedError).problems).toContain(
        "the database holds the demo map (pnpm demo): run `pnpm demo --reset` before publishing real data",
      );
    } finally {
      // No gates ran, so nothing refers to it and it can go.
      await kysely().deleteFrom("change_sets").where("id", "=", id).execute();
    }
    expect(await kysely().selectFrom("map_versions").select("id").execute()).toEqual([{ id: 1 }]);
  });

  test("a pointer the reconcile job rewrites keeps demo: true, and GET /map/latest says so", async () => {
    const b = scratch.publicBucket;
    await b.client().send(new DeleteObjectCommand({ Bucket: b.name(), Key: "latest.json" }));
    expect(await reconcileLatest(kysely(), scratch.storage())).toMatchObject({
      action: "repaired",
      version: 1,
      previousVersion: null,
    });
    expect(await publicJson<LatestPointer>("latest.json")).toMatchObject({
      version: 1,
      demo: true,
    });

    const app = await buildApp({ db: kysely(), storage: scratch.storage(), corsOrigins: [] });
    try {
      const response = await app.inject({ url: "/map/latest" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ version: 1, demo: true });
    } finally {
      await app.close();
    }
  });
});

describe("pnpm demo --reset", () => {
  test("removes the demo's latest.json, status.json, version files and exports", async () => {
    const exportKeys = await listKeys(scratch.exportsBucket.client(), scratch.exportsBucket.name());
    expect(exportKeys).toHaveLength(1);
    const before = await listKeys(scratch.publicBucket.client(), scratch.publicBucket.name());
    expect(before.filter((key) => key.startsWith("snapshots/"))).toHaveLength(2);
    const recreated: string[] = [];
    const result = await resetDemo(config(), async (url) => {
      recreated.push(url.href);
    });
    expect(recreated).toEqual([db.url.href]);
    const directory = `snapshots/${snapshot}`;
    expect(result.deleted).toEqual([
      `${scratch.publicBucket.name()}/latest.json`,
      `${scratch.publicBucket.name()}/status.json`,
      `${scratch.publicBucket.name()}/${directory}/indoor.json`,
      `${scratch.publicBucket.name()}/${directory}/street.json`,
      `${scratch.exportsBucket.name()}/${exportKeys[0]}`,
    ]);
    // Nothing of the demo is left for an upload to R2 to find.
    expect(await listKeys(scratch.publicBucket.client(), scratch.publicBucket.name())).toEqual([]);
    expect(await listKeys(scratch.exportsBucket.client(), scratch.exportsBucket.name())).toEqual(
      [],
    );
  });

  test("refuses a latest.json that isn't the demo's", async () => {
    await scratch
      .storage()
      .buckets.public.put("latest.json", new TextEncoder().encode('{"version":9}'), {
        contentType: "application/json",
      });
    await expect(resetDemo(config(), async () => {})).rejects.toThrow(/isn't the demo/);
  });
});

describe("a database holding more than the demo", () => {
  test("is refused by the demo and by --reset", async () => {
    await kysely().insertInto("venues").values({ name: "Funan", kind: "mall" }).execute();
    expect(await nonDemoData(kysely())).toEqual(["1 venues"]);
    await expect(runDemo(kysely(), scratch.storage())).rejects.toThrow(DemoRefusedError);
    await expect(resetDemo(config(), async () => {})).rejects.toThrow(/won't wipe it/);
  });

  test("and nothing but a stack on this machine is accepted", async () => {
    await expect(
      resetDemo(
        { ...config(), databaseUrl: "postgres://u:p@db.example.com:5432/usg" },
        async () => {},
      ),
    ).rejects.toThrow(/DATABASE_URL points at db\.example\.com/);
    // A query parameter would take node-postgres and dbmate to another server.
    for (const parameter of ["host=db.example.com", "hostaddr=10.0.0.1"]) {
      await expect(
        resetDemo(
          { ...config(), databaseUrl: `postgres://u:p@localhost:5432/usg?${parameter}` },
          async () => {
            throw new Error("recreated");
          },
        ),
      ).rejects.toThrow(/query parameter naming another server/);
    }
  });
});
