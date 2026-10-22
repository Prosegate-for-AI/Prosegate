import { readFileSync } from "node:fs";
import { z } from "zod";
import { ReviewRequestSchema, type Finding, type ReviewRequest } from "@prosegate/schema";
import { WRITING_CHECK_IDS, type ReviewerOutcome } from "@prosegate/reviewer";

const Context = ReviewRequestSchema.shape.context.partial();
const Case = z.strictObject({
  id: z.string().min(1), check: z.enum(WRITING_CHECK_IDS), expected: z.enum(["accept", "flag"]),
  text: z.string().min(1), context: Context,
});
export type WritingCase = z.infer<typeof Case>;
export interface WritingRow extends WritingCase {
  local: Finding[];
  outcome: ReviewerOutcome;
  raw: unknown[];
}
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8")) as unknown;

/** Synthetic exploratory cases, not human-adjudicated gold or a release qualification. */
export function writingCases(set: "all" | "exceptions" | "holdout" | "support-actors" = "all"): WritingCase[] {
  const pairs = z.array(z.tuple([z.enum(WRITING_CHECK_IDS), z.string(), z.string()])).parse(read("writing-review"));
  const contexts = z.record(z.string(), Context).parse(read("writing-contexts"));
  const base = pairs.flatMap(([check, hit, exception]) => [
    { id: `${check}/exception`, check, expected: "accept" as const, text: exception, context: contexts[`${check}/exception`] ?? {} },
    { id: `${check}/positive`, check, expected: "flag" as const, text: hit, context: contexts[`${check}/positive`] ?? {} },
  ]);
  const extra = z.array(Case).parse(read("writing-context-cases"));
  const holdout = z.array(Case).parse(read("writing-holdout"));
  const focused = z.array(Case).parse(read("writing-support-actors"));
  const all = [...base, ...extra, ...holdout, ...focused];
  if (new Set(all.map((c) => c.id)).size !== all.length) throw new Error("Duplicate writing case ID");
  return set === "support-actors" ? all.filter((c) => c.id === "missing-actor/positive" || c.id === "grounded-significance/exception" || focused.some((f) => f.id === c.id))
    : set === "holdout" ? holdout : set === "exceptions" ? all.filter((c) => c.expected === "accept") : all;
}

export function writingRequest(c: WritingCase): ReviewRequest {
  return ReviewRequestSchema.parse({ schema: "prosegate.review/1", text: c.text,
    context: { user_message: "Review this draft for clear, accurate writing. Preserve its meaning and necessary qualifications.", style_constraints: "", mode: "interactive", ...c.context },
    profile_id: "local/writing-review", pass: 1, stages: ["rules", "reviewer"], session_id: "live-eval", turn_id: c.id, prior_findings: [],
  });
}

const Raw = z.object({ findings: z.array(z.object({ check_id: z.string().nullable().optional(), span_text: z.string(), category: z.string() }).passthrough()) });
export function writingSummary(rows: WritingRow[]) {
  const completed = rows.filter((r) => r.outcome.error === null && r.outcome.skipped === null);
  const exceptions = completed.filter((r) => r.expected === "accept");
  const positives = completed.filter((r) => r.expected === "flag");
  const flagged = (r: WritingRow) => r.local.length + r.outcome.findings.length > 0;
  // The public findings schema does not carry check_id. Match only a retained span/category
  // back to the final provider response; raw diagnoses discarded by enforcement do not count.
  const target = (r: WritingRow) => {
    const raw = Raw.safeParse(r.raw.at(-1));
    const contextual = raw.success && raw.data.findings.some((f) => f.check_id === r.check && r.outcome.findings.some((g) => g.span.text === f.span_text && g.category === f.category));
    const localRule = r.check === "verbal-padding" ? "writing.filler.001" : r.check === "stacked-uncertainty" ? "writing.hedge.001" : null;
    return contextual || (localRule !== null && r.local.some((f) => f.rule_id === localRule));
  };
  return {
    cases: rows.length, completed: completed.length,
    errors: rows.filter((r) => r.outcome.error !== null).map((r) => ({ id: r.id, error: r.outcome.error })),
    skipped: rows.filter((r) => r.outcome.skipped !== null).map((r) => ({ id: r.id, reason: r.outcome.skipped })),
    exceptions: { completed: exceptions.length, accepted: exceptions.filter((r) => !flagged(r)).length, flagged: exceptions.filter(flagged).map((r) => r.id) },
    raw_exceptions: {
      empty: exceptions.filter((r) => { const raw = Raw.safeParse(r.raw.at(-1)); return raw.success && raw.data.findings.length === 0; }).length,
      nonempty: exceptions.filter((r) => { const raw = Raw.safeParse(r.raw.at(-1)); return raw.success && raw.data.findings.length > 0; }).map((r) => r.id),
      unavailable: exceptions.filter((r) => !Raw.safeParse(r.raw.at(-1)).success).map((r) => r.id),
      accepted_after_filtering: exceptions.filter((r) => { const raw = Raw.safeParse(r.raw.at(-1)); return !flagged(r) && raw.success && raw.data.findings.length > 0; }).map((r) => r.id),
    },
    positives: { completed: positives.length, with_any_finding: positives.filter(flagged).length, with_target_check: positives.filter(target).length,
      no_finding: positives.filter((r) => !flagged(r)).map((r) => r.id), other_check_only: positives.filter((r) => flagged(r) && !target(r)).map((r) => r.id) },
  };
}
