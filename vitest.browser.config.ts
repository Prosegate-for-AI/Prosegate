import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
process.env["PLAYWRIGHT_BROWSERS_PATH"] ??= fileURLToPath(new URL(".scratch/browsers", import.meta.url));
export default defineConfig({
  test: {
    include: ["apps/dashboard/test/*.browser.mjs"],
    testTimeout: 60000, hookTimeout: 60000, fileParallelism: false,
    globalSetup: ["packages/adapter/test/global-setup.ts"],
    setupFiles: ["packages/adapter/test/setup-env.ts"],
  },
});
