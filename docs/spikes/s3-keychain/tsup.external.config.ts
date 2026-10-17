import { defineConfig } from 'tsup';
// Option (a): bundle all JS into one file, keep the native keyring external.
export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  outDir: 'dist',
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  external: ['@napi-rs/keyring'],
});
