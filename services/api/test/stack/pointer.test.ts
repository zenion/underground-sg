// latest.json only moves forward (src/publish/pointer.ts), against PostGIS and RustFS on the
// synthetic City Hall HEAD: every write of it holds map_head FOR SHARE and checks map_head still
// names its version, so a slow pointer write can't land after a newer publish's, the reconcile job
// can't write the version it read before a publish committed, and nothing replaces a latest.json
// naming a newer version. Operations are held at a point of the test's choosing (`gate`), and
// whether another waits on the lock is read from pg_stat_activity.
//
// The tests share the database and run in order.

import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { CACHE_CONTROL, type LatestPointer } from "@usg/contracts";
import { CONTRIBUTOR } from "@usg/db/test/fixtures";
import { useDatabase } from "@usg/db/test/harness";
import { describe, expect, test } from "vitest";
import { runGates } from "../../src/publish/gates.ts";
import {
  LATEST_KEY,
  ReconcileError,
  reconcileLatest,
  updateLatest,
} from "../../src/publish/pointer.ts";
import { publish } from "../../src/publish/publish.ts";
import type { ObjectStore } from "../../src/storage.ts";
import { POI, seedCityHall } from "../fixtures/city-hall.ts";
import { headRow, insertChangeSet } from "./head.ts";
import { gate, useKysely, useScratchStorage, waitForLockWaiters } from "./helpers.ts";

const db = useDatabase(async (d) => {
  await seedCityHall(d);
  await d.query(
    "INSERT INTO contributors (id, display_name, trust_tier) VALUES ($1, 'Owner', 'owner')",
    [CONTRIBUTOR.owner],
  );
});
const kysely = useKysely(db);
const scratch = useScratchStorage();
const OWNER = CONTRIBUTOR.owner;

/** A pending change set renaming a POI, with its gates run and passed. */
async function renamePoi(poi: string, name: string): Promise<string> {
  const head = await headRow(kysely(), "pois", poi);
  const version = await kysely()
    .selectFrom("map_head")
    .select("version_id")
    .executeTakeFirstOrThrow();
  const id = await insertChangeSet(
    kysely(),
    OWNER,
    [
      {
        op: "modify",
        feature_type: "poi",
        id: poi,
        base_rev: head.rev,
        before: head.row,
        after: { ...head.row, name },
      },
    ],
    version.version_id,
  );
  expect((await runGates(kysely(), id)).passed).toBe(true);
  return id;
}

/** The public bucket, with `hold` run before the operations it picks. */
function holding(
  store: ObjectStore,
  hold: { put?: (key: string) => Promise<void>; get?: (key: string) => Promise<void> },
): ObjectStore {
  return {
    bucket: store.bucket,
    head: (key, signal) => store.head(key, signal),
    exists: (signal) => store.exists(signal),
    get: async (key, signal) => {
      await hold.get?.(key);
      return store.get(key, signal);
    },
    put: async (key, body, options) => {
      await hold.put?.(key);
      return store.put(key, body, options);
    },
  };
}

async function latest(): Promise<LatestPointer | undefined> {
  const object = await scratch.storage().buckets.public.get(LATEST_KEY);
  if (object === undefined) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of object.body) chunks.push(Buffer.from(chunk as Uint8Array));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as LatestPointer;
}

async function headVersion(): Promise<number | null> {
  return (await kysely().selectFrom("map_head").select("version_id").executeTakeFirstOrThrow())
    .version_id;
}

async function deleteLatest(): Promise<void> {
  const b = scratch.publicBucket;
  await b.client().send(new DeleteObjectCommand({ Bucket: b.name(), Key: LATEST_KEY }));
}

describe("latest.json only moves forward", () => {
  test("a slow pointer write holds back the next publish, which then writes its own", async () => {
    const first = await publish(kysely(), scratch.storage(), {
      changeSetIds: [await renamePoi(POI.funanToilets, "Toilets (1)")],
      publishedBy: OWNER,
    });
    expect(first.version?.id).toBe(1);

    const a = await renamePoi(POI.cityHallAtm, "ATM (2)");
    const b = await renamePoi(POI.rafflesCityFood, "Food court (3)");
    const slow = gate();
    const settled: string[] = [];
    const publishA = publish(
      kysely(),
      scratch.storage((store) =>
        holding(store, { put: async (key) => (key === LATEST_KEY ? slow.wait() : undefined) }),
      ),
      { changeSetIds: [a], publishedBy: OWNER },
    ).finally(() => settled.push("a"));
    // A has committed version 2 and is about to write its pointer, holding map_head FOR SHARE.
    await slow.reached;
    const publishB = publish(kysely(), scratch.storage(), {
      changeSetIds: [b],
      publishedBy: OWNER,
    }).finally(() => settled.push("b"));
    // B waits for the lock before it changes anything.
    await waitForLockWaiters(db, 1);
    expect(settled).toEqual([]);
    expect(await headVersion()).toBe(2);
    slow.release();
    const [resultA, resultB] = await Promise.all([publishA, publishB]);
    expect(settled).toEqual(["a", "b"]);
    expect([resultA.version?.id, resultA.pointer.updated]).toEqual([2, true]);
    expect([resultB.version?.id, resultB.pointer.updated]).toEqual([3, true]);
    expect((await latest())?.version).toBe(3);
  });

  test("a pointer whose version has been overtaken is left unwritten", async () => {
    const current = await latest();
    if (current === undefined) throw new Error("no latest.json");
    const older: LatestPointer = { ...current, version: 2 };
    expect(await updateLatest(kysely(), scratch.storage().buckets.public, older)).toBe(
      "superseded",
    );
    expect(await latest()).toEqual(current);
  });

  test("the reconcile job holds map_head while it checks the files: a publish waits for it", async () => {
    await deleteLatest();
    const c = await renamePoi(POI.cityHallAtm, "ATM (4)");
    const slow = gate();
    const settled: string[] = [];
    const reconcile = reconcileLatest(
      kysely(),
      scratch.storage((store) =>
        holding(store, {
          get: async (key) => (key.endsWith("/indoor.json") ? slow.wait() : undefined),
        }),
      ),
    ).finally(() => settled.push("reconcile"));
    // It has read map_head (version 3) and is fetching the version's files.
    await slow.reached;
    const publishC = publish(kysely(), scratch.storage(), {
      changeSetIds: [c],
      publishedBy: OWNER,
    }).finally(() => settled.push("publish"));
    await waitForLockWaiters(db, 1);
    expect(settled).toEqual([]);
    slow.release();
    const [reconciled, published] = await Promise.all([reconcile, publishC]);
    expect(settled).toEqual(["reconcile", "publish"]);
    expect(reconciled).toMatchObject({ action: "repaired", version: 3, previousVersion: null });
    expect([published.version?.id, published.pointer.updated]).toEqual([4, true]);
    expect((await latest())?.version).toBe(4);
    expect(await headVersion()).toBe(4);
  });

  test("nothing replaces a latest.json naming a newer version", async () => {
    const current = await latest();
    if (current === undefined) throw new Error("no latest.json");
    await scratch
      .storage()
      .buckets.public.put(
        LATEST_KEY,
        new TextEncoder().encode(JSON.stringify({ ...current, version: 99 })),
        {
          contentType: "application/json",
          cacheControl: CACHE_CONTROL.latest,
        },
      );
    await expect(reconcileLatest(kysely(), scratch.storage())).rejects.toThrow(ReconcileError);
    await expect(reconcileLatest(kysely(), scratch.storage())).rejects.toThrow(
      /names version 99, newer than map_head's version 4/,
    );
    const result = await publish(kysely(), scratch.storage(), {
      changeSetIds: [await renamePoi(POI.cityHallAtm, "ATM (5)")],
      publishedBy: OWNER,
    });
    expect(result.version?.id).toBe(5);
    expect(result.pointer).toMatchObject({
      updated: false,
      error: expect.stringMatching(/names version 99/),
    });
    expect((await latest())?.version).toBe(99);
    // Removed by hand, the pointer is repaired.
    await deleteLatest();
    expect(await reconcileLatest(kysely(), scratch.storage())).toMatchObject({
      action: "repaired",
      version: 5,
    });
  });
});
