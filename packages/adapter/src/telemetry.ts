// Telemetry (07 "Telemetry allowlist", ADR-20). Typed constructors only: an event is built from
// counts, categories, rule ids and fixed enums, never from text. The spool is written through
// encodeTelemetryBatch, the one function that masks local names, validates against the strict wire
// schema and serialises the parsed value. The synced-id sets are empty in this item (no config
// service), so every profile id masks to `local` and every non-`core` rule id is dropped.
//
// Nothing is sent: flushTelemetry() is the Phase 7 hook.

import { join } from "node:path";
import {
  ERROR_CODES,
  HARNESSES,
  TELEMETRY_BATCH_MAX,
  encodeTelemetryBatch,
  truncateToMinute,
  type Category,
  type ErrorCode,
  type SkippedReason,
  type TelemetryMaskContext,
} from "@prosegate/schema";
import type { Ctx } from "./ctx.js";
import { appendLine, ensureDir, readFileOrNull, withLock, writeFileAtomic } from "./fs-secure.js";
import { log } from "./log.js";
import { VERSION } from "./version.js";

/** The spool keeps at most this many events; the oldest are dropped first (brief). */
export const SPOOL_MAX_EVENTS = 1000;

/** A wire event as built here: `ts` is added when the batch is recorded. */
export type TelemetryDraft =
  | { t: "session_start"; harness: (typeof HARNESSES)[number]; adapter_version: string; profile_count: number; offline: boolean }
  | {
      t: "review";
      profile_id: string;
      pass: 1 | 2;
      verdict: "pass" | "revise" | "skipped";
      skipped_reason?: SkippedReason;
      prose_words_bucket: number;
      by_category: Partial<Record<Category, number>>;
      rule_ids: string[];
      cleared: number;
      cleared_categories: Category[];
    }
  | { t: "enforcement"; decision: "allow" | "continue"; enforcement_unavailable: boolean; override_used: boolean; notice_via_model: boolean }
  | { t: "profile_select"; from: string; to: string; by: "model" | "heuristic" | "user" }
  | { t: "error"; code: ErrorCode };

export function isKnownHarness(name: string): name is (typeof HARNESSES)[number] {
  return (HARNESSES as readonly string[]).includes(name);
}

export function sessionStartEvent(p: { harness: (typeof HARNESSES)[number]; profileCount: number; offline: boolean }): TelemetryDraft {
  return { t: "session_start", harness: p.harness, adapter_version: VERSION, profile_count: p.profileCount, offline: p.offline };
}

export function reviewEvent(p: {
  profileId: string;
  pass: 1 | 2;
  verdict: "pass" | "revise" | "skipped";
  skippedReason?: SkippedReason | undefined;
  proseWords: number;
  byCategory: Partial<Record<Category, number>>;
  ruleIds: readonly string[];
  cleared: number;
  clearedCategories: readonly Category[];
}): TelemetryDraft {
  const event: TelemetryDraft = {
    t: "review",
    profile_id: p.profileId,
    pass: p.pass,
    verdict: p.verdict,
    prose_words_bucket: Math.floor(Math.max(0, p.proseWords) / 100) * 100,
    by_category: { ...p.byCategory },
    rule_ids: [...new Set(p.ruleIds)].slice(0, 64),
    cleared: p.cleared,
    cleared_categories: [...new Set(p.clearedCategories)],
  };
  if (p.skippedReason !== undefined) event.skipped_reason = p.skippedReason;
  return event;
}

export function enforcementEvent(p: { decision: "allow" | "continue"; overrideUsed: boolean; enforcementUnavailable?: boolean }): TelemetryDraft {
  return {
    t: "enforcement",
    decision: p.decision,
    enforcement_unavailable: p.enforcementUnavailable ?? false,
    override_used: p.overrideUsed,
    // The notice reaches the user through the harness, never through the model (ADR-13).
    notice_via_model: false,
  };
}

export function profileSelectEvent(p: { from: string; to: string; by: "model" | "heuristic" | "user" }): TelemetryDraft {
  return { t: "profile_select", from: p.from, to: p.to, by: p.by };
}

export function errorEvent(code: ErrorCode): TelemetryDraft {
  if (!(ERROR_CODES as readonly string[]).includes(code)) throw new Error("unknown error code");
  return { t: "error", code };
}

/** No synced profiles or packs exist in the free tier, so everything local is masked. */
const MASK: TelemetryMaskContext = { syncedProfileIds: new Set<string>(), syncedPackIds: new Set<string>() };

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

/** The exact bytes that would be spooled for these events (used by the outbound security test). */
export function encodeBatch(drafts: readonly TelemetryDraft[], nowMs: number): string {
  const ts = truncateToMinute(nowMs);
  const events = shuffle(drafts.slice(0, TELEMETRY_BATCH_MAX).map((d) => ({ ...d, ts })));
  return encodeTelemetryBatch({ events }, MASK);
}

function spoolPath(ctx: Ctx): string {
  return join(ctx.home, "telemetry", "spool.jsonl");
}

/** Events in one spooled line. Every line is encodeTelemetryBatch output, where each event holds exactly one `"t":"` and no string can contain a quote. */
function eventCount(line: string): number {
  return line.split("\"t\":\"").length - 1;
}

/**
 * Appends one batch line to the spool, keeping at most SPOOL_MAX_EVENTS events (oldest dropped).
 * Never throws: a telemetry failure is logged and the turn goes on.
 */
export function recordEvents(ctx: Ctx, drafts: readonly TelemetryDraft[]): void {
  if (drafts.length === 0) return;
  try {
    const line = encodeBatch(drafts, ctx.now());
    const dir = join(ctx.home, "telemetry");
    ensureDir(dir, ctx.platform);
    const file = spoolPath(ctx);
    withLock(`${file}.lock`, () => {
      const existing = readFileOrNull(file);
      if (existing === null || existing === "") {
        appendLine(file, `${line}\n`);
        return;
      }
      const lines = existing.split("\n").filter((l) => l !== "");
      const added = eventCount(line);
      let total = added;
      const counts = lines.map(eventCount);
      for (const c of counts) total += c;
      if (total <= SPOOL_MAX_EVENTS) {
        appendLine(file, `${line}\n`);
        return;
      }
      // Over the bound: drop whole lines from the front until the new total fits.
      let drop = 0;
      while (drop < lines.length && total > SPOOL_MAX_EVENTS) {
        total -= counts[drop] ?? 0;
        drop++;
      }
      writeFileAtomic(file, `${[...lines.slice(drop), line].join("\n")}\n`);
    });
  } catch {
    log(ctx, "warn", "telemetry_dropped", "could not spool telemetry");
  }
}

/** Reads the spool back (tests and the Phase 7 sender). */
export function readSpool(ctx: Ctx): string[] {
  const text = readFileOrNull(spoolPath(ctx));
  return text === null ? [] : text.split("\n").filter((l) => l !== "");
}

/**
 * Phase 7 (config service): sends the spool and empties it. In this item there is no network call,
 * by design (the adapter keeps prose and everything else on the machine); this stub returns at once.
 */
export function flushTelemetry(): Promise<{ sent: 0 }> {
  return Promise.resolve({ sent: 0 });
}
