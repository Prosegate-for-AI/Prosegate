import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateJsonSchemas } from './json-schema.js';

const jsonDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'json');
const lf = (s: string): string => s.replace(/\r\n/g, '\n');

describe('committed JSON Schema files', () => {
  const generated = generateJsonSchemas();

  it('emits exactly the two files 03 names', () => {
    expect(generated.map((g) => g.file)).toEqual(['prosegate.review.1.json', 'prosegate.findings.1.json']);
  });

  it.each(generated.map((g) => [g.file, g.content] as const))(
    'has not drifted from the zod schemas: %s (run `pnpm --filter @prosegate/schema build:schema`)',
    (file, content) => {
      const committed = lf(readFileSync(join(jsonDir, file), 'utf8'));
      expect(committed).toBe(content);
    },
  );

  it('encodes the strictness the validators enforce', () => {
    const findings = JSON.parse(generated[1]?.content ?? '') as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, { const?: string }>;
    };
    expect(findings.additionalProperties).toBe(false);
    expect(findings.required).not.toContain('skipped_reason');
    expect(findings.required).toContain('feedback_text');
    expect(findings.properties['schema']?.const).toBe('prosegate.findings/1');
    const request = JSON.parse(generated[0]?.content ?? '') as { additionalProperties: boolean };
    expect(request.additionalProperties).toBe(false);
  });
});
