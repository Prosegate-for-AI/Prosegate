import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
it("refuses unconfigured, insecure or credential-bearing deployed dashboard builds", () => {
  const valid = { PROSEGATE_API_ORIGIN: "https://config.example.test", PROSEGATE_OIDC_AUTHORITY: "https://auth.example.test", PROSEGATE_OIDC_CLIENT_ID: "public-client" };
  for (const override of [
    { PROSEGATE_OIDC_CLIENT_ID: "" }, { PROSEGATE_API_ORIGIN: "http://127.0.0.1:8787" },
    { PROSEGATE_OIDC_AUTHORITY: "https://user:password@auth.example.test" },
    { PROSEGATE_API_ORIGIN: "https://config.example.test/private" },
  ]) {
    const result = spawnSync(process.execPath, ["build.mjs"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, ...valid, ...override, PROSEGATE_DASHBOARD_DEPLOY: "1" }, encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain("user:password");
  }
});
