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
    profile: p.result.profile.id,
    passes: p.passes,
    verdict: p.result.verdict,
    findings,
    cleared: p.result.cleared.length,
    shipped_remaining: p.shippedRemaining,
    decision: p.decision,
    ts: p.ts,
  };
}

/**
 * One plain line for a reviewed turn, for the headless stderr summary:
 * `Prosegate · profile base · 3 findings (hedge 1, vocab 1, triad 1) · 2 passes · 1 cleared · 1 shipped as is`.
 * A clean turn reads `Prosegate · profile base · clean`.
 */
export function summaryLine(r: TurnReport): string {
  const parts = [`Prosegate · profile ${profileSlug(r.profile)}`];
  if (r.findings.length === 0 && r.shipped_remaining === 0) {
    parts.push(r.passes > 1 ? `clean after ${r.passes} passes` : "clean");
    return parts.join(" · ");
  }
  const counts = new Map<Category, number>();
  for (const f of r.findings) counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
  const byCategory = CATEGORIES.filter((c) => counts.has(c)).map((c) => `${c.replace(/_/g, " ")} ${String(counts.get(c))}`);
  if (r.findings.length > 0) parts.push(`${plural(r.findings.length, "finding")} (${byCategory.join(", ")})`);
  parts.push(`${r.passes} ${r.passes === 1 ? "pass" : "passes"}`);
  if (r.cleared > 0) parts.push(`${r.cleared} cleared`);
  if (r.shipped_remaining > 0) parts.push(`${r.shipped_remaining} shipped as is`);
  return parts.join(" · ");
}
