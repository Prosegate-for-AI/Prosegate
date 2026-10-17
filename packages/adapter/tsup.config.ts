import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

// One self-contained file (plan section 3): everything is inlined except node builtins and the
// optional native keychain module. tsup checks noExternal before external, so the keychain is
// excluded from the noExternal pattern rather than relying on external alone.
// `pnpm check:bundle` verifies the result.
const NATIVE = "@napi-rs/keyring";

export default defineConfig({
  entry: { prosegate: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  outExtension: () => ({ js: ".mjs" }),
  bundle: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  clean: true,
  noExternal: [/^(?!@napi-rs\/keyring(\/|$))/],
  external: [NATIVE],
  define: { __PROSEGATE_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: "#!/usr/bin/env node" },
});
