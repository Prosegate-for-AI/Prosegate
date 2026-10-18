import { describe, expect, it } from "vitest";
import { analyse } from "@prosegate/segmenter";
import { DocContext } from "../src/context.js";
import { documentMetricValue } from "../src/metrics.js";
import type { DocumentMetricMatch } from "../src/compile.js";
import { CORE_COMPILED, hits, profile, run } from "./helpers.js";

// Regression tests from the adversarial review of the first engine (ADR-24).

const PRS = [
  `## Summary
- Move invoice PDF rendering from the request handler into a background job
- Add \`GET /jobs/:id\` so the web app can poll for the finished PDF
- Keep the synchronous endpoint behind the \`sync_pdf\` flag for one release
- Upload rendered PDFs to the invoices bucket with a signed URL that expires in an hour

## Test plan
- [ ] Unit tests for the job handler pass in CI
- [ ] Render the 1,400-line staging invoice and confirm it finishes without a gateway timeout
- [ ] Poll the job endpoint from the web app and confirm the spinner clears when the PDF is ready

🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
  `## Summary
- Fix the race in session refresh by checking token expiry inside the per-session lock
- Add a test that fires 50 concurrent refreshes against a fake identity provider
- Remove the unused \`refresh_hint\` field from the session model

## Test plan
- [x] New concurrency test passes 500 consecutive runs locally
- [x] Existing auth test suite passes
- [ ] Watch the 401 rate on the refresh endpoint for a day after deploy`,
];

describe("Claude Code's default PR body (adversarial M1)", () => {
  for (const [i, body] of PRS.entries()) {
    it(`body ${i + 1} gives zero block findings under pr-description`, () => {
      const r = run(body, { profile: profile("local/pr-description"), keepFloor: true });
      expect(r.result.findings.filter((f) => f.severity === "block")).toEqual([]);
      expect(r.result.verdict).not.toBe("revise");
    });
    it(`body ${i + 1}: the template headings and checklist are info there, warn under base`, () => {
      const pr = run(body, { profile: profile("local/pr-description") }).diagnostics.all_findings;
      for (const id of ["core.structure.001", "core.structure.002"]) {
        for (const f of pr.filter((x) => x.rule_id === id)) expect(f.severity).toBe("info");
      }
    });
  }
});

// Short answers: cause first, details, then a closing next step that names the same objects (08's miss case).
const ANSWERS = [
  `The worker reads the queue URL once, at startup.

You changed the URL in the config map an hour ago. Config maps are mounted as files, and the files update within a minute. The worker never rereads them, so it is still polling the old queue. Messages are piling up in the new queue meanwhile.

Restart the worker to reload the queue URL.`,
  `The import fails on rows with an empty date field.

The parser treats an empty string as a date and throws. About 40 rows in the March export have no date. The rest of the file is fine. The error message does not name the row, which is why it was hard to find.

Treat an empty date field as null in the import parser.`,
  `The login page is slow because the session check calls the user service.

The user service is in another region. Each call adds about 300 ms. The page makes the call twice, once for the header and once for the body. Both calls ask for the same thing.

Cache the session check result for the login page request so the user service is called once.`,
  `The nightly backup job fails because the backup bucket is full.

The bucket has a 5 TB quota. Old backups were supposed to expire after 30 days. The lifecycle rule was deleted in the Terraform refactor last month. Nothing has expired since.

Restore the lifecycle rule on the backup bucket so old backups expire and the nightly job has room.`,
  `Your test is flaky because the mock clock and the real clock disagree.

The handler reads the time from the mock clock. The retry library reads it from the real clock. When the test runs slowly, the two drift apart. The retry then fires before the mock clock has advanced.

Pass the mock clock to the retry library too, so the test uses one clock.`,
];

const closingRule: DocumentMetricMatch = { kind: "document_metric", metric: "closing_similarity", above: 0.6, below: null, minSentences: 6, minItemWords: 0 };
const closingValue = (text: string): number | null => documentMetricValue(closingRule, new DocContext(analyse(text)));
const blocksOf = (text: string, profileId = "local/base"): string[] =>
  run(text, { profile: profile(profileId) })
    .result.findings.filter((f) => f.severity === "block")
    .map((f) => f.rule_id ?? "");

describe("core.structure.004 needs at least three non-heading blocks (adversarial M3, ADR-24)", () => {
  for (const [i, text] of ANSWERS.entries()) {
    it(`answer ${i + 1} has no closing_similarity once it is cut to two blocks`, () => {
      const two = text.slice(0, text.indexOf("\n\n", text.indexOf("\n\n") + 2));
      expect(closingValue(two)).toBeNull();
      expect(blocksOf(two)).toEqual([]);
    });
  }

  it("none of the five three-block answers is blocked (their closing_similarity is 0.60 to 0.67; the threshold is 0.75, ADR-25)", () => {
    for (const a of ANSWERS) {
      expect(blocksOf(a)).toEqual([]);
      expect(closingValue(a) ?? 0).toBeLessThan(0.75);
    }
    expect(Math.max(...ANSWERS.map((a) => closingValue(a) ?? 0))).toBeGreaterThan(0.6);
  });

  it("the compiled threshold is 0.75, and the rule is still a block", () => {
    const rule = CORE_COMPILED.rules.find((r) => r.id === "core.structure.004");
    expect(rule?.match).toMatchObject({ kind: "document_metric", metric: "closing_similarity", above: 0.75 });
    expect(rule?.severity).toBe("block");
  });

  it("boundary: a constructed closing at cosine 0.74 does not fire, 0.76 does (opening and closing of 50 content words, 37 / 38 shared)", () => {
    const tok = (i: number): string => `tok${i}x`;
    const para = (ids: number[]): string => `${ids.map(tok).join(" ")}.`;
    const opening = Array.from({ length: 50 }, (_, i) => i);
    const closing = (shared: number): number[] => [...Array.from({ length: shared }, (_, i) => i), ...Array.from({ length: 50 - shared }, (_, i) => 100 + i)];
    const middle = "Bananas sail on ships. Oranges grow here. Rivers run to the sea. Mountains stand still. Clouds drift by.";
    const doc = (shared: number): string => `${para(opening)}\n\n${middle}\n\n${para(closing(shared))}`;
    expect(closingValue(doc(37))).toBeCloseTo(0.74, 10);
    expect(closingValue(doc(38))).toBeCloseTo(0.76, 10);
    expect(hits(doc(37)).filter(([id]) => id === "core.structure.004")).toEqual([]);
    expect(hits(doc(38)).filter(([id]) => id === "core.structure.004")).toHaveLength(1);
  });

  it("08's hit example (three blocks, closing restates the opening) still fires", () => {
    const hit = `The deploy pipeline is slow because the tests are slow and the cache never hits.

We looked at the build graph, the runners, and the artifact store. Nothing else is slow. The linter takes four seconds. The type check takes nine. The image build is cached.

So the deploy pipeline is slow because the tests are slow and the cache never hits, which is the whole problem.`;
    expect(analyse(hit).paragraphs).toHaveLength(3);
    expect(hits(hit).filter(([id]) => id === "core.structure.004")).toHaveLength(1);
  });
});

