import { defineConfig } from "vitest/config";

// Two projects: `unit` is part of the cached `pnpm test`; `repo` reads this repository's index
// (the hook's file mode), which isn't in the package's Turborepo hash, so it runs only as the
// uncached `pnpm test:repo`.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/repo/**"],
        },
      },
      {
        test: {
          name: "repo",
          include: ["test/repo/**/*.test.ts"],
        },
      },
    ],
  },
});
