// Regenerates the TypeScript and Swift types from the JSON Schemas: `pnpm gen` (or
// `node scripts/gen.ts` in this package). CI runs it and fails if the output differs from git.

import { PACKAGE_DIR, writeGenerated } from "./codegen.ts";

const files = await writeGenerated(PACKAGE_DIR);
for (const file of files) console.log(`wrote ${file.path}`);
