import { describe, expect, it } from "vitest";
import { renderNotice } from "@prosegate/schema";
import { profile, review, run } from "./helpers.js";

// 09 mock transcript 1: a pr-description turn (ADR-22: triad stays at warn there).

const OPENING =
  "This PR introduces a robust caching layer that significantly improves performance. " +
  "It's worth noting that the cache is per tenant, which makes the system fast, simple, and reliable.";

// Clean on purpose: no phrase of the pack, no list of three, no digits next to commas, varied lengths.
const CLEAN =
  " The cache sits in front of the catalog reads and keys every entry by tenant id." +
  " On the staging dataset the p95 latency of the catalog endpoint drops from 410 ms to 95 ms." +
  " Entries expire after five minutes, and a write to a product evicts that product immediately." +
  " The change adds one dependency and is off by default behind the CATALOG_CACHE flag." +
  " Tests cover eviction.";

const TEXT = OPENING + CLEAN;

const NOTICE = [
  "Prosegate · profile pr-description · 3 findings (hedge 1, vocab 1, triad 1) · revising, pass 1 of 2",
  `  hedge   core.hedge.001  "It's worth noting that"`,
  `  vocab   core.vocab.003  "robust"`,
  `  triad   core.triad.001  "fast, simple, and reliable"`,
].join("\n");

describe("09 mock transcript 1", () => {
  const resolved = profile("local/pr-description");
  const result = review(TEXT, { profile: resolved, keepFloor: true });

  it("is above the 60-word floor", () => {
    expect(result.verdict).not.toBe("skipped");
  });

  it("reports exactly the three findings of the mock", () => {
    expect(result.findings.map((f) => [f.rule_id, f.severity, f.span.text])).toEqual([
      ["core.vocab.003", "warn", "robust"],
      ["core.hedge.001", "block", "It's worth noting that"],
      ["core.triad.001", "warn", "fast, simple, and reliable"],
    ]);
    expect(run(TEXT, { profile: resolved, keepFloor: true }).diagnostics.all_findings).toHaveLength(3);
  });

  it("spans equal the text slices and the verdict is revise", () => {
    for (const f of result.findings) expect(TEXT.slice(f.span.start, f.span.end)).toBe(f.span.text);
    expect(result.verdict).toBe("revise");
    expect(result.findings.every((f) => f.profile_origin === "local/base")).toBe(true);
  });

  it("renderNotice reproduces the 09 notice byte for byte", () => {
    expect(renderNotice(result, { mode: "enforce", render: "diff", firstNoticeOfSession: false, phase: "pass1" })).toBe(NOTICE);
  });

  it("feedback_text is the canonical rendering, in document order", () => {
    expect(result.feedback_text).toBe(
      [
        '[Prosegate] 3 findings against profile "local/pr-description" (pass 1 of 2). Revise your last response.',
        '1. vocab (core.vocab.003) — "robust" → Replace with the property that makes it so, or remove.',
        '2. hedge (core.hedge.001) — "It\'s worth noting that" → Remove the preamble; keep the clause after it.',
        '3. triad (core.triad.001) — "fast, simple, and reliable" → Keep the one that matters, or give evidence for each.',
        "Reply with the revised response only. Do not run prosegate commands.",
        "To pause these revisions for this session, the user can run: prosegate advisory",
      ].join("\n"),
    );
  });

  it("wrapped lines (as the mock shows them) give the same findings", () => {
    const wrapped = TEXT.replace("significantly improves performance.", "significantly improves\nperformance.").replace("which makes the system", "which makes the\nsystem");
    const r = review(wrapped, { profile: resolved, keepFloor: true });
    expect(r.findings.map((f) => f.span.text)).toEqual(["robust", "It's worth noting that", "fast, simple, and reliable"]);
  });
});
