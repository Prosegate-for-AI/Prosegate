// Headless and CI (09): no notice; report.json records each reviewed turn, and the shim prints one
// stderr line per reviewed turn from summaryLine() (W3.2 wires it). No colour, no emoji.

import { CATEGORIES, safeInline, type Category, type Finding, type ReviewResult } from "@prosegate/schema";
import type { TurnReport } from "./schemas.js";
import { profileSlug } from "./inject.js";

function plural(n: number, noun: string): string {
  return n === 1 ? `1 ${noun}` : `${n} ${noun}s`;
}

/** The report entry for one turn after a review call. `shippedRemaining` is the surviving findings after the pass cap. */
export function buildTurnReport(p: {
  turn: string;
  ordinal: number;
  result: ReviewResult;
  decision: "allow" | "continue";
  passes: number;
  shippedRemaining: number;
  ts: number;
}): TurnReport {
  const findings = p.result.findings.map((f: Finding) => ({
    category: f.category,
    rule_id: f.rule_id,
    severity: f.severity,
    text: [...safeInline(f.span.text)].slice(0, 80).join(""),
  }));
  return {
    turn: p.turn,
    ordinal: p.ordinal,
    profile: p.result.profile.id,
    passes: p.passes,
    verdict: p.result.verdict,
    ...(p.result.skipped_reason !== undefined && p.result.skipped_reason !== "pass_cap" ? { skipped_reason: p.result.skipped_reason } : {}),
    findings,
    cleared: p.result.cleared.length,
    shipped_remaining: p.shippedRemaining,
    decision: p.decision,
    ts: p.ts,
  };
}

const NOT_REVIEWED: Record<string, string> = {
  below_floor: "too short",
  no_prose: "no prose to check",
  reviewer_unavailable: "ran out of time",
  advisory_mode: "enforcement is off",
};

/**
 * One plain line for a reviewed turn, for the headless stderr summary (09, UX S10):
 * `Prosegate | turn 4 | profile base | 3 findings (filler 2, hedge 1) | 2 passes | 1 fixed | 2 remain, shipped as is`.
 * A clean turn reads `... | clean` (or `clean after 1 revision`); a turn that was not checked says so rather
 * than claiming it passed. The separator is ` | ` for CI logs, where the middle dot of the interactive notice
 * can arrive as mojibake; pass the dot for an interactive line.
 */
export function summaryLine(r: TurnReport, sep = " | "): string {
  const parts = ["Prosegate", `turn ${r.ordinal}`, `profile ${profileSlug(r.profile)}`];
  if (r.verdict === "skipped") {
    parts.push(`not reviewed (${NOT_REVIEWED[r.skipped_reason ?? ""] ?? "skipped"})`);
    return parts.join(sep);
  }
  if (r.findings.length === 0 && r.shipped_remaining === 0) {
    const revisions = Math.max(0, r.passes - 1);
    parts.push(revisions > 0 ? `clean after ${plural(revisions, "revision")}` : "clean");
    return parts.join(sep);
  }
  const counts = new Map<Category, number>();
  for (const f of r.findings) counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
  const byCategory = CATEGORIES.filter((c) => counts.has(c)).map((c) => `${c.replace(/_/g, " ")} ${String(counts.get(c))}`);
  if (r.findings.length > 0) parts.push(`${plural(r.findings.length, "finding")} (${byCategory.join(", ")})`);
  parts.push(`${r.passes} ${r.passes === 1 ? "pass" : "passes"}`);
  if (r.cleared > 0) parts.push(`${r.cleared} fixed`);
  if (r.shipped_remaining > 0) parts.push(`${r.shipped_remaining} remain, shipped as is`);
  return parts.join(sep);
}
