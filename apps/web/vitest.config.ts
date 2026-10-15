import { defineConfig } from "vitest/config";

// The tests check the webapp's logic in Node. MapLibre itself needs WebGL, which Node lacks, so
// the map is checked in a browser (README.md, "Checking it in a browser").
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
