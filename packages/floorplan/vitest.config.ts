import { defineConfig } from "vitest/config";

// Two projects: `unit` runs on the synthetic meshes generated in code and is part of the cached
// `pnpm test`; `venue` reads meshes recorded in a venue from the git-ignored .data/fixtures/ and
// runs only as the uncached `pnpm test:venue`, so a cached result never hides a skipped test.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/venue/**"],
        },
      },
      {
        test: {
          name: "venue",
          include: ["test/venue/**/*.test.ts"],
          testTimeout: 60_000,
        },
      },
    ],
  },
});
