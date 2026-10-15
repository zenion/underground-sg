// `pnpm map`: the publish CLI, on the stack in the root .env. The publish runs here, as a library
// function in a process of its own, never in the API process (CLAUDE.md); nothing publishes over
// HTTP.
//
//   pnpm map gates <change-set-id>                 run the automated gates and record the result
//   pnpm map publish <change-set-id>... [options]  publish change sets whose gates passed
//       --by <contributor-id>   publish as this contributor (default: the one with tier owner,
//                               the demo's owner aside)
//       --note <text>           map_versions.note (private)
//   pnpm map reconcile                             repair latest.json from map_head
//
// latest.json's `demo` flag follows the database (src/demo-flag.ts): there is no option for it.

import { DEMO_OWNER } from "@usg/db/demo";
import { loadRootEnv } from "@usg/scripts/env";
import { unreachableMessage } from "@usg/scripts/errors";
import type { Kysely } from "kysely";
import { ConfigError, loadStackConfig, type StackConfig, stackServices } from "../config.ts";
import { createDatabase, type Database } from "../database.ts";
import { GatesRefusedError, runGates } from "../publish/gates.ts";
import { ReconcileError, reconcileLatest } from "../publish/pointer.ts";
import { PublishRefusedError, publish } from "../publish/publish.ts";
import { createS3Storage, type Storage } from "../storage.ts";

const USAGE = [
  "usage: pnpm map gates <change-set-id>",
  "       pnpm map publish <change-set-id>... [--by <contributor-id>] [--note <text>]",
  "       pnpm map reconcile",
].join("\n");

class UsageError extends Error {}

/** Splits `--name value` options and `--flag`s from positional arguments. */
function parse(args: readonly string[], valued: readonly string[], flags: readonly string[]) {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (valued.includes(arg)) {
      const value = args[i + 1];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      options.set(arg, value);
      i += 1;
    } else if (flags.includes(arg)) {
      options.set(arg, "true");
    } else if (arg.startsWith("--")) {
      throw new UsageError(`Unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

/** The one contributor with tier owner, leaving out the demo's owner. */
async function owner(db: Kysely<Database>): Promise<string> {
  const owners = await db
    .selectFrom("contributors")
    .select("id")
    .where("trust_tier", "=", "owner")
    .where("id", "<>", DEMO_OWNER)
    .execute();
  const only = owners[0];
  if (owners.length !== 1 || only === undefined) {
    throw new UsageError(
      `There are ${owners.length} contributors with tier owner: name one with --by <contributor-id>`,
    );
  }
  return only.id;
}

async function gates(db: Kysely<Database>, args: readonly string[]): Promise<number> {
  const { positional } = parse(args, [], []);
  const id = positional[0];
  if (positional.length !== 1 || id === undefined) throw new UsageError("Name one change set");
  const outcome = await runGates(db, id);
  console.log(`Gates ${outcome.passed ? "passed" : "FAILED"} for change set ${id}:`);
  for (const gate of outcome.gates) {
    console.log(`  ${gate.gate}: ${gate.result} (${gate.reason})`);
    for (const problem of gate.problems ?? []) console.log(`    - ${problem}`);
  }
  return outcome.passed ? 0 : 1;
}

async function publishCommand(
  db: Kysely<Database>,
  storage: Storage,
  args: readonly string[],
): Promise<number> {
  const { positional, options } = parse(args, ["--by", "--note"], []);
  const result = await publish(db, storage, {
    changeSetIds: positional,
    publishedBy: options.get("--by") ?? (await owner(db)),
    note: options.get("--note") ?? null,
  });
  for (const { id, reasons } of result.needsRebase) {
    console.log(`Change set ${id} needs a rebase; none of it was applied:`);
    for (const reason of reasons) console.log(`  - ${reason}`);
  }
  if (result.version === null) {
    console.log("No version was published.");
    return 1;
  }
  const v = result.version;
  console.log(`Published version ${v.id}: change sets ${result.published.join(", ")}`);
  console.log(
    `  ${v.directory} (uploaded: ${v.uploaded.join(", ") || "none"}; already there: ${v.reused.join(", ") || "none"})`,
  );
  console.log(`  private export ${v.exportKey}`);
  if (result.pointer.superseded === true) {
    console.log(
      "  latest.json left to the newer version published meanwhile, which writes its own",
    );
    return 0;
  }
  if (!result.pointer.updated) {
    console.error(
      `latest.json was not updated (${result.pointer.error}). The version stands; run \`pnpm map reconcile\`.`,
    );
    return 1;
  }
  console.log(`  latest.json updated${result.pointer.demo === true ? " (demo: true)" : ""}`);
  return 0;
}

async function reconcile(
  db: Kysely<Database>,
  storage: Storage,
  args: readonly string[],
): Promise<number> {
  const { positional } = parse(args, [], []);
  if (positional.length > 0) throw new UsageError("reconcile takes no change sets");
  const result = await reconcileLatest(db, storage);
  if (result.action === "nothing_published") {
    console.log("Nothing is published yet: map_head points at no version.");
    return 0;
  }
  console.log(
    result.action === "repaired"
      ? `latest.json repaired: it named version ${result.previousVersion ?? "none"}; now version ${result.version}`
      : `latest.json is current: version ${result.version}`,
  );
  if (result.statusWritten) console.log("  wrote an empty status.json");
  return 0;
}

async function main(db: Kysely<Database>, storage: Storage, args: string[]): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case "gates":
      return gates(db, rest);
    case "publish":
      return publishCommand(db, storage, rest);
    case "reconcile":
      return reconcile(db, storage, rest);
    default:
      throw new UsageError(command === undefined ? "Name a command" : `Unknown command ${command}`);
  }
}

loadRootEnv();
let exitCode = 1;
let config: StackConfig | undefined;
try {
  config = loadStackConfig();
  const db = createDatabase(config.databaseUrl, { maxConnections: 4 });
  const storage = createS3Storage(config.s3, config.buckets);
  try {
    exitCode = await main(db, storage, process.argv.slice(2));
  } finally {
    await db.destroy();
    storage.close();
  }
} catch (error) {
  const unreachable =
    config === undefined ? undefined : unreachableMessage(error, stackServices(config));
  if (unreachable !== undefined) {
    console.error(unreachable);
  } else if (error instanceof UsageError) {
    console.error(`${error.message}\n${USAGE}`);
    exitCode = 2;
  } else if (error instanceof PublishRefusedError) {
    console.error(`The publish was refused:\n${error.problems.map((p) => `  - ${p}`).join("\n")}`);
  } else if (
    error instanceof ConfigError ||
    error instanceof GatesRefusedError ||
    error instanceof ReconcileError
  ) {
    console.error(error.message);
  } else {
    throw error;
  }
}
process.exitCode = exitCode;
