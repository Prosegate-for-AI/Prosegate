import { defineConfig } from "vitest/config";

// Wall-clock budget tests (ADR-10) live in `perf.test.ts` / `cold.test.ts` files and run
// separately, serially, via `pnpm test:perf` (vitest.perf.config.ts). In the parallel unit run
// they flake under machine load and say nothing about the code.
export const PERF_TESTS = ["**/test/perf.test.ts", "**/test/cold.test.ts"];

export default defineConfig({
  test: {
    include: ["**/*.test.{ts,mjs}"],
    exclude: ["**/node_modules/**", "**/dist/**", "docs/**", ".claude/**", ...PERF_TESTS],
    // Script tests spawn subprocesses and temp git repos.
    testTimeout: 30_000,
    // Incident 2026-10-18: no test may reach a real home. The global setup points every home variable at a temp tree and
    // fails the run if the real Claude settings change; the setup file does the same in each worker.
    globalSetup: ["packages/adapter/test/global-setup.ts"],
    setupFiles: ["packages/adapter/test/setup-env.ts"],
  },
});
