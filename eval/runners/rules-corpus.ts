// Corpus loading and validation for `pnpm eval:rules` (docs/10 "Corpora"). Layout: eval/corpora/README.md.
//
// Every problem found is collected (not just the first) and thrown as one HarnessError, which the CLI
// maps to exit code 2: a corrupt corpus must never turn into a quiet pass.
//
// The meta and gold schemas are strict zod objects: unknown keys are rejected.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { isCorpusRef } from "@prosegate/profiles";
import { CATEGORIES, type Category } from "@prosegate/schema";

export class HarnessError extends Error {
  readonly problems: readonly string[];
  constructor(message: string, problems: readonly string[] = []) {
    super(message);
    this.name = "HarnessError";
    this.problems = problems;
  }
}

export interface GoldSpan {
  category: Category;
  rule_id?: string;
  start: number;
  end: number;
  text?: string;
}

export type DocKind = "human-control" | "ai" | "adversarial-human-machinelike" | "adversarial-ai-passed";

export interface CorpusDoc {
  kind: DocKind;
  /** Profile name (the directory name): `base` means `local/base`. Adversarial items use `base`. */
  profile: string;
  id: string;
  /** Path relative to the corpora root, forward slashes. */
  path: string;
  text: string;
  gold: GoldSpan[];
  meta: Record<string, unknown>;
}

export interface Corpora {
  humanControl: CorpusDoc[];
  ai: CorpusDoc[];
  advHumanMachinelike: CorpusDoc[];
  advAiPassed: CorpusDoc[];
}

export const EMPTY_CORPORA: Corpora = { humanControl: [], ai: [], advHumanMachinelike: [], advAiPassed: [] };

type Rec = Record<string, unknown>;

// ---- strict zod schemas ------------------------------------------------------------------------------------

const RULE_ID_RE = /^[a-z0-9-]{1,31}\.(filler|hedge|vocab|triad|structure|repetition)\.\d{3}$/;

/** YYYY, YYYY-MM or YYYY-MM-DD, a real calendar date. */
export function isPartialDate(s: string): boolean {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s);
  if (m === null) return false;
  const y = Number(m[1]);
  const mo = m[2] === undefined ? 1 : Number(m[2]);
  const d = m[3] === undefined ? 1 : Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function isIsoInstant(s: string): boolean {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(s);
  return m !== null && isPartialDate(m[1] as string) && !Number.isNaN(Date.parse(s));
}

const GATE = "LICENSING GATE";
const required = (name: string, gate = false) => ({
  error: `${gate ? `${GATE}: ` : ""}'${name}' is missing or not a string${gate ? ` (docs/10: every human-control item records its ${name})` : ""}`,
});
const nonEmpty = (name: string, gate = false) =>
  z.string(required(name, gate)).refine((s) => s.trim() !== "", `${gate ? `${GATE}: ` : ""}'${name}' is empty${gate ? ` (docs/10: every human-control item records its ${name})` : ""}`);

/** The human-control licence record (docs/10 "Licensing"). A missing or empty licence or date is the licensing gate. */
const HumanMetaSchema = z.strictObject({
  source: nonEmpty("source"),
  licence: nonEmpty("licence", true),
  date: z
    .string(required("date", true))
    .refine((s) => s.trim() !== "", `${GATE}: 'date' is empty (docs/10: every human-control item is dated)`)
    .refine((s) => s.trim() === "" || isPartialDate(s), "'date' must be YYYY, YYYY-MM or YYYY-MM-DD (a real date)"),
  author: nonEmpty("author").optional(),
  url: z
    .string()
    .refine((s) => {
      try {
        const u = new URL(s);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    }, "'url' must be an http(s) URL when present")
    .optional(),
  notes: nonEmpty("notes").optional(),
  redistribution: z.strictObject({ permitted: z.boolean(), evidence: nonEmpty("evidence") }).optional(),
});

const AiMetaSchema = z.strictObject({
  model: nonEmpty("model"),
  model_version: nonEmpty("model_version"),
  prompt_file: nonEmpty("prompt_file"),
  generated_at: z.string(required("generated_at")).refine(isIsoInstant, "'generated_at' must be an ISO date or date-time"),
  generation: nonEmpty("generation").optional(),
});

function isSplitPair(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return false;
  const prev = text.charCodeAt(i - 1);
  const cur = text.charCodeAt(i);
  return prev >= 0xd800 && prev <= 0xdbff && cur >= 0xdc00 && cur <= 0xdfff;
}

/** Gold spans are UTF-16 offsets into the .md; the schema needs the document text to check range, surrogates and `text`. */
function goldSchema(text: string) {
  return z
    .array(
      z
        .strictObject({
          category: z.enum(CATEGORIES, { error: `'category' must be one of ${CATEGORIES.join(", ")}` }),
          rule_id: z.string().regex(RULE_ID_RE, "'rule_id' must look like <pack>.<category>.<nnn>").optional(),
          start: z.number({ error: "'start' must be an integer" }).int("'start' must be an integer"),
          end: z.number({ error: "'end' must be an integer" }).int("'end' must be an integer"),
          text: z.string().optional(),
        })
        .superRefine((g, ctx) => {
          if (g.rule_id !== undefined && RULE_ID_RE.test(g.rule_id) && g.rule_id.split(".")[1] !== g.category) {
            ctx.addIssue({ code: "custom", message: `rule_id '${g.rule_id}' belongs to a different category than '${g.category}'` });
          }
          if (g.start < 0 || g.end <= g.start || g.end > text.length) {
            ctx.addIssue({ code: "custom", message: `span [${g.start}, ${g.end}) is out of range for a document of ${text.length} UTF-16 units` });
          } else if (isSplitPair(text, g.start) || isSplitPair(text, g.end)) {
            ctx.addIssue({ code: "custom", message: `span [${g.start}, ${g.end}) splits a surrogate pair (offsets are UTF-16 code units)` });
          } else if (g.text !== undefined && g.text !== text.slice(g.start, g.end)) {
            ctx.addIssue({ code: "custom", message: `'text' does not equal the slice [${g.start}, ${g.end}) of the document (${JSON.stringify(text.slice(g.start, g.end).slice(0, 40))})` });
          }
        }),
      { error: "must be a JSON array of gold spans" },
    );
}

function report(where: string, error: z.ZodError, problems: string[]): void {
  for (const issue of error.issues) {
    const path = issue.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("");
    if (issue.code === "unrecognized_keys") {
      for (const k of issue.keys) problems.push(`${where}${path}: unknown field '${k}' (strict schema)`);
    } else {
      problems.push(`${where}${path}: ${issue.message}`);
    }
  }
}

export function validateHumanMeta(raw: unknown, where: string, problems: string[]): void {
  const r = HumanMetaSchema.safeParse(raw);
  if (!r.success) report(where, r.error, problems);
}

export function validateAiMeta(raw: unknown, where: string, problems: string[]): void {
  const r = AiMetaSchema.safeParse(raw);
  if (!r.success) report(where, r.error, problems);
}

/** Validates a gold file against the document text and returns the spans (empty when invalid, with `problems` filled). */
export function validateGold(raw: unknown, text: string, where: string, problems: string[]): GoldSpan[] {
  const r = goldSchema(text).safeParse(raw);
  if (!r.success) {
    report(where, r.error, problems);
    return [];
  }
  return r.data.map((g) => {
    const span: GoldSpan = { category: g.category, start: g.start, end: g.end };
    if (g.rule_id !== undefined) span.rule_id = g.rule_id;
    if (g.text !== undefined) span.text = g.text;
    return span;
  });
}

// ---- directory walking -----------------------------------------------------------------------------

function listDir(dir: string): string[] {
  return readdirSync(dir).filter((n) => !n.startsWith(".")).sort();
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readJson(path: string, where: string, problems: string[]): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (e) {
    problems.push(`${where}: unreadable JSON (${e instanceof Error ? e.message : String(e)})`);
    return undefined;
  }
}

interface ItemSpec {
  kind: DocKind;
  /** Directory holding the items. */
  dir: string;
  /** Path of that directory relative to the corpora root. */
  rel: string;
  profile: string;
  humanMeta: boolean;
  /** Gold file is required (AI corpus) rather than optional (adversarial). */
  goldRequired: boolean;
  goldAllowed: boolean;
}

function loadItems(spec: ItemSpec, problems: string[]): CorpusDoc[] {
  const stems = new Map<string, { md: boolean; meta: boolean; gold: boolean }>();
  for (const name of listDir(spec.dir)) {
    const full = join(spec.dir, name);
    if (isDir(full)) {
      problems.push(`${spec.rel}/${name}: unexpected directory`);
      continue;
    }
    if (/^readme(\.md)?$/i.test(name)) continue;
    const m = /^(.+?)\.(meta\.json|gold\.json|md)$/.exec(name);
    if (m === null) {
      problems.push(`${spec.rel}/${name}: unexpected file (expected <id>.md, <id>.meta.json${spec.goldAllowed ? ", <id>.gold.json" : ""})`);
      continue;
    }
    const stem = m[1] as string;
    const ext = m[2] as string;
    const e = stems.get(stem) ?? { md: false, meta: false, gold: false };
    if (ext === "md") e.md = true;
    else if (ext === "meta.json") e.meta = true;
    else e.gold = true;
    stems.set(stem, e);
  }
  const docs: CorpusDoc[] = [];
  for (const [stem, has] of stems) {
    const base = `${spec.rel}/${stem}`;
    if (!has.md) {
      problems.push(`${base}: ${has.meta ? ".meta.json" : ".gold.json"} has no matching .md document`);
      continue;
    }
    if (!has.meta) {
      problems.push(`${base}.md: no ${base}.meta.json${spec.humanMeta ? " (licensing gate: every human item needs a licence record)" : ""}`);
      continue;
    }
    if (has.gold && !spec.goldAllowed) {
      problems.push(`${base}.gold.json: gold labels are not used for ${spec.kind} items`);
      continue;
    }
    if (!has.gold && spec.goldRequired) {
      problems.push(`${base}.md: no ${base}.gold.json (use [] for a document with no gold spans)`);
      continue;
    }
    const text = readFileSync(join(spec.dir, `${stem}.md`), "utf8");
    if (text.trim() === "") {
      problems.push(`${base}.md: empty document`);
      continue;
    }
    const metaRaw = readJson(join(spec.dir, `${stem}.meta.json`), `${base}.meta.json`, problems);
    const before = problems.length;
    if (metaRaw !== undefined) {
      if (spec.humanMeta) validateHumanMeta(metaRaw, `${base}.meta.json`, problems);
      else validateAiMeta(metaRaw, `${base}.meta.json`, problems);
    }
    let gold: GoldSpan[] = [];
    if (has.gold) {
      const goldRaw = readJson(join(spec.dir, `${stem}.gold.json`), `${base}.gold.json`, problems);
      if (goldRaw !== undefined) gold = validateGold(goldRaw, text, `${base}.gold.json`, problems);
    }
    if (metaRaw === undefined || problems.length > before) continue;
    docs.push({ kind: spec.kind, profile: spec.profile, id: stem, path: `${base}.md`, text, gold, meta: metaRaw as Rec });
  }
  return docs;
}

/**
 * Loads and validates every corpus under `root`. An absent corpus directory is an empty corpus (the
 * run then reports n/a); an unreadable or invalid item is a HarnessError.
 */
export function loadCorpora(root: string, knownProfiles: readonly string[]): Corpora {
  if (!isDir(root)) throw new HarnessError(`corpora directory not found: ${root}`);
  const problems: string[] = [];
  const out: Corpora = { humanControl: [], ai: [], advHumanMachinelike: [], advAiPassed: [] };

  const perProfile = (top: string, kind: DocKind, humanMeta: boolean): CorpusDoc[] => {
    const dir = join(root, top);
    if (!isDir(dir)) return [];
    const docs: CorpusDoc[] = [];
    for (const name of listDir(dir)) {
      const full = join(dir, name);
      if (!isDir(full)) {
        if (!/^readme(\.md)?$/i.test(name)) problems.push(`${top}/${name}: expected a profile directory (one of ${knownProfiles.join(", ")})`);
        continue;
      }
      if (!knownProfiles.includes(name)) {
        problems.push(`${top}/${name}: no bundled profile 'local/${name}' (known: ${knownProfiles.join(", ")})`);
        continue;
      }
      docs.push(...loadItems({ kind, dir: full, rel: `${top}/${name}`, profile: name, humanMeta, goldRequired: kind === "ai", goldAllowed: kind === "ai" }, problems));
    }
    return docs;
  };
  out.humanControl = perProfile("human-control", "human-control", true);
  out.ai = perProfile("ai", "ai", false);

  const adv = join(root, "adversarial");
  if (isDir(adv)) {
    for (const name of listDir(adv)) {
      const full = join(adv, name);
      if (name === "human-machinelike" && isDir(full)) {
        out.advHumanMachinelike = loadItems({ kind: "adversarial-human-machinelike", dir: full, rel: "adversarial/human-machinelike", profile: "base", humanMeta: true, goldRequired: false, goldAllowed: true }, problems);
      } else if (name === "ai-passed" && isDir(full)) {
        out.advAiPassed = loadItems({ kind: "adversarial-ai-passed", dir: full, rel: "adversarial/ai-passed", profile: "base", humanMeta: false, goldRequired: false, goldAllowed: true }, problems);
      } else if (!/^readme(\.md)?$/i.test(name)) {
        problems.push(`adversarial/${name}: expected human-machinelike/ or ai-passed/`);
      }
    }
  }

  if (problems.length > 0) {
    throw new HarnessError(`${problems.length} corpus problem${problems.length === 1 ? "" : "s"} (the run is refused: a bad corpus must not pass quietly)`, problems);
  }
  return out;
}

/** Resolves `<eval corpus ref: pack/name>` against `<dir>/<pack>/<name>.md`. */
export function readExampleRef(example: string, ruleExamplesDir: string): string {
  const m = /^<eval corpus ref: ([a-z0-9-]+)\/([a-z0-9-]+)>$/.exec(example);
  if (m === null) throw new HarnessError(`malformed corpus ref ${example}`);
  const file = join(ruleExamplesDir, m[1] as string, `${m[2] as string}.md`);
  if (!existsSync(file)) throw new HarnessError(`corpus ref ${example} points at a missing file: ${file}`);
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") throw new HarnessError(`corpus ref ${example} points at an empty file: ${file}`);
  return text;
}

export { isCorpusRef };
