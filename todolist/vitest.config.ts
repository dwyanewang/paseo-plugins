import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/e2e/**", "node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    fileParallelism: false,
  },
});
