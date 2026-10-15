import { defineConfig } from "vitest/config";

// Unit tests for the app's pure logic (no React Native imports): they run in Node.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
