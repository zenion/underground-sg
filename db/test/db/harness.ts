// Each test file gets its own database, copied from the migrated template and dropped after
// the file, so files run in parallel and leave nothing behind. Inside a file, tests run in
// transactions that are rolled back (`rolledBack`), except the ones about a deferred rule,
// which fires at COMMIT and so needs a real commit (`committed`, `expectCommitRefused`).

import pg from "pg";
import { afterAll, beforeAll, expect, inject } from "vitest";
import { withDatabase } from "../../src/config.ts";
import { createScratchFromTemplate, dropScratch } from "../../src/scratch.ts";

/** The SQLSTATEs the schema's rules raise. */
export const SQLSTATE = {
  checkViolation: "23514",
  foreignKeyViolation: "23503",
  /** ON DELETE RESTRICT */
  restrictViolation: "23001",
  uniqueViolation: "23505",
  raiseException: "P0001",
} as const;

/**
 * Why a statement must be refused: its SQLSTATE plus the constraint that refused it (CHECK,
 * UNIQUE, FOREIGN KEY) or the trigger's message, so a refusal for some other reason fails.
 */
export type Refusal = { code: string; constraint: string } | { code: string; message: RegExp };

export class TestDb {
  #client: pg.Client | undefined;
  #inTransaction = false;

  get client(): pg.Client {
    if (this.#client === undefined) throw new Error("not connected: call useDatabase()");
    return this.#client;
  }

  async connect(url: URL): Promise<void> {
    this.#client = new pg.Client({ connectionString: url.href });
    await this.#client.connect();
  }

  async close(): Promise<void> {
    await this.#client?.end();
    this.#client = undefined;
  }

  async query<R extends pg.QueryResultRow = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<R[]> {
    return (await this.client.query<R>(sql, params)).rows;
  }

  /** The first column of the first row. */
  async value<T>(sql: string, params: unknown[] = []): Promise<T> {
    const result = await this.client.query({ text: sql, values: params, rowMode: "array" });
    const row = result.rows[0] as unknown[] | undefined;
    if (row === undefined) throw new Error(`no rows: ${sql}`);
    return row[0] as T;
  }

  /** Runs `fn` in a transaction and rolls it back. Deferred rules never fire here. */
  async rolledBack(fn: () => Promise<void>): Promise<void> {
    await this.client.query("BEGIN");
    this.#inTransaction = true;
    try {
      await fn();
    } finally {
      this.#inTransaction = false;
      await this.client.query("ROLLBACK");
    }
  }

  /** Runs `fn` in a transaction and commits it, so deferred rules fire. */
  async committed(fn: () => Promise<void>): Promise<void> {
    await this.client.query("BEGIN");
    this.#inTransaction = true;
    try {
      await fn();
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    } finally {
      this.#inTransaction = false;
    }
    await this.client.query("COMMIT");
  }

  /** Runs `fn` in a transaction and expects COMMIT to be refused, by a deferred rule. */
  async expectCommitRefused(fn: () => Promise<void>, refusal: Refusal): Promise<void> {
    await this.client.query("BEGIN");
    this.#inTransaction = true;
    try {
      await fn();
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    } finally {
      this.#inTransaction = false;
    }
    const error = await this.client.query("COMMIT").then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expectRefusal(error, refusal, "COMMIT");
  }

  /**
   * Expects `sql` to be refused for the given reason. Inside a transaction it runs under a
   * savepoint, so the transaction carries on afterwards.
   */
  async expectRefused(sql: string, params: unknown[], refusal: Refusal): Promise<void> {
    const savepoint = this.#inTransaction;
    if (savepoint) await this.client.query("SAVEPOINT refused");
    const error = await this.client.query(sql, params).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    if (savepoint) await this.client.query("ROLLBACK TO SAVEPOINT refused");
    expectRefusal(error, refusal, sql);
  }
}

function expectRefusal(error: unknown, refusal: Refusal, sql: string): void {
  expect(error, `accepted, but should have been refused: ${sql}`).toBeInstanceOf(pg.DatabaseError);
  const { code, constraint, message } = error as pg.DatabaseError;
  expect({ code, constraint, message }).toMatchObject(
    "constraint" in refusal
      ? { code: refusal.code, constraint: refusal.constraint }
      : { code: refusal.code, message: expect.stringMatching(refusal.message) },
  );
}

/**
 * Gives the test file its own database, a copy of the migrated template, seeded by `seed`
 * (committed) and dropped after the file.
 */
export function useDatabase(seed?: (db: TestDb) => Promise<void>): TestDb {
  const db = new TestDb();
  const server = new URL(inject("serverUrl"));
  let name: string | undefined;
  beforeAll(async () => {
    name = await createScratchFromTemplate(server, inject("templateDatabase"), "test");
    await db.connect(withDatabase(server, name));
    if (seed !== undefined) await seed(db);
  });
  afterAll(async () => {
    await db.close();
    if (name !== undefined) await dropScratch(server, name);
  });
  return db;
}
