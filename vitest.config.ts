import { defineConfig } from "vitest/config";

// Real-clock checks run separately via `pnpm test:perf`, without other test workers.
// This includes the shim watchdog and CLI evaluation fixtures: both exercise real
// deadlines even when their primary assertion is functional. Keep all limits intact.
export const PERF_TESTS = [
  "**/test/perf.test.ts", "**/test/cold.test.ts",
  "packages/adapter/test/golden/shim.test.ts",
  "eval/runners/eval-rules.test.ts",
];

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
