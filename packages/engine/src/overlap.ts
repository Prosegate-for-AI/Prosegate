// Overlap resolution (03 "Overlap resolution", ADR-17), exported because the reviewer stage reuses it.
//
// Two findings whose spans intersect are resolved in this order: higher severity wins; a rule
// finding beats a reviewer finding; the earlier span.start wins. The loser is dropped, not merged.
// A reviewer finding that fully contains a rule finding of a different category is kept (the one
// intersection a result may hold); one that contains a rule finding of the same category loses to
// it, whatever the severities. The output is sorted by start ascending, then end descending (the
// container first), so it satisfies the strict ReviewResult placement rule.
//
// Choices 03 leaves open:
//  - The order is applied as a ranking. Findings are visited best first and kept unless they
//    conflict with a finding already kept, so a finding that was itself dropped suppresses nobody.
//  - Ties beyond the three stated criteria (same severity, source and start) go to the longer span,
//    then the smaller rule id, then input order, so the result does not depend on input order.
//  - Findings with equal spans and a nesting pair (reviewer, rule) list the reviewer first.

import type { Category, Severity } from "@prosegate/schema";

/** The fields overlap resolution reads. A full Finding satisfies it. */
export interface Resolvable {
  severity: Severity;
  source: "rule" | "reviewer";
  category: Category;
  rule_id: string | null;
  span: { start: number; end: number };
}

const SEVERITY_RANK: Record<Severity, number> = { block: 0, warn: 1, info: 2 };

function compareRank(a: Resolvable, b: Resolvable): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    (a.source === b.source ? 0 : a.source === "rule" ? -1 : 1) ||
    a.span.start - b.span.start ||
    b.span.end - a.span.end ||
    compareStrings(a.rule_id ?? "", b.rule_id ?? "")
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Document order for output: start ascending, end descending, a reviewer container before the rule inside it. */
function compareOutput(a: Resolvable, b: Resolvable): number {
  return (
    a.span.start - b.span.start ||
    b.span.end - a.span.end ||
    (a.source === b.source ? 0 : a.source === "reviewer" ? -1 : 1) ||
    compareStrings(a.rule_id ?? "", b.rule_id ?? "")
  );
}

/** `outer` is a reviewer finding that fully contains the rule finding `inner`. */
function reviewerContainsRule(outer: Resolvable, inner: Resolvable): boolean {
  return outer.source === "reviewer" && inner.source === "rule" && outer.span.start <= inner.span.start && inner.span.end <= outer.span.end;
}

/** Sorted, pairwise-disjoint intervals of one source, with O(log n) intersection queries. */
class Disjoint<T extends Resolvable> {
  readonly items: T[] = [];

  /** Index of the first item whose end is > start (items are disjoint, so ends ascend too). */
  private firstEndingAfter(start: number): number {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.items[mid] as T).span.end > start) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  intersecting(f: Resolvable): T[] {
    const out: T[] = [];
    for (let i = this.firstEndingAfter(f.span.start); i < this.items.length; i++) {
      const it = this.items[i] as T;
      if (it.span.start >= f.span.end) break;
      out.push(it);
    }
    return out;
  }

  insert(f: T): void {
    this.items.splice(this.firstEndingAfter(f.span.start), 0, f);
  }

  remove(f: T): void {
    const i = this.items.indexOf(f);
    if (i >= 0) this.items.splice(i, 1);
  }
}

/**
 * Resolves overlaps (see the header). Returns a new array; the input is not modified. Spans must be
 * non-empty. O(n log n) apart from the cost of long runs of intersecting findings of the other source.
 */
export function resolveOverlaps<T extends Resolvable>(findings: readonly T[]): T[] {
  const order = findings.map((f, i) => ({ f, i })).sort((a, b) => compareRank(a.f, b.f) || a.i - b.i);
  // Within one source the kept findings never intersect; across sources only a nesting may.
  const rules = new Disjoint<T>();
  const reviewers = new Disjoint<T>();
  for (const { f } of order) {
    const own = f.source === "rule" ? rules : reviewers;
    const other = f.source === "rule" ? reviewers : rules;
    if (own.intersecting(f).length > 0) continue; // same source and intersecting: the kept one outranks f
    const crossing = other.intersecting(f);
    let drop = false;
    const supersede: T[] = [];
    for (const g of crossing) {
      const reviewer = f.source === "reviewer" ? f : g;
      const rule = f.source === "rule" ? f : g;
      if (reviewerContainsRule(reviewer, rule)) {
        if (reviewer.category === rule.category) {
          // The rule finding wins over a reviewer finding that contains it in the same category.
          if (f === rule) supersede.push(g);
          else drop = true;
        }
        continue; // nesting of different categories: both stay
      }
      drop = true; // a better-ranked finding of the other source overlaps f
    }
    if (drop) continue;
    for (const g of supersede) other.remove(g);
    own.insert(f);
  }
  return [...rules.items, ...reviewers.items].sort(compareOutput);
}
