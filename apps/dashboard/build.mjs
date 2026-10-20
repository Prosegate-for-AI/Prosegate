import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { privacyPage } from "./privacy-page.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const config = {
  apiOrigin: process.env.PROSEGATE_API_ORIGIN ?? "",
  authority: process.env.PROSEGATE_OIDC_AUTHORITY ?? "",
  clientId: process.env.PROSEGATE_OIDC_CLIENT_ID ?? "",
};
// An unconfigured local/CI build renders a setup screen; deploy builds must explicitly opt in.
const configured = Object.values(config).some(Boolean);
if (configured || process.env.PROSEGATE_DASHBOARD_DEPLOY === "1") {
  if (!config.clientId || config.clientId.length > 200) throw new Error("PROSEGATE_OIDC_CLIENT_ID is required.");
  for (const [name, value] of [["apiOrigin", config.apiOrigin], ["authority", config.authority]]) {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.search || /[\s<>]/.test(value) ||
        (name === "apiOrigin" && url.pathname !== "/") ||
        !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error(`Invalid dashboard ${name}`);
    if (process.env.PROSEGATE_DASHBOARD_DEPLOY === "1" && url.protocol !== "https:") throw new Error("Deployed dashboards require HTTPS.");
  }
}
await build({ absWorkingDir: root, entryPoints: ["src/index.ts"], outdir: "dist/assets", entryNames: "app",
  bundle: true, minify: true, format: "esm", platform: "browser", target: "es2022", sourcemap: false });
await mkdir(new URL("dist", import.meta.url), { recursive: true });
await writeFile(new URL("dist/index.html", import.meta.url), await readFile(new URL("index.html", import.meta.url)));
await writeFile(new URL("dist/privacy.html", import.meta.url), privacyPage(await readFile(new URL("../../PRIVACY.md", import.meta.url), "utf8")));
await writeFile(new URL("dist/config.json", import.meta.url), JSON.stringify(config));
const connections = configured ? [...new Set([new URL(config.apiOrigin).origin, new URL(config.authority).origin])].join(" ") : "";
await writeFile(new URL("dist/_headers", import.meta.url), `/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${connections}; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Cache-Control: no-store
`);
await writeFile(new URL("dist/_redirects", import.meta.url), "/privacy /privacy.html 200\n/privacy/ /privacy.html 200\n/* /index.html 200\n");
console.log(configured ? "Dashboard built with public OIDC configuration." : "Dashboard built in unconfigured mode. Set deployment variables before hosting.");
