import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * E2E against a real in-process Paseo daemon from the sibling checkout. Mirrors
 * packages/server/vitest.config.ts (alias, env, setup) so the daemon test harness loads unchanged.
 */
const checkout = path.resolve(__dirname, process.env.PASEO_CHECKOUT ?? "../../paseo");
const serverSrc = path.join(checkout, "packages/server/src");

export default defineConfig({
  resolve: {
    alias: { "@server": serverSrc },
  },
  test: {
    environment: "node",
    include: ["test/e2e/**/*.e2e.test.ts"],
    env: { PASEO_GIT_MAX_PROCESSES_PER_SECOND: "10000" },
    testTimeout: 120_000,
    hookTimeout: 120_000,
    setupFiles: [path.join(serverSrc, "test-utils/vitest-setup.ts")],
    pool: "forks",
    fileParallelism: false,
  },
});
