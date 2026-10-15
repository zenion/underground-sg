// The publish transaction (src/publish/publish.ts) against PostGIS and RustFS, on the synthetic City
// Hall HEAD with its planted private rows, in a database and two buckets of the test file's own
// (public files and private exports). The backlog's Done-when for the publish transaction: two
// concurrent publishes serialise, and a failed pointer update is repaired by the reconcile job;
// plus what the docs promise around it: no change sets refuses, a rev conflict gives needs_rebase
// and publishes nothing, failed gates block, and the public files carry no private data.
//
// The tests share the database and run in order: each publish builds on the last.

import { brotliDecompressSync } from "node:zlib";
import { DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  CACHE_CONTROL,
  type ChangeSetDiff,
  type IndoorSnapshot,
  type LatestPointer,
  type StatusOverlay,
} from "@usg/contracts";
import {
  validateHeadExport,
  validateSnapshotFile,
  validateVersion,
  verifyLatestPointer,
} from "@usg/contracts/validators";
import { CONTRIBUTOR } from "@usg/db/test/fixtures";
import { useDatabase } from "@usg/db/test/harness";
import pg from "pg";
import { describe, expect, test } from "vitest";
import { runGates } from "../../src/publish/gates.ts";
import { reconcileLatest } from "../../src/publish/pointer.ts";
import { PublishRefusedError, publish } from "../../src/publish/publish.ts";
import type { ObjectStore } from "../../src/storage.ts";
import { LEVEL, POI, PRIVATE, seedCityHall } from "../fixtures/city-hall.ts";
import { headRow, insertChangeSet } from "./head.ts";
import { listKeys, useKysely, useScratchStorage, waitForLockWaiters } from "./helpers.ts";

const db = useDatabase(async (d) => {
  await seedCityHall(d);
  await d.query(
    `INSERT INTO contributors (id, display_name, trust_tier)
     VALUES ($1, 'Owner', 'owner'), ($2, 'Newcomer', 'new')`,
    [CONTRIBUTOR.owner, CONTRIBUTOR.newcomer],
  );
});
const kysely = useKysely(db);
const scratch = useScratchStorage();

const OWNER = CONTRIBUTOR.owner;

/** A pending change set renaming a POI from its current HEAD row, with its gates run. */
async function renamePoi(
  poi: string,
  name: string,
  options: { gates?: boolean; baseRev?: number; contributor?: string } = {},
): Promise<string> {
  const head = await headRow(kysely(), "pois", poi);
  const diff: ChangeSetDiff = [
    {
      op: "modify",
      feature_type: "poi",
      id: poi,
      base_rev: options.baseRev ?? head.rev,
      before: head.row,
      after: { ...head.row, name },
    },
  ];
  const version = await kysely()
    .selectFrom("map_head")
    .select("version_id")
    .executeTakeFirstOrThrow();
  const id = await insertChangeSet(
    kysely(),
    options.contributor ?? OWNER,
    diff,
    version.version_id,
  );
  if (options.gates !== false) expect((await runGates(kysely(), id)).passed).toBe(true);
  return id;
}

async function object(bucket: "public" | "exports", key: string) {
  const b = bucket === "public" ? scratch.publicBucket : scratch.exportsBucket;
  const output = await b.client().send(new GetObjectCommand({ Bucket: b.name(), Key: key }));
  const body = Buffer.from((await output.Body?.transformToByteArray()) ?? []);
  return {
    contentType: output.ContentType,
    contentEncoding: output.ContentEncoding,
    cacheControl: output.CacheControl,
    decoded: output.ContentEncoding === "br" ? brotliDecompressSync(body) : body,
  };
}

async function json<T>(bucket: "public" | "exports", key: string): Promise<T> {
  return JSON.parse((await object(bucket, key)).decoded.toString("utf8")) as T;
}

const publicKeys = () => listKeys(scratch.publicBucket.client(), scratch.publicBucket.name());
const versionCount = async () =>
  Number(
    (
      await kysely()
        .selectFrom("map_versions")
        .select((eb) => eb.fn.countAll().as("n"))
        .executeTakeFirstOrThrow()
    ).n,
  );

describe("refusals change nothing", () => {
  test("no change sets: every version except a rollback publishes one", async () => {
    await expect(
      publish(kysely(), scratch.storage(), { changeSetIds: [], publishedBy: OWNER }),
    ).rejects.toThrow(PublishRefusedError);
    expect(await versionCount()).toBe(0);
    expect(await publicKeys()).toEqual([]);
  });

  test("something that isn't a change set id", async () => {
    await expect(
      publish(kysely(), scratch.storage(), { changeSetIds: ["latest"], publishedBy: OWNER }),
    ).rejects.toThrow('"latest" is not an id');
  });

  test("a change set whose gates haven't run, or that isn't the owner's", async () => {
    const ungated = await renamePoi(POI.cityHallAtm, "ATM (ungated)", { gates: false });
    const newcomers = await renamePoi(POI.cityHallAtm, "ATM (newcomer)", {
      contributor: CONTRIBUTOR.newcomer,
    });
    const refusal = publish(kysely(), scratch.storage(), {
      changeSetIds: [ungated, newcomers],
      publishedBy: OWNER,
    });
    await expect(refusal).rejects.toThrow(PublishRefusedError);
    const problems = await refusal.catch((error: PublishRefusedError) => error.problems);
    expect(problems).toEqual([
      `change set ${ungated}: the automated gates have not run (pnpm map gates ${ungated})`,
      `change set ${newcomers} is not the owner's: Phase 1 publishes only through owner_mapper (moderator review comes in Phase 4)`,
    ]);
    expect(await versionCount()).toBe(0);
    expect(await publicKeys()).toEqual([]);
    for (const id of [ungated, newcomers]) {
      await kysely()
        .updateTable("change_sets")
        .set({ decision: "rejected" })
        .where("id", "=", id)
        .execute();
    }
  });

  test("a change set whose gates failed", async () => {
    const overlap: ChangeSetDiff = [
      {
        op: "add",
        feature_type: "space",
        id: "f0000000-0000-4000-8000-000000000001",
        base_rev: null,
        before: null,
        after: {
          level_id: LEVEL.funanB2,
          kind: "walkway",
          name: null,
          geom: {
            type: "Polygon",
            coordinates: [
              [
                [103.8493, 1.2906],
                [103.8495, 1.2906],
                [103.8495, 1.2908],
                [103.8493, 1.2908],
                [103.8493, 1.2906],
              ],
            ],
          },
        },
      },
    ];
    const id = await insertChangeSet(kysely(), OWNER, overlap);
    expect((await runGates(kysely(), id)).passed).toBe(false);
    await expect(
      publish(kysely(), scratch.storage(), { changeSetIds: [id], publishedBy: OWNER }),
    ).rejects.toThrow(`change set ${id}: the automated gates failed`);
    expect(await versionCount()).toBe(0);
    expect(await publicKeys()).toEqual([]);
    await kysely()
      .updateTable("change_sets")
      .set({ decision: "rejected" })
      .where("id", "=", id)
      .execute();
  });
});

describe("the first publish", () => {
  let changeSet: string;
  let result: Awaited<ReturnType<typeof publish>>;

  test("publishes version 1 through owner_mapper", async () => {
    changeSet = await renamePoi(POI.funanToilets, "Toilets (B2)");
    result = await publish(kysely(), scratch.storage(), {
      changeSetIds: [changeSet],
      publishedBy: OWNER,
      note: "private note",
    });
    expect(result).toMatchObject({
      version: { id: 1, uploaded: ["indoor.json", "street.json"], reused: [] },
      published: [changeSet],
      needsRebase: [],
      pointer: { updated: true, demo: false },
    });
    expect(
      await kysely()
        .selectFrom("change_sets")
        .select(["decision", "publish_path", "map_version_id", "reviewer_id"])
        .where("id", "=", changeSet)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      decision: "auto_published",
      publish_path: "owner_mapper",
      map_version_id: 1,
      reviewer_id: null,
    });
    expect(
      await kysely().selectFrom("map_head").select("version_id").executeTakeFirstOrThrow(),
    ).toEqual({
      version_id: 1,
    });
    expect(
      await kysely()
        .selectFrom("pois")
        .select(["name", "rev"])
        .where("id", "=", POI.funanToilets)
        .executeTakeFirstOrThrow(),
    ).toEqual({ name: "Toilets (B2)", rev: 2 });
    const events = await kysely()
      .selectFrom("moderation_events")
      .select(["action", "actor_id", "detail"])
      .where("change_set_id", "=", changeSet)
      .orderBy("id")
      .execute();
    expect(events.map((e) => e.action)).toEqual(["gates_passed", "published"]);
    expect(events[1]).toMatchObject({
      actor_id: OWNER,
      detail: { version: 1, publish_path: "owner_mapper" },
    });
  });

  test("uploads the version files brotli-compressed under their content address", async () => {
    const v = result.version;
    if (v === null) throw new Error("no version");
    const row = await kysely()
      .selectFrom("map_versions")
      .selectAll()
      .where("id", "=", 1)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      snapshot_sha256: v.snapshotSha256,
      snapshot_uri: `snapshots/${v.snapshotSha256}/`,
      private_export_uri: v.exportKey,
      published_by: OWNER,
      note: "private note",
      restores: null,
    });
    expect(await publicKeys()).toEqual([
      "latest.json",
      `snapshots/${v.snapshotSha256}/indoor.json`,
      `snapshots/${v.snapshotSha256}/street.json`,
      "status.json",
    ]);
    const indoor = await object("public", `snapshots/${v.snapshotSha256}/indoor.json`);
    const street = await object("public", `snapshots/${v.snapshotSha256}/street.json`);
    for (const file of [indoor, street]) {
      expect(file).toMatchObject({
        contentType: "application/geo+json",
        contentEncoding: "br",
        cacheControl: CACHE_CONTROL.version,
      });
    }
    const parsedIndoor = JSON.parse(indoor.decoded.toString("utf8")) as IndoorSnapshot;
    expect(validateVersion(parsedIndoor, JSON.parse(street.decoded.toString("utf8")))).toEqual({
      valid: true,
      problems: [],
    });
    expect(parsedIndoor.features.find((f) => f.id === POI.funanToilets)?.properties).toMatchObject({
      name: "Toilets (B2)",
    });
    // Street connectors were rebuilt inside the publish.
    expect(
      parsedIndoor.features.filter((f) => f.properties.feature_type === "street_connector"),
    ).toHaveLength(3);
  });

  test("then points latest.json at it, and writes an empty status.json", async () => {
    const v = result.version;
    if (v === null) throw new Error("no version");
    const latestObject = await object("public", "latest.json");
    expect(latestObject).toMatchObject({
      contentType: "application/json",
      cacheControl: CACHE_CONTROL.latest,
    });
    expect(latestObject.contentEncoding).toBeUndefined();
    const latest = await json<LatestPointer>("public", "latest.json");
    expect(validateSnapshotFile("latest.json", latest)).toEqual({ valid: true, problems: [] });
    expect(latest).toMatchObject({ version: 1, snapshot_sha256: v.snapshotSha256 });
    expect(latest.demo).toBeUndefined();
    expect(latest.attribution).toEqual([
      { text: "© OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright" },
    ]);
    const files = {
      "indoor.json": (await object("public", latest.files.indoor.path)).decoded,
      "street.json": (await object("public", latest.files.street.path)).decoded,
    };
    expect(verifyLatestPointer(latest, files)).toEqual([]);
    const status = await json<StatusOverlay>("public", "status.json");
    expect(validateSnapshotFile("status.json", status)).toEqual({ valid: true, problems: [] });
    expect(status.entries).toEqual([]);
  });

  test("writes the private full export, anchors included, under a key of its own", async () => {
    const v = result.version;
    if (v === null) throw new Error("no version");
    expect(v.exportKey).toMatch(/^head\/1\/[0-9a-f-]{36}\.json$/);
    expect(v.exportKey).not.toContain(v.snapshotSha256);
    const stored = await object("exports", v.exportKey);
    expect(stored).toMatchObject({ contentType: "application/json", contentEncoding: "br" });
    const exported = JSON.parse(stored.decoded.toString("utf8"));
    expect(validateHeadExport(exported)).toEqual({ valid: true, problems: [] });
    expect(exported).toMatchObject({ version: 1, snapshot_sha256: v.snapshotSha256 });
    expect(exported.anchors).toEqual([
      expect.objectContaining({
        id: PRIVATE.anchorId,
        rev: 1,
        row: expect.objectContaining({ photo_uri: PRIVATE.anchorPhotoUri }),
      }),
    ]);
    expect(exported.venues[0]).toMatchObject({ permission: PRIVATE.permission });
    expect(exported.pois.find((p: { id: string }) => p.id === POI.funanToilets)).toMatchObject({
      rev: 2,
      row: { name: "Toilets (B2)" },
    });
  });

  test("the public files carry no private data", async () => {
    const v = result.version;
    if (v === null) throw new Error("no version");
    const secrets = [
      PRIVATE.anchorId,
      PRIVATE.anchorName,
      PRIVATE.anchorPhotoUri,
      PRIVATE.operator,
      PRIVATE.permission,
      PRIVATE.zoneId,
      PRIVATE.zoneNote,
      String(PRIVATE.zoneCorner),
      String(PRIVATE.nodeElevation),
      ...PRIVATE.osmTagValues,
      changeSet,
      OWNER,
      v.exportKey,
      "private note",
      '"rev"',
      "permission",
      "operator",
      "photo_uri",
    ];
    for (const key of await publicKeys()) {
      const text = (await object("public", key)).decoded.toString("utf8");
      for (const secret of secrets) expect(text, `${key} contains ${secret}`).not.toContain(secret);
    }
  });
});

describe("later publishes", () => {
  test("a rev conflict sends the change set to needs_rebase and publishes nothing", async () => {
    const before = await publicKeys();
    const latestBefore = await json<LatestPointer>("public", "latest.json");
    // Made against rev 1 of the toilets, which version 1 moved to rev 2. The gates don't look at
    // revs: the rebase check does.
    const stale = await renamePoi(POI.funanToilets, "Toilets (stale)", { baseRev: 1 });
    const result = await publish(kysely(), scratch.storage(), {
      changeSetIds: [stale],
      publishedBy: OWNER,
    });
    expect(result).toEqual({
      version: null,
      published: [],
      needsRebase: [
        {
          id: stale,
          reasons: [
            `modify poi ${POI.funanToilets}: HEAD has rev 2; the diff was made against rev 1`,
          ],
        },
      ],
      pointer: { updated: false },
    });
    expect(
      await kysely()
        .selectFrom("change_sets")
        .select(["decision", "publish_path"])
        .where("id", "=", stale)
        .executeTakeFirstOrThrow(),
    ).toEqual({ decision: "needs_rebase", publish_path: null });
    expect(await versionCount()).toBe(1);
    expect(
      await kysely().selectFrom("map_head").select("version_id").executeTakeFirstOrThrow(),
    ).toEqual({ version_id: 1 });
    expect(
      await kysely()
        .selectFrom("pois")
        .select("name")
        .where("id", "=", POI.funanToilets)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      name: "Toilets (B2)",
    });
    expect(await publicKeys()).toEqual(before);
    expect(await json<LatestPointer>("public", "latest.json")).toEqual(latestBefore);
  });

  test("a change only to private rows reuses the version's files, with an export of its own", async () => {
    const anchor = await headRow(kysely(), "anchors", PRIVATE.anchorId);
    const id = await insertChangeSet(
      kysely(),
      OWNER,
      [
        {
          op: "modify",
          feature_type: "anchor",
          id: anchor.id,
          base_rev: anchor.rev,
          before: anchor.row,
          after: { ...anchor.row, facing_deg: 10 },
        },
      ],
      1,
    );
    expect((await runGates(kysely(), id)).passed).toBe(true);
    const first = await kysely()
      .selectFrom("map_versions")
      .selectAll()
      .where("id", "=", 1)
      .executeTakeFirstOrThrow();
    const result = await publish(kysely(), scratch.storage(), {
      changeSetIds: [id],
      publishedBy: OWNER,
    });
    expect(result.version).toMatchObject({
      id: 2,
      snapshotSha256: first.snapshot_sha256,
      uploaded: [],
      reused: ["indoor.json", "street.json"],
    });
    expect(result.version?.exportKey).not.toBe(first.private_export_uri);
    expect((await json<LatestPointer>("public", "latest.json")).version).toBe(2);
  });
});

describe("concurrency", () => {
  /** Runs the publishes while a transaction of the test's holds map_head, then lets them go. */
  async function holdingTheLock<T>(run: () => Promise<T>[]): Promise<T[]> {
    const holder = new pg.Client({ connectionString: db.url.href });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT version_id FROM map_head FOR UPDATE");
      let settled = 0;
      const running = run().map((p) => p.finally(() => (settled += 1)));
      // Both are blocked on the lock, and neither has finished.
      await waitForLockWaiters(db, running.length);
      expect(settled).toBe(0);
      await holder.query("COMMIT");
      return await Promise.all(running);
    } finally {
      await holder.end();
    }
  }

  test("two publishes started together serialise: the second builds on the first", async () => {
    const atm = await renamePoi(POI.cityHallAtm, "ATM (concourse)");
    const food = await renamePoi(POI.rafflesCityFood, "Food court (B1)");
    const [a, b] = await holdingTheLock(() => [
      publish(kysely(), scratch.storage(), { changeSetIds: [atm], publishedBy: OWNER }),
      publish(kysely(), scratch.storage(), { changeSetIds: [food], publishedBy: OWNER }),
    ]);
    const versions = [a?.version?.id, b?.version?.id].sort();
    expect(versions).toEqual([3, 4]);
    const last = [a, b].find((r) => r?.version?.id === 4)?.version;
    if (last === undefined || last === null) throw new Error("no version 4");
    const indoor = await json<IndoorSnapshot>(
      "public",
      `snapshots/${last.snapshotSha256}/indoor.json`,
    );
    const name = (id: string) =>
      (indoor.features.find((f) => f.id === id)?.properties as { name?: string } | undefined)?.name;
    expect([name(POI.cityHallAtm), name(POI.rafflesCityFood)]).toEqual([
      "ATM (concourse)",
      "Food court (B1)",
    ]);
    expect((await json<LatestPointer>("public", "latest.json")).version).toBe(4);
    const times = await kysely()
      .selectFrom("map_versions")
      .select(["id", "published_at"])
      .where("id", "in", [3, 4])
      .orderBy("id")
      .execute();
    // The second waited for the first: it was published after it, by the clock.
    expect(Number(times[1]?.published_at)).toBeGreaterThan(Number(times[0]?.published_at));
  });

  test("two publishes of the same row: one publishes, the other needs a rebase", async () => {
    const first = await renamePoi(POI.cityHallAtm, "ATM (one)");
    const second = await renamePoi(POI.cityHallAtm, "ATM (two)");
    const results = await holdingTheLock(() => [
      publish(kysely(), scratch.storage(), { changeSetIds: [first], publishedBy: OWNER }),
      publish(kysely(), scratch.storage(), { changeSetIds: [second], publishedBy: OWNER }),
    ]);
    expect(results.filter((r) => r.version !== null).map((r) => r.version?.id)).toEqual([5]);
    expect(results.flatMap((r) => r.needsRebase.map((n) => n.reasons))).toEqual([
      [`modify poi ${POI.cityHallAtm}: HEAD has rev 3; the diff was made against rev 2`],
    ]);
  });
});

describe("the reconcile job", () => {
  /** The public bucket, but every write of latest.json fails. */
  const failingLatest = (store: ObjectStore): ObjectStore => ({
    bucket: store.bucket,
    get: (key, signal) => store.get(key, signal),
    head: (key, signal) => store.head(key, signal),
    exists: (signal) => store.exists(signal),
    put: async (key, body, options) => {
      if (key === "latest.json") throw new Error("simulated outage writing latest.json");
      return store.put(key, body, options);
    },
  });

  test("repairs latest.json after the pointer update failed", async () => {
    const id = await renamePoi(POI.cityHallAtm, "ATM (after the outage)");
    const result = await publish(kysely(), scratch.storage(failingLatest), {
      changeSetIds: [id],
      publishedBy: OWNER,
    });
    expect(result.version?.id).toBe(6);
    expect(result.pointer).toEqual({
      updated: false,
      demo: false,
      error: "simulated outage writing latest.json",
    });
    // The version stands: map_head moved, latest.json lags.
    expect(
      await kysely().selectFrom("map_head").select("version_id").executeTakeFirstOrThrow(),
    ).toEqual({ version_id: 6 });
    expect((await json<LatestPointer>("public", "latest.json")).version).toBe(5);

    expect(await reconcileLatest(kysely(), scratch.storage())).toEqual({
      action: "repaired",
      version: 6,
      previousVersion: 5,
      statusWritten: false,
    });
    const latest = await json<LatestPointer>("public", "latest.json");
    expect(latest).toMatchObject({ version: 6, snapshot_sha256: result.version?.snapshotSha256 });
    const files = {
      "indoor.json": (await object("public", latest.files.indoor.path)).decoded,
      "street.json": (await object("public", latest.files.street.path)).decoded,
    };
    expect(verifyLatestPointer(latest, files)).toEqual([]);
    expect(await reconcileLatest(kysely(), scratch.storage())).toMatchObject({
      action: "unchanged",
      version: 6,
    });
  });

  test("writes a missing status.json, and drops a demo flag the database doesn't back", async () => {
    const b = scratch.publicBucket;
    await b.client().send(new DeleteObjectCommand({ Bucket: b.name(), Key: "status.json" }));
    const latest = await json<LatestPointer>("public", "latest.json");
    await scratch
      .storage()
      .buckets.public.put(
        "latest.json",
        new TextEncoder().encode(JSON.stringify({ ...latest, demo: true })),
        { contentType: "application/json", cacheControl: CACHE_CONTROL.latest },
      );
    // The flag follows the database, which doesn't hold the demo (demo.test.ts has the other case).
    expect(await reconcileLatest(kysely(), scratch.storage())).toMatchObject({
      action: "repaired",
      statusWritten: true,
    });
    expect((await json<StatusOverlay>("public", "status.json")).entries).toEqual([]);
    expect(await json<LatestPointer>("public", "latest.json")).toEqual(latest);
    expect((await json<LatestPointer>("public", "latest.json")).demo).toBeUndefined();
  });
});
