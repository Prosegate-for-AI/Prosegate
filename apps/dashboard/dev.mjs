import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
execFileSync(process.execPath, ["build.mjs"], { cwd: root, stdio: "inherit" });
const assets = { "/assets/app.js": "text/javascript", "/assets/app.css": "text/css", "/config.json": "application/json" };
const headers = Object.fromEntries((await readFile(`${root}/dist/_headers`, "utf8")).split("\n")
  .filter((line) => line.startsWith("  ")).map((line) => {
    const at = line.indexOf(":"); return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }));
const server = createServer((req, res) => {
  void (async () => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path.startsWith("/v1/")) { res.writeHead(404).end("Configure PROSEGATE_API_ORIGIN to point at the Worker."); return; }
    const known = Object.hasOwn(assets, path), file = known ? path : ["/privacy", "/privacy/", "/privacy.html"].includes(path) ? "/privacy.html" : "/index.html";
    res.writeHead(200, { ...headers, "Content-Type": known ? assets[path] : "text/html" });
    res.end(await readFile(`${root}/dist${file}`));
  })().catch(() => { res.writeHead(500).end("Local dashboard unavailable."); });
});
server.listen(4173, "127.0.0.1", () => console.log("Dashboard: http://127.0.0.1:4173 (rebuild/restart after edits)"));
