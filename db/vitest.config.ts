import { defineConfig } from "vitest/config";

// Two projects: `unit` needs nothing running and is part of the cached `pnpm test`; `db`
// needs PostGIS (the compose stack, or CI's service container) and runs only as the
// uncached `pnpm test:db`.
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
          name: "db",
          include: ["test/db/**/*.test.ts"],
          globalSetup: ["test/db/global-setup.ts"],
          hookTimeout: 60_000,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
