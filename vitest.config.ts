import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.{ts,mjs}"],
    exclude: ["**/node_modules/**", "**/dist/**", "docs/**", ".claude/**"],
    // Script tests spawn subprocesses and temp git repos.
    testTimeout: 30_000,
  },
});
