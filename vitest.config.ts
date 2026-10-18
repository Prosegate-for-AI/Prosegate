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
  },
});
