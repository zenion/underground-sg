// The demo map's markers. `pnpm demo` (services/api/src/demo/) publishes made-up data to the local
// stack through the real path, starting with a contributor of its own, the demo owner. That row
// marks a database that holds the demo: nothing removes it but `pnpm demo --reset`, which recreates
// the database. The seed script and the publish read it, so real data never goes in beside the
// demo and a version built on it is always labelled demo data.

import type { Queryable } from "./seed.ts";

/** The demo's owner contributor (tier owner). Its presence means the database holds the demo. */
export const DEMO_OWNER = "de0000ff-0000-4000-8000-000000000001";

/** The one change set the demo publishes. */
export const DEMO_CHANGE_SET = "de000000-0000-4000-8000-000000000001";

/** What to tell someone about to put real data beside the demo. */
export const DEMO_PRESENT_MESSAGE =
  "The database holds the demo map (`pnpm demo`). Run `pnpm demo --reset` first: real data never goes in beside it.";

/** Whether the database holds the demo: its owner contributor exists. */
export async function holdsDemo(client: Queryable): Promise<boolean> {
  const { rows } = await client.query<{ demo: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM contributors WHERE id = $1) AS demo",
    [DEMO_OWNER],
  );
  return rows[0]?.demo === true;
}
