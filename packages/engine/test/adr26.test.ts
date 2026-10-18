import { describe, expect, it } from "vitest";
import { whitespaceRuns } from "../src/compile.js";
import { hits, packOf, profile, review, ruleYaml, run } from "./helpers.js";

const only = (text: string, ruleId: string, o: Parameters<typeof hits>[1] = {}): string[] =>
  hits(text, o)
    .filter(([id]) => id === ruleId)
    .map(([, t]) => t);

// ---- 1. normalised id key ---------------------------------------------------------------------

describe("the id key is the matched, normalised text (ADR-26)", () => {
  const body =
    "The worker reads the queue URL once, at startup. Config maps are mounted as files, and the files update within a minute. The worker never rereads them, so it is still polling the old queue. Messages are piling up in the new queue meanwhile. Restart the worker to reload the queue URL. The old queue keeps its messages for fourteen days, so nothing is lost while you wait for the restart.";

  /** Pass 1 on `t1`, then pass 2 on `t2` with the pass-1 ids. */
  function twoPasses(t1: string, t2: string) {
    const p1 = run(t1);
    const prior = p1.result.findings.map((f) => f.id);
    const p2 = run(t2, { pass: 2, prior });
    return { p1, p2, prior };
  }

  const KEPT: Array<[string, string, string, string]> = [
    ["curly apostrophe", `It's worth noting that the cache is per tenant. ${body}`, `It’s worth noting that the cache is per tenant. ${body}`, "core.hedge.001"],
    ["line wrap inside the tic", `It's worth noting that the cache is per tenant. ${body}`, `It's worth\nnoting that the cache is per tenant. ${body}`, "core.hedge.001"],
    ["CRLF wrap inside the tic", `It's worth noting that the cache is per tenant. ${body}`, `It's worth\r\nnoting that the cache is per tenant. ${body}`, "core.hedge.001"],
    ["double space inside the tic", `It's worth noting that the cache is per tenant. ${body}`, `It's worth  noting that the cache is per tenant. ${body}`, "core.hedge.001"],
    ["upper case", `It's worth noting that the cache is per tenant. ${body}`, `IT'S WORTH NOTING THAT the cache is per tenant. ${body}`, "core.hedge.001"],
    ["moved mid-sentence in lower case", `It's worth noting that the cache is per tenant. ${body}`, `The cache is per tenant, and it's worth noting that the index is unique. ${body}`, "core.hedge.001"],
    ["hedge.004 in another case", `The cache may or may not be per tenant. ${body}`, `May or may not: the cache is per tenant, depending. ${body}`, "core.hedge.004"],
    ["filler.001 'Great question!' becomes 'Great question.'", `Great question! The cache is per tenant. ${body}`, `Great question. The cache is per tenant. ${body}`, "core.filler.001"],
    ["identical text (control)", `It's worth noting that the cache is per tenant. ${body}`, `It's worth noting that the cache is per tenant. ${body}`, "core.hedge.001"],
  ];

  for (const [name, t1, t2, rule] of KEPT) {
    it(`${name}: the tic keeps its id, stays block on pass 2, and the verdict is revise`, () => {
      const { p1, p2 } = twoPasses(t1, t2);
      const before = p1.result.findings.find((f) => f.rule_id === rule);
      expect(before?.severity).toBe("block");
      const after = p2.result.findings.filter((f) => f.rule_id === rule);
      expect(after.length).toBeGreaterThan(0);
      expect(after[0]?.id).toBe(before?.id);
      expect(after[0]?.severity).toBe("block");
      expect(p2.result.cleared).not.toContain(before?.id);
      expect(p2.result.verdict).toBe("revise");
      // the finding still shows the author's own text, not the normalised key
      expect(t2.slice(after[0]?.span.start, after[0]?.span.end)).toBe(after[0]?.span.text);
    });
  }

  const REWORDED: Array<[string, string, string]> = [
    ["'It is' becomes 'It's also'", `It is worth noting that the cache is per tenant. ${body}`, `It's also worth noting that the cache is per tenant. ${body}`],
    ["'that' dropped", `It's worth noting that the cache is per tenant. ${body}`, `It's worth noting: the cache is per tenant. ${body}`],
    ["a comma instead of 'that'", `It's worth noting that the cache is per tenant. ${body}`, `It's worth noting, the cache is per tenant. ${body}`],
    ["'Great' becomes 'Good question'", `Great question! The cache is per tenant. ${body}`, `Good question! The cache is per tenant. ${body}`],
    ["'Note that' becomes 'Please note that'", `Note that the cache is per tenant. ${body}`, `Please note that the cache is per tenant. ${body}`],
    ["'Hope this helps' becomes 'I hope this helps'", `${body} The cache is per tenant.\n\nHope this helps!`, `${body} The cache is per tenant.\n\nI hope this helps!`],
  ];

  for (const [name, t1, t2] of REWORDED) {
    it(`a genuine rewording gets a new id (documented, 03): ${name}`, () => {
      const { p1, p2, prior } = twoPasses(t1, t2);
      const oldBlock = p1.result.findings.find((f) => f.severity === "block");
      expect(oldBlock).toBeDefined();
      // the old id is gone, so it is cleared; the reworded tic is a new finding, demoted to info on pass 2
      expect(p2.result.cleared).toContain(oldBlock?.id);
      expect(prior).toContain(oldBlock?.id);
      expect(p2.result.findings).toEqual([]);
      expect(p2.diagnostics.all_findings.some((f) => f.severity === "info" && f.id !== oldBlock?.id)).toBe(true);
      expect(p2.result.verdict).toBe("pass");
    });
  }

  it("span.text of a finding is the original slice, whatever the key", () => {
    const text = "It’s  WORTH\nnoting that the cache is per tenant. The plan is sound enough today.";
    const f = review(text).findings[0];
    expect(f?.span.text).toBe("It’s  WORTH\nnoting that");
  });
});

// ---- 2. label bold ----------------------------------------------------------------------------

describe("label bold is not emphasis (ADR-26)", () => {
  const SUMMARY_LAYOUT = `**Summary** — Moved thumbnail generation into the image worker so large uploads stop timing out at the load balancer.

**Changes**
- Upload handler → enqueues a \`thumbnail\` job and returns 201 → requests no longer hold for 25 seconds.
- Image worker → generates three sizes and patches the record → the gallery shows them when ready.
- Gallery → shows a placeholder and polls every three seconds → no broken images while the job runs.

**Decisions** — Kept the polling at three seconds instead of adding websockets; the gallery already polls for other state.

**Verify** — Upload the 40 MB RAW file from \`fixtures/\` in staging and check the gallery fills in within ten seconds.`;

  const ROOT_CAUSE_LAYOUT = `**Root cause:** the worker reads the queue URL once at startup. Config maps update the mounted file within a minute, but the worker never rereads it.

**Impact:** messages have been piling up in the new queue for an hour. Nothing is lost; the old queue keeps them for 14 days.

**Fix:** restart the worker deployment. I've added a file watcher so the next URL change is picked up without a restart.

**Follow-up:** the same pattern exists in the billing worker. I can fix that too if you want.`;

  for (const [name, doc] of [
    ["Summary / Changes / Decisions / Verify", SUMMARY_LAYOUT],
    ["Root cause / Impact / Fix / Follow-up", ROOT_CAUSE_LAYOUT],
  ] as const) {
    for (const p of ["local/base", "local/chat-reply", "local/pr-description"]) {
      it(`${name} gives no structure.005 finding under ${p}`, () => {
        const r = run(doc, { profile: profile(p) });
        expect(r.diagnostics.candidates.filter((c) => c.rule_id === "core.structure.005")).toEqual([]);
        expect(r.result.findings.filter((f) => f.severity === "block")).toEqual([]);
        expect(r.result.verdict).toBe("pass");
      });
    }
  }

  const bold = (text: string): string[] =>
    run(text, { packs: [packOf(ruleYaml("core.structure.005", "{ kind: document_metric, metric: bold_per_100_words, above: 0, min_sentences: 1 }"))] }).result.findings.map((f) => f.span.text);

  it("what counts: emphasis in running text, a long bold opener, a bold span that does not open the block", () => {
    expect(bold("The plan is **very important** to us today.")).toEqual(["**very important**"]);
    expect(bold("**Five words in this one** and the rest of the sentence.")).toEqual(["**Five words in this one**"]);
    expect(bold("First sentence is plain. **Second** sentence starts with bold.")).toEqual(["**Second**"]);
    expect(bold("- the item has **bold** inside it\n- another plain item here")).toEqual(["**bold**"]);
  });

  it("what does not: a bold label of up to four words at the start of a paragraph or list item", () => {
    expect(bold("**Four words in label** then the sentence follows here.")).toEqual([]);
    expect(bold("**Root cause:** the worker reads the URL once.")).toEqual([]);
    expect(bold("- **Label** the item text follows here\n- **Another label:** more text follows here")).toEqual([]);
    expect(bold("1. **First step** do the thing.\n2. **Second step** do the next thing.")).toEqual([]);
    expect(bold("Plain intro paragraph here.\n\n**Heading-like**\n\nBody text follows.")).toEqual([]);
  });

  it("the density counts emphasis only: labels do not dilute or inflate it", () => {
    const text = `**Label:** one **two** three ${"word ".repeat(40)}.`;
    expect(bold(text)).toEqual(["**two**"]);
  });

  it("08's hit example (seven bolded phrases in running text) still fires", () => {
    const doc = "The nightly job is **critical** and the **only** one that **cannot** be retried, so **check** the **logs** before **anything** else, and **never** skip it. We run it at two in the morning, after the backups, and it finishes in about ten minutes on a normal night.";
    // 7 emphasis spans in 52 words: 13.5 per 100 words, over a threshold of 10 (a label would not have counted)
    const dense = run(doc, { packs: [packOf(ruleYaml("core.structure.005", "{ kind: document_metric, metric: bold_per_100_words, above: 10, min_sentences: 1 }"))] });
    expect(dense.result.findings).toHaveLength(1);
  });
});

// ---- 3. filler.003 ----------------------------------------------------------------------------

describe("core.filler.003: 'in this response' and 'the following is' only open a sentence (ADR-26)", () => {
  const pad = " The proxy adds the header on the way out, and the client library reads it before it parses the body, so a missing header changes how the body is decoded.";
  const f3 = (s: string): string[] => only(s + pad, "core.filler.003");

  it.each([
    "The `Content-Type` header in this response is `text/html`, not JSON, which is why the parser fails.",
    "Look at the status line in this response: it is a 302 to the login page.",
    "Check whether the following is set in your config: `cache: true`.",
    "If the following is true for every row, the migration is safe.",
    "As an aside, the retry count is 3.",
    "The underscores in the file name break the glob.",
  ])("literal use does not fire: %s", (s) => {
    expect(f3(s)).toEqual([]);
  });

  it.each([
    ["In this response, I will cover three options.", "In this response"],
    ["The following is a summary of the options.", "The following is"],
    ["The following is the output of `kubectl get pods` on the broken node.", "The following is"],
    ["Fine. In this response I explain the fix.", "In this response"],
    ["This document outlines the plan.", "This document outlines"],
    ["As an AI, I cannot see your repository.", "As an AI"],
  ])("meta-commentary fires: %s", (s, span) => {
    expect(f3(s)).toEqual([span]);
  });
});

// ---- 4. the ADR-26 phrase lists, one by one ---------------------------------------------------

describe("ADR-26 wider lists: every phrase fires where it should and not where it should not", () => {
  const body = " The cache is per tenant and the index is unique, so each lookup touches one shard and one replica only.";
  it.each([
    ["Excellent question!", "core.filler.001"],
    ["Really good question!", "core.filler.001"],
    ["Good catch!", "core.filler.001"],
    ["You're absolutely right.", "core.filler.001"],
    ["Of course!", "core.filler.001"],
    ["Sure!", "core.filler.001"],
    ["Happy to help!", "core.filler.001"],
    ["In short, it works.", "core.filler.004"],
    ["To sum up, it works.", "core.filler.004"],
    ["In a nutshell, it works.", "core.filler.004"],
    ["Simply put, it works.", "core.filler.004"],
    ["The bottom line is that it works.", "core.filler.004"],
    ["Keep in mind that it works.", "core.hedge.001"],
    ["It's important to remember that it works.", "core.hedge.001"],
    ["Notably, it works.", "core.hedge.003"],
    ["Interestingly, it works.", "core.hedge.003"],
    ["This can potentially work.", "core.hedge.004"],
    ["This tooling empowers every team.", "core.vocab.001"],
    ["It is a blazing-fast tool.", "core.vocab.003"],
    ["There is no silver bullet here.", "core.vocab.002"],
    ["This not only reduces latency but also lowers load.", "core.triad.002"],
  ])("fires: %s -> %s", (sentence, rule) => {
    expect(only(sentence + body, rule).length).toBeGreaterThan(0);
  });

  it.each([
    ["Of course the cache is per tenant.", "core.filler.001"],
    ["Sure enough, the cache is per tenant.", "core.filler.001"],
    ["The fix, simply put, is safe.", "core.filler.004"],
    ["The retry is notably absent from the second path.", "core.hedge.003"],
    ["Try to keep in mind that fact.", "core.hedge.001"],
    ["It is not only fast but slow to start.", "core.triad.002"],
  ])("does not fire: %s -> %s", (sentence, rule) => {
    expect(only(sentence + body, rule)).toEqual([]);
  });

  it("the closing phrases fire in the last two sentences only", () => {
    for (const closing of ["Hope that helps!", "I hope that helps.", "Hopefully this helps.", "Feel free to ask."]) {
      expect(only(`${body.trim()} It is done. ${closing}`, "core.filler.002").length, closing).toBe(1);
      expect(only(`${closing} ${body.trim()} It is done. It is done again. Last line here.`, "core.filler.002"), closing).toEqual([]);
    }
  });

  it("the new phrases are the mid-sentence 'in short' of a long document: filler.004 is for short documents only", () => {
    expect(only(`In short, it works.${" Word word word word word word word word word word.".repeat(45)}`, "core.filler.004")).toEqual([]);
  });
});

// ---- 6. space rewriting leaves \Q..\E and POSIX classes alone ---------------------------------

describe("whitespaceRuns (nit #7)", () => {
  it("turns a literal space into a whitespace run", () => {
    expect(whitespaceRuns("worth noting")).toBe("worth\\s+noting");
    expect(whitespaceRuns("a (?:b )?c")).toBe("a\\s+(?:b\\s+)?c");
  });

  it("leaves spaces that are quantified, escaped, in a class, in \\Q..\\E or in a POSIX class", () => {
    expect(whitespaceRuns("a ?b")).toBe("a ?b");
    expect(whitespaceRuns("a\\ b")).toBe("a\\ b");
    expect(whitespaceRuns("[a ]b")).toBe("[a ]b");
    expect(whitespaceRuns("\\Qa b\\E c")).toBe("\\Qa b\\E\\s+c");
    expect(whitespaceRuns("\\Qa b")).toBe("\\Qa b");
    expect(whitespaceRuns("[[:alpha:] ]x y")).toBe("[[:alpha:] ]x\\s+y");
    expect(whitespaceRuns("[^[:digit:] ]x")).toBe("[^[:digit:] ]x");
  });

  it("behaves: a \\Q..\\E literal keeps its single space, a POSIX class keeps its space", () => {
    const q = packOf(ruleYaml("core.vocab.001", "{ kind: regex, pattern: 'x\\Qa b\\Ey' }"));
    expect(hits("Say xa by now.", { packs: [q] })).toEqual([["core.vocab.001", "xa by"]]);
    expect(hits("Say xa  by now.", { packs: [q] })).toEqual([]);
    const p = packOf(ruleYaml("core.vocab.001", "{ kind: regex, pattern: '(?P<span>[[:alpha:] ]+)zz' }"));
    expect(hits("Say ab cdzz now.", { packs: [p] }).length).toBeGreaterThan(0);
  });
});
