import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { CATEGORIES, type Category } from "@prosegate/schema";
import { HarnessError, validateGold, type CorpusDoc, type GoldSpan } from "../runners/rules-corpus.js";
import { hash, json, writeNew } from "./common.js";

const Identity = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).refine((s) => s.toLowerCase() !== "adjudication", "reserved identity");
const RecordSchema = z.strictObject({
  schema: z.literal("prosegate.annotation/1"),
  annotator: Identity,
  document_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: z.iso.datetime(),
  context: z.strictObject({ file: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  spans: z.array(z.unknown()),
});
const DecisionSchema = z.strictObject({
  schema: z.literal("prosegate.adjudication/1"),
  adjudicator: Identity,
  document_sha256: z.string(),
  annotations: z.array(z.strictObject({ annotator: Identity, sha256: z.string() })).length(2),
  gold_sha256: z.string(),
  note: z.string().min(1).max(2000),
});
export function marks(raw: unknown, text: string): GoldSpan[] {
  const problems: string[] = [];
  const spans = validateGold(raw, text, "annotation", problems);
  if (problems.length) throw new HarnessError("Invalid span marks: check categories, UTF-16 offsets and exact text.");
  const keys = spans.map((g) => JSON.stringify(g));
  if (new Set(keys).size !== keys.length) throw new HarnessError("Duplicate span marks.");
  return spans;
}
export const annotationDir = (file: string): string => join(dirname(file), ".annotations", basename(file, ".md"));
export function annotate(file: string, annotator: string, spans: unknown, contextFile?: string): void {
  Identity.parse(annotator);
  const text = readFileSync(file, "utf8");
  writeNew(join(annotationDir(file), `${annotator}.json`), {
    schema: "prosegate.annotation/1", annotator, document_sha256: hash(text), created_at: new Date().toISOString(), spans: marks(spans, text),
    ...(contextFile ? { context: { file: relative(dirname(file), contextFile).replace(/\\/g, "/"), sha256: hash(readFileSync(contextFile, "utf8")) } } : {}),
  });
}
export function readAnnotations(file: string) {
  const text = readFileSync(file, "utf8");
  const dir = annotationDir(file);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "adjudication.json").sort().map((name) => {
    const raw = readFileSync(join(dir, name), "utf8");
    const record = RecordSchema.parse(JSON.parse(raw) as unknown);
    if (record.document_sha256 !== hash(text) || name !== `${record.annotator}.json`) throw new HarnessError("Annotation belongs to a changed document or different annotator.");
    if (record.context && (isAbsolute(record.context.file) || record.context.sha256 !== hash(readFileSync(resolve(dirname(file), record.context.file), "utf8")))) throw new HarnessError("Annotation context has changed.");
    return { ...record, spans: marks(record.spans, text), sha256: hash(raw) };
  });
}
export function adjudicate(file: string, adjudicator: string, spans: unknown, note: string): void {
  Identity.parse(adjudicator);
  if (!note.trim() || note.length > 2000) throw new HarnessError("Adjudication needs a short rationale, even when both annotators agree.");
  const records = readAnnotations(file);
  if (records.length !== 2 || records.some((r) => r.annotator === adjudicator)) throw new HarnessError("Adjudication requires exactly two independent annotators and a third identity.");
  if (JSON.stringify(records[0]?.context) !== JSON.stringify(records[1]?.context)) throw new HarnessError("Both annotators must review the same context.");
  const text = readFileSync(file, "utf8");
  const gold = marks(spans, text);
  const goldPath = file.replace(/\.md$/, ".gold.json");
  const decisionPath = join(annotationDir(file), "adjudication.json");
  if (existsSync(goldPath) || existsSync(decisionPath)) throw new HarnessError("Gold or adjudication already exists; use a new item revision.");
  // Gold first: a failed receipt write leaves an unqualified item, never a qualified one.
  writeNew(goldPath, gold);
  writeNew(decisionPath, {
    schema: "prosegate.adjudication/1", adjudicator, document_sha256: hash(text),
    annotations: records.map((r) => ({ annotator: r.annotator, sha256: r.sha256 })),
    gold_sha256: hash(readFileSync(goldPath, "utf8")), note,
  });
}
export function qualified(file: string, contextFile?: string): boolean {
  const records = readAnnotations(file);
  if (contextFile && records.some((r) => !r.context || resolve(dirname(file), r.context.file) !== resolve(contextFile))) return false;
  if (JSON.stringify(records[0]?.context) !== JSON.stringify(records[1]?.context)) return false;
  const decisionPath = join(annotationDir(file), "adjudication.json");
  if (!existsSync(decisionPath)) return false;
  const d = DecisionSchema.parse(json(decisionPath));
  if (records.length !== 2 || records.some((r) => r.annotator === d.adjudicator) ||
      d.document_sha256 !== hash(readFileSync(file, "utf8")) ||
      d.gold_sha256 !== hash(readFileSync(file.replace(/\.md$/, ".gold.json"), "utf8")) ||
      new Set(d.annotations.map((a) => a.annotator)).size !== 2 ||
      records.some((r) => !d.annotations.some((a) => a.annotator === r.annotator && a.sha256 === r.sha256))) {
    throw new HarnessError("Adjudication no longer matches its document, annotations or gold.");
  }
  return true;
}
export type AgreementCounts = { both: number; first_only: number; second_only: number; neither: number };
export function kappa(c: AgreementCounts): number | null {
  const n = c.both + c.first_only + c.second_only + c.neither;
  if (!n) return null;
  const observed = (c.both + c.neither) / n;
  const p1 = (c.both + c.first_only) / n;
  const p2 = (c.both + c.second_only) / n;
  const expected = p1 * p2 + (1 - p1) * (1 - p2);
  return expected === 1 ? null : (observed - expected) / (1 - expected);
}
/** Binary decisions on each non-whitespace token; spans remain original UTF-16 offsets.
 * Fixed units include true negatives and cannot change when a rater adds a span. */
export function agreement(items: Array<{ text: string; first: GoldSpan[]; second: GoldSpan[] }>) {
  return Object.fromEntries(CATEGORIES.map((category: Category) => {
    const c: AgreementCounts = { both: 0, first_only: 0, second_only: 0, neither: 0 };
    for (const item of items) for (const token of item.text.matchAll(/\S+/gu)) {
      const start = token.index;
      const end = start + token[0].length;
      const has = (spans: GoldSpan[]) => spans.some((s) => s.category === category && s.start < end && start < s.end);
      const a = has(item.first), b = has(item.second);
      c[a && b ? "both" : a ? "first_only" : b ? "second_only" : "neither"]++;
    }
    const value = kappa(c);
    return [category, { ...c, kappa: value, gate_eligible: value !== null && value >= 0.6 }];
  }));
}

export function annotationSummary(root: string, docs: CorpusDoc[]) {
  const paired = [];
  let adjudicated = 0;
  for (const d of docs) {
    const file = join(root, d.path);
    const records = readAnnotations(file);
    if (records.length === 2 && records[0] && records[1]) paired.push({ text: d.text, first: records[0].spans, second: records[1].spans });
    if (qualified(file, typeof d.meta.prompt_file === "string" ? join(root, d.meta.prompt_file) : undefined)) adjudicated++;
  }
  return { documents: docs.length, paired: paired.length, adjudicated, categories: agreement(paired) };
}
