// Corpus loading and validation for `pnpm eval:rules` (docs/10 "Corpora"). Layout: eval/corpora/README.md.
//
// Every problem found is collected (not just the first) and thrown as one HarnessError, which the CLI
// maps to exit code 2: a corrupt corpus must never turn into a quiet pass.
//
// The meta and gold schemas are strict: unknown keys are rejected. They are hand-written rather than
// zod because eval/package.json has no zod dependency and this item may add none; the checks are
// the ones a strict zod object would make.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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

const RULE_ID_RE = /^[a-z0-9-]{1,31}\.(filler|hedge|vocab|triad|structure|repetition)\.\d{3}$/;

// ---- tiny strict-object helpers ------------------------------------------------------------------

type Rec = Record<string, unknown>;

function isRec(x: unknown): x is Rec {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function checkKeys(raw: Rec, required: readonly string[], optional: readonly string[], where: string, problems: string[]): void {
  for (const k of required) if (!(k in raw)) problems.push(`${where}: missing required field '${k}'`);
  const known = new Set([...required, ...optional]);
  for (const k of Object.keys(raw)) if (!known.has(k)) problems.push(`${where}: unknown field '${k}' (strict schema)`);
}

function nonEmptyString(raw: Rec, key: string, where: string, problems: string[], required: boolean): void {
  if (!(key in raw)) return;
  const v = raw[key];
  if (typeof v !== "string" || v.trim() === "") {
    problems.push(`${where}: '${key}' must be a non-empty string${required ? "" : " when present"}`);
  }
}

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

/** The human-control licence record (docs/10 "Licensing"). Missing licence or date is the licensing gate. */
export function validateHumanMeta(raw: unknown, where: string, problems: string[]): void {
  if (!isRec(raw)) {
    problems.push(`${where}: must be a JSON object`);
    return;
  }
  if (!("licence" in raw) || typeof raw.licence !== "string" || raw.licence.trim() === "") {
    problems.push(`${where}: LICENSING GATE: 'licence' is missing or empty (docs/10: every human-control item records its licence)`);
  }
  if (!("date" in raw) || typeof raw.date !== "string" || raw.date.trim() === "") {
    problems.push(`${where}: LICENSING GATE: 'date' is missing or empty (docs/10: every human-control item is dated)`);
  } else if (!isPartialDate(raw.date)) {
    problems.push(`${where}: 'date' must be YYYY, YYYY-MM or YYYY-MM-DD, got '${raw.date}'`);
  }
  // licence and date are required too, but their absence is reported above as the licensing gate.
  checkKeys(raw, ["source"], ["licence", "date", "author", "url", "notes"], where, problems);
  nonEmptyString(raw, "source", where, problems, true);
  nonEmptyString(raw, "author", where, problems, false);
  nonEmptyString(raw, "notes", where, problems, false);
  if ("url" in raw) {
    let ok = false;
    if (typeof raw.url === "string") {
      try {
        const u = new URL(raw.url);
        ok = u.protocol === "http:" || u.protocol === "https:";
      } catch {
        ok = false;
      }
    }
    if (!ok) problems.push(`${where}: 'url' must be an http(s) URL when present`);
  }
}

export function validateAiMeta(raw: unknown, where: string, problems: string[]): void {
  if (!isRec(raw)) {
    problems.push(`${where}: must be a JSON object`);
    return;
  }
  checkKeys(raw, ["model", "model_version", "prompt_file", "generated_at"], [], where, problems);
  for (const k of ["model", "model_version", "prompt_file"]) nonEmptyString(raw, k, where, problems, true);
  if ("generated_at" in raw && (typeof raw.generated_at !== "string" || !isIsoInstant(raw.generated_at))) {
    problems.push(`${where}: 'generated_at' must be an ISO date or date-time`);
  }
}

function isSplitPair(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return false;
  const prev = text.charCodeAt(i - 1);
  const cur = text.charCodeAt(i);
  return prev >= 0xd800 && prev <= 0xdbff && cur >= 0xdc00 && cur <= 0xdfff;
}

/** Gold spans are UTF-16 offsets into the .md file; a span must be in range, and equal its slice when it carries `text`. */
export function validateGold(raw: unknown, text: string, where: string, problems: string[]): GoldSpan[] {
  if (!Array.isArray(raw)) {
    problems.push(`${where}: must be a JSON array of gold spans`);
    return [];
  }
  const out: GoldSpan[] = [];
  raw.forEach((item, i) => {
    const at = `${where}[${i}]`;
    if (!isRec(item)) {
      problems.push(`${at}: must be an object`);
      return;
    }
    const before = problems.length;
    checkKeys(item, ["category", "start", "end"], ["rule_id", "text"], at, problems);
    const category = item.category;
    if (typeof category !== "string" || !(CATEGORIES as readonly string[]).includes(category)) {
      problems.push(`${at}: 'category' must be one of ${CATEGORIES.join(", ")}`);
    }
    if ("rule_id" in item) {
      const rid = item.rule_id;
      if (typeof rid !== "string" || !RULE_ID_RE.test(rid)) {
        problems.push(`${at}: 'rule_id' must look like <pack>.<category>.<nnn>`);
      } else if (typeof category === "string" && rid.split(".")[1] !== category) {
        problems.push(`${at}: rule_id '${rid}' belongs to a different category than '${category}'`);
      }
    }
    const { start, end } = item;
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      problems.push(`${at}: 'start' and 'end' must be integers`);
    } else {
      const s = start as number;
      const e = end as number;
      if (s < 0 || e <= s || e > text.length) {
        problems.push(`${at}: span [${s}, ${e}) is out of range for a document of ${text.length} UTF-16 units`);
      } else if (isSplitPair(text, s) || isSplitPair(text, e)) {
        problems.push(`${at}: span [${s}, ${e}) splits a surrogate pair (offsets are UTF-16 code units)`);
      } else if ("text" in item && item.text !== text.slice(s, e)) {
        problems.push(`${at}: 'text' does not equal the slice [${s}, ${e}) of the document (${JSON.stringify(text.slice(s, e).slice(0, 40))})`);
      }
    }
    if ("text" in item && typeof item.text !== "string") problems.push(`${at}: 'text' must be a string when present`);
    if (problems.length === before) {
      const span: GoldSpan = { category: category as Category, start: start as number, end: end as number };
      if (typeof item.rule_id === "string") span.rule_id = item.rule_id;
      if (typeof item.text === "string") span.text = item.text;
      out.push(span);
    }
  });
  return out;
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

/**
 * Whether an example is a corpus reference. @prosegate/profiles has isCorpusRef but does not export it
 * from its index (and is out of scope here); parseRulePack has already rejected malformed references,
 * so this only has to tell a reference from a literal sentence.
 */
export function isCorpusRef(example: string): boolean {
  return /^<eval corpus ref: [a-z0-9-]+\/[a-z0-9-]+>$/.test(example);
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
