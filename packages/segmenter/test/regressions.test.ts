import { describe, expect, it } from "vitest";
import { analyse } from "../src/index.js";

const slice = (t: string, s: { start: number; end: number }): string => t.slice(s.start, s.end);

// Each case below was found by reading analyse() output on realistic text, or by the property tests.
describe("regressions", () => {
  it("an ordered item numbered 3 after a fence inside a list is still a list item", () => {
    const t = "2. Tests:\n   ```ts\n   x();\n   ```\n   Each fails on old code.\n3. Docs.\n";
    const a = analyse(t);
    expect(a.units.map((u) => `${u.kind}:${slice(t, u)}`)).toEqual([
      "list_item:Tests:",
      "sentence:Each fails on old code.",
      "list_item:Docs.",
    ]);
  });

  it("a lowercase unit like ms. does not count as the title Ms.", () => {
    const t = "Latency is 0.5 ms. Good. Ask Ms. Gray. Fine.";
    expect(analyse(t).units.map((u) => slice(t, u))).toEqual(["Latency is 0.5 ms.", "Good.", "Ask Ms. Gray.", "Fine."]);
  });

  it("an initial before a sentence starter is a sentence end (Appendix A. The next step)", () => {
    const t = "See Appendix A. The next step is B. Then C. Smith left. J. R. Smith stayed.";
    expect(analyse(t).units.map((u) => slice(t, u))).toEqual([
      "See Appendix A.",
      "The next step is B.",
      "Then C. Smith left.",
      "J. R. Smith stayed.",
    ]);
  });

  it("a title inside an as-X-put-it cue still attributes the quote", () => {
    const t = 'As Dr. Smith put it, "a bug fixed late is still a bug fixed", which is fair.';
    expect(analyse(t).segments.filter((s) => s.kind === "quote").map((s) => slice(t, s))).toEqual([
      '"a bug fixed late is still a bug fixed"',
    ]);
  });

  it("adjacent emails never produce overlapping masks", () => {
    const t = "Mail ops@example.comops@example.com now.";
    const ms = analyse(t).masks;
    for (let i = 1; i < ms.length; i++) expect((ms[i] as { start: number }).start).toBeGreaterThanOrEqual((ms[i - 1] as { end: number }).end);
  });

  it("an ordered list in CRLF text splits into the same units as LF", () => {
    const lf = "Steps:\n1. a\n2. b\n\nDone.\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(analyse(crlf).units.map((u) => [u.kind, slice(crlf, u)])).toEqual(analyse(lf).units.map((u) => [u.kind, slice(lf, u)]));
  });
});
