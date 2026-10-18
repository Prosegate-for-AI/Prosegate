// Fixture corpora for the eval:rules gate tests (eval-rules.test.ts). These are NOT the real corpora
// (eval/corpora is empty pending HQ-7 and HQ-8): they are built into a temp directory per test, from a
// small pool of plain engineering sentences that no `core` rule fires on, plus planted sentences that
// one specific rule fires on. The planted breach is therefore exactly the thing a test asserts on.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_PACK_YAML, parseRulePackYaml } from "@prosegate/profiles";

/** 30 sentences, none of which trips a `core` rule (checked by the "clean fixture passes" test). */
const POOL = [
  "The cache stores each tenant's entries under a separate prefix.",
  "I moved the retry loop out of the handler.",
  "Tests for the parser now run in under two seconds on my laptop.",
  "The queue drains at about 400 messages per second when the workers are healthy and the network is quiet.",
  "That file was never read.",
  "Migration 0042 adds a nullable column to the orders table and backfills it in batches of 500 rows so the lock stays short.",
  "Nobody had set the timeout.",
  "Config lives in config/app.yaml.",
  "We pinned the client to version 3.2 because 3.3 changed how redirects are followed.",
  "The deploy failed twice before the third attempt went through.",
  "Logs from the staging run show the same error at the same offset each time.",
  "Rolling back takes one command.",
  "The scheduler wakes every thirty seconds and picks the oldest job whose lease has expired.",
  "I could not reproduce it on Linux.",
  "Each shard owns a contiguous range of keys, and a router maps a key to its shard with a binary search over the range boundaries.",
  "The new index cut the p95 query time from 840 ms to 95 ms.",
  "Reviewers asked for a benchmark.",
  "The patch touches three files under src/auth.",
  "Windows paths need an extra normalisation step before the comparison.",
  "A stale lock file was the cause.",
  "The export job writes one file per day and compresses it after midnight UTC.",
  "Memory use stays flat after the fix.",
  "Open question: should expired sessions be deleted eagerly or swept nightly?",
  "The webhook signs its payload with a shared secret and the receiver rejects anything older than five minutes.",
  "Two tests were flaky because they shared a temp directory.",
  "The linter now fails the build on unused imports.",
  "Our staging database is a week behind production.",
  "Clients retry with exponential backoff capped at one minute.",
  "I left the old endpoint in place until the mobile team confirms the upgrade.",
  "The report shows 14 slow queries; 9 of them come from the same view.",
];

export interface BuiltDoc {
  text: string;
  /** Offset of the first occurrence of each planted phrase, for gold spans. */
  spans: Array<{ phrase: string; start: number; end: number }>;
}

/** A clean two-paragraph document (about 110 words) numbered `i`; `plant` is inserted as a sentence of the first paragraph. */
export function doc(i: number, plant?: string): BuiltDoc {
  const pick = (k: number): string => POOL[(i * 7 + k * 3) % POOL.length] as string;
  const first = [pick(0), pick(1), pick(2), pick(3), pick(4)];
  if (plant !== undefined) first.splice(2, 0, plant);
  const second = [pick(5), pick(6), pick(7), pick(8), `Ticket ${1000 + i} tracks the follow-up.`];
  const text = `${first.join(" ")}\n\n${second.join(" ")}\n`;
  return { text, spans: [] };
}

/** Same as doc(), recording where `phrase` (inside `plant`) sits so a gold span can point at it. */
export function docWithSpan(i: number, plant: string, phrase: string): BuiltDoc {
  const d = doc(i, plant);
  const start = d.text.indexOf(plant) + plant.indexOf(phrase);
  return { text: d.text, spans: [{ phrase, start, end: start + phrase.length }] };
}

export const HUMAN_META = { source: "fixture", licence: "CC0-1.0", date: "2019-06-01", author: "fixture author", notes: "synthetic test item" };
export const AI_META = { model: "fixture-model", model_version: "0", prompt_file: "prompts/fixture.md", generated_at: "2026-01-01T00:00:00Z" };

export class FixtureCorpora {
  readonly root: string;
  constructor() {
    this.root = mkdtempSync(join(tmpdir(), "prosegate-evalrules-"));
  }

  private write(rel: string, content: string): void {
    const path = join(this.root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }

  human(profile: string, id: string, text: string, meta: Record<string, unknown> = HUMAN_META): this {
    this.write(`human-control/${profile}/${id}.md`, text);
    this.write(`human-control/${profile}/${id}.meta.json`, JSON.stringify(meta));
    return this;
  }

  ai(profile: string, id: string, text: string, gold: unknown[] = [], meta: Record<string, unknown> = AI_META): this {
    this.write(`ai/${profile}/${id}.md`, text);
    this.write(`ai/${profile}/${id}.gold.json`, JSON.stringify(gold));
    this.write(`ai/${profile}/${id}.meta.json`, JSON.stringify(meta));
    return this;
  }

  /** `n` human-control documents under local/<profile>; the ones whose index is in `planted` carry `plant`. */
  humanSet(n: number, plant?: string, planted: number[] = [], profile = "base", prefix = "h"): this {
    for (let i = 0; i < n; i++) this.human(profile, `${prefix}${String(i).padStart(3, "0")}`, doc(i, planted.includes(i) ? plant : undefined).text);
    return this;
  }

  /** `n` documents too short for the token floor (about 5 words), each carrying `text`. */
  humanShort(n: number, text = "Short note about the cache."): this {
    for (let i = 0; i < n; i++) this.human("base", `s${String(i).padStart(3, "0")}`, `${text}
`);
    return this;
  }

  /**
   * `total` AI documents under local/base; the first `n` hold `sentence` (containing `phrase`). `goldFor`
   * returns the gold spans of document i given where `phrase` sits (start, end), or of a plain document
   * (span undefined) given its first sentence range.
   */
  aiPlanted(total: number, n: number, sentence: string, phrase: string, goldFor: (i: number, span: { start: number; end: number } | undefined, first: { start: number; end: number }) => unknown[]): this {
    for (let i = 0; i < total; i++) {
      const id = `a${String(i).padStart(3, "0")}`;
      const d = i < n ? docWithSpan(i, sentence, phrase) : doc(i);
      const first = { start: 0, end: d.text.indexOf(".") + 1 };
      const span = d.spans[0];
      this.ai("base", id, d.text, goldFor(i, span === undefined ? undefined : { start: span.start, end: span.end }, first));
    }
    return this;
  }

  /**
   * An AI corpus of `total` documents under local/base. The first `hits` of them hold `sentence`
   * (containing `phrase`); the first `confirmed` of those also have a gold span on it.
   */
  aiSet(total: number, hits: number, confirmed: number, sentence: string, phrase: string, ruleId: string, category: string): this {
    for (let i = 0; i < total; i++) {
      const id = `a${String(i).padStart(3, "0")}`;
      if (i < hits) {
        const d = docWithSpan(i, sentence, phrase);
        const gold = i < confirmed ? d.spans.map((s) => ({ category, rule_id: ruleId, start: s.start, end: s.end })) : [];
        this.ai("base", id, d.text, gold);
      } else {
        this.ai("base", id, doc(i).text, []);
      }
    }
    return this;
  }
}

/** The rule ids of the bundled `core` pack. */
export function coreRuleIds(): string[] {
  const parsed = parseRulePackYaml(BUNDLED_PACK_YAML["core@0.1.0"] as string);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value.rules.map((r) => r.id);
}

/**
 * Writes a baseline file with one entry per rule id (all null, i.e. unmeasured) and returns its path.
 * `entries` overrides individual rules; `omit` leaves rules out; `ids` replaces the rule list (other packs).
 */
export function baselineFile(entries: Record<string, { precision?: number | null; fp_rate?: number | null }> = {}, opts: { omit?: string[]; ids?: string[] } = {}): string {
  const rules: Record<string, { precision: number | null; fp_rate: number | null }> = {};
  for (const id of opts.ids ?? coreRuleIds()) {
    if (opts.omit?.includes(id) === true) continue;
    rules[id] = { precision: entries[id]?.precision ?? null, fp_rate: entries[id]?.fp_rate ?? null };
  }
  const dir = mkdtempSync(join(tmpdir(), "prosegate-evalrules-bl-"));
  const path = join(dir, "baseline.json");
  writeFileSync(path, JSON.stringify({ schema: "prosegate.eval-baseline/1", rules }, null, 2));
  return path;
}
