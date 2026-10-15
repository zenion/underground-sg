// dbmate with this repo's settings and DATABASE_URL from the root .env, so nobody has to
// export variables by hand on Windows. `pnpm migrate` runs `up`; `pnpm db status`,
// `pnpm db new <name>` and `pnpm db rollback --yes` run the others.

import { databaseName, databaseUrl, isLocalHost } from "../src/config.ts";
import { dbmate } from "../src/dbmate.ts";

const [command, ...rest] = process.argv.slice(2);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

switch (command) {
  case "new": {
    if (rest.length !== 1) fail("usage: pnpm db new <name>, for example pnpm db new add_drafts");
    process.exit(dbmate(["new", ...rest]).status ?? 1);
    break;
  }
  case "up": {
    // --wait: right after `docker compose up` the server may still be starting. dbmate also
    // retries a refused connection or a wrong password, so give up after 20 s rather than its
    // default minute: `docker compose up -d --wait` returns once the server is healthy, and
    // a fresh PostGIS is healthy in a few seconds.
    // --strict: refuse to apply a migration older than one already applied.
    process.exit(
      dbmate(["--wait", "--wait-timeout", "20s", "up", "--strict", ...rest], {
        url: databaseUrl(),
      }).status ?? 1,
    );
    break;
  }
  case "status": {
    process.exit(dbmate(["status", ...rest], { url: databaseUrl() }).status ?? 1);
    break;
  }
  case "rollback": {
    // Rolling back runs the newest migration's down section, which drops tables and their
    // rows. Only on a database on this machine, and only with --yes.
    const url = databaseUrl();
    if (!isLocalHost(url)) {
      fail(`Refusing to roll back ${url.hostname}: roll back a non-local database by hand.`);
    }
    if (!rest.includes("--yes")) {
      fail(
        `This runs the newest migration's down section on ${databaseName(url)}, dropping what it ` +
          "created, rows included. Run `pnpm db rollback --yes` to go ahead.",
      );
    }
    const args = rest.filter((arg) => arg !== "--yes");
    process.exit(dbmate(["rollback", ...args], { url }).status ?? 1);
    break;
  }
  default:
    fail("usage: node scripts/dbmate.ts up | status | new <name> | rollback --yes");
}
