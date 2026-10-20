import { defineConfig } from "vitest/config";
import { PERF_TESTS } from "./vitest.config";

// Latency budgets and real-deadline integration checks run one file and test at
// a time. Concurrent fixture cases otherwise spawn many evaluator processes.
export default defineConfig({
  test: {
    include: PERF_TESTS,
    exclude: ["**/node_modules/**", "**/dist/**", "docs/**", ".claude/**"],
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 300_000,
    globalSetup: ["packages/adapter/test/global-setup.ts"],
    setupFiles: ["packages/adapter/test/setup-env.ts"],
  },
});
