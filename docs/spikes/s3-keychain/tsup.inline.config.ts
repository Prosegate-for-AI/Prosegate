import { defineConfig } from 'tsup';
// Negative test: try to inline @napi-rs/keyring (and its .node binary) into the single file.
export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  outDir: 'dist-inline',
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  bundle: true,
  splitting: false,
  clean: true,
  noExternal: [/.*/],
});
