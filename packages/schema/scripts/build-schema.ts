// Writes packages/schema/json/*.json from the zod schemas. Run: pnpm --filter @prosegate/schema build:schema
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateJsonSchemas } from '../src/json-schema.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'json');
mkdirSync(outDir, { recursive: true });
for (const { file, content } of generateJsonSchemas()) {
  writeFileSync(join(outDir, file), content, 'utf8');
  console.log(`wrote json/${file}`);
}
