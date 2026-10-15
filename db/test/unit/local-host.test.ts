// isLocalHost (src/config.ts), which guards `pnpm db rollback`, recreateLocalDatabase (`pnpm demo
// --reset`) and the demo: a database URL is local only as the drivers read it. node-postgres takes
// a `host` query parameter over the URL's host, and lib/pq (dbmate) takes `host` and `hostaddr`, so
// a URL naming localhost with one of them would reach another server.

import { describe, expect, test } from "vitest";
import { isLocalHost } from "../../src/config.ts";

describe("isLocalHost", () => {
  test.each([
    "postgres://usg:x@localhost:25432/usg",
    "postgres://usg:x@127.0.0.1:25432/usg",
    "postgres://usg:x@[::1]:25432/usg",
    "postgres://usg:x@localhost:25432/usg?sslmode=disable",
  ])("%s is", (url) => {
    expect(isLocalHost(new URL(url))).toBe(true);
    expect(isLocalHost(url)).toBe(true);
  });

  test.each([
    "postgres://usg:x@db.example.com:5432/usg",
    "postgres://usg:x@localhost:25432/usg?host=remote.example",
    "postgres://usg:x@localhost:25432/usg?hostaddr=10.0.0.1",
    "postgres://usg:x@localhost:25432/usg?Host=remote.example",
    "postgres://usg:x@localhost:25432/usg?service=prod",
    "postgres://usg:x@%2Fvar%2Frun%2Fpostgresql/usg",
    "postgres:///usg",
    "not a url",
  ])("%s isn't", (url) => {
    expect(isLocalHost(url)).toBe(false);
  });
});
