import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
const result = await build({
  absWorkingDir: root, entryPoints: ["src/index.ts"], outfile: "dist/worker.js",
  bundle: true, format: "esm", platform: "browser", target: "es2022", metafile: true,
});
const forbidden = Object.keys(result.metafile.inputs).filter((p) => /(?:^|\/)(?:engine|reviewer|adapter|segmenter|re2js)(?:\/|@)/.test(p.replaceAll("\\", "/")));
if (forbidden.length || result.metafile.outputs["dist/worker.js"]?.imports.length) throw new Error("Config Worker dependency boundary violated");
await mkdir(new URL("dist", import.meta.url), { recursive: true });
await writeFile(new URL("dist/metafile.json", import.meta.url), JSON.stringify(result.metafile, null, 2));
console.log("Config Worker built; no engine, reviewer, adapter, segmenter, RE2 or external runtime imports.");
