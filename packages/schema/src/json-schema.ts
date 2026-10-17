// JSON Schema emission (03: "JSON Schema is generated from it at build time"). Pure and
// Node-free so the Worker can bundle the package and tests can regenerate in memory; the file
// writing lives in scripts/build-schema.ts.

import { z } from 'zod';
import { ReviewRequestSchema, ReviewResultSchema } from './schemas.js';

export interface GeneratedSchemaFile {
  /** File name under packages/schema/json/. */
  file: string;
  /** Exact file content, '\n' line endings, trailing newline. */
  content: string;
}

function emit(schema: z.ZodType, title: string): string {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' });
  return JSON.stringify({ ...json, title }, null, 2) + '\n';
}

export function generateJsonSchemas(): GeneratedSchemaFile[] {
  return [
    { file: 'prosegate.review.1.json', content: emit(ReviewRequestSchema, 'prosegate.review/1') },
    { file: 'prosegate.findings.1.json', content: emit(ReviewResultSchema, 'prosegate.findings/1') },
  ];
}
