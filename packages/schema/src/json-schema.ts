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

/** ADR-17: the emitted schemas are the producer form; consumers follow 03 "Versioning". */
export const PRODUCER_SCHEMA_COMMENT =
  'Producer schema; consumers must tolerate unknown optional fields and enum values per 03 Versioning.';

function emit(schema: z.ZodType, title: string): string {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' });
  return JSON.stringify({ ...json, $comment: PRODUCER_SCHEMA_COMMENT, title }, null, 2) + '\n';
}

export function generateJsonSchemas(): GeneratedSchemaFile[] {
  return [
    { file: 'prosegate.review.1.json', content: emit(ReviewRequestSchema, 'prosegate.review/1') },
    { file: 'prosegate.findings.1.json', content: emit(ReviewResultSchema, 'prosegate.findings/1') },
  ];
}
