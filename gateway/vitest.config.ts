import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // config.ts snapshots process.env on first import, so env must be set before any test file loads.
    setupFiles: ["./test/setup.ts"],
  },
});
