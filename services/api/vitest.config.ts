import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Two projects: `unit` needs nothing running and is part of the cached `pnpm test`; `stack` needs
// the compose stack (PostGIS and RustFS, or CI's service containers) and runs only as the uncached
// `pnpm test:db`. Stack tests reuse @usg/db's harness: its global setup migrates a template
// database, and each test file copies it (`useDatabase`).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "stack",
          include: ["test/stack/**/*.test.ts"],
          globalSetup: [fileURLToPath(import.meta.resolve("@usg/db/test/global-setup"))],
          hookTimeout: 60_000,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
