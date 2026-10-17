import { defineConfig } from 'tsup';
// Variant: inline, with esbuild's `copy` loader for .node so the binary is emitted next to the bundle.
export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  outDir: 'dist-inline-copy',
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  bundle: true,
  splitting: false,
  clean: true,
  noExternal: [/.*/],
  loader: { '.node': 'copy' },
});
