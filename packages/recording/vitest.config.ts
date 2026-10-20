import { defineConfig } from "vitest/config";

// The git check's tests run git in throwaway repositories, a few hundred commands in all, which
// Windows CI runners can take more than Vitest's default 5 s to get through for one test.
const testTimeout = 30_000;

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
          testTimeout,
        },
      },
      {
        test: {
          name: "repo",
          include: ["test/repo/**/*.test.ts"],
          testTimeout,
        },
      },
    ],
  },
});
