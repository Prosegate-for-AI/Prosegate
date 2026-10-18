import { defineConfig } from "vitest/config";
import { PERF_TESTS } from "./vitest.config";

// Latency budgets (ADR-10), run one file at a time so tests do not compete for CPU.
export default defineConfig({
  test: {
    include: PERF_TESTS,
    exclude: ["**/node_modules/**", "**/dist/**", "docs/**", ".claude/**"],
    fileParallelism: false,
    testTimeout: 300_000,
    globalSetup: ["packages/adapter/test/global-setup.ts"],
    setupFiles: ["packages/adapter/test/setup-env.ts"],
  },
});
