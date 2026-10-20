import { defineConfig } from "vitest/config";

// Two projects: `unit` needs nothing outside the package and is part of the cached `pnpm test`;
// `repo` reads this repository's index and runs the real .githooks/pre-push, neither of which is
// in the package's Turborepo hash, so it runs only as the uncached `pnpm test:repo` and a cached
// pass never hides a broken hook or a planted file.
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
