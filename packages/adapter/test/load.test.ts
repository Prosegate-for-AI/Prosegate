import { beforeAll, describe, expect, it, vi } from "vitest";
import { doc2000 } from "./fixture.js";
import { SESSION, buildBundle, json, pg, pgAsync, sessionStartInput, tmpDir, turnEndInput } from "./helpers.js";

// ADR-29: the engine's budget in production is the time left under the 6 s cap, at most 2 s; the 200 ms
// of 10 is a publish-time gate. With 200 ms as the runtime budget, 6 of 8 concurrent turn-ends on a
// normally loaded laptop were skipped silently. These tests run the RELEASE bundle with production
// defaults: no lever, no override.

vi.setConfig({ testTimeout: 180_000 });

let bundle = "";
beforeAll(async () => {
  bundle = await buildBundle();
}, 120_000);

interface Out {
  decision: string;
  result: { verdict: string; skipped_reason?: string; findings: unknown[] };
}

describe("a loaded machine does not turn enforcement off", () => {
  it("8 concurrent turn-ends on a 2,000-word reply are all reviewed", async () => {
    const home = tmpDir();
    pg(bundle, ["session-start"], { home, input: sessionStartInput() });
    const text = doc2000();
    const runs = await Promise.all(
      Array.from({ length: 8 }, (_, i) => pgAsync(bundle, ["turn-end"], { home, input: turnEndInput(text, { turn_id: `load-${i}` }) })),
    );
    for (const r of runs) {
      expect(r.code, r.stderr).toBe(0);
      const out = json<Out>(r);
      expect(out.result.skipped_reason).toBeUndefined();
      expect(out.result.findings.length).toBeGreaterThan(0);
    }
  });

  it("an 8 KB slop-dense reply in a cold process gets `continue`", () => {
    const home = tmpDir();
    pg(bundle, ["session-start"], { home, input: sessionStartInput() });
    const sentence =
      "I think this might possibly be a really robust solution, basically. It is worth noting that we leverage a seamless, robust, and holistic approach to delve into the tapestry of the problem. Moreover, it is important to note that this is a game-changer. ";
    let text = "";
    while (text.length < 8 * 1024) text += sentence;
    const r = pg(bundle, ["turn-end"], { home, input: turnEndInput(text.slice(0, 8 * 1024)) });
    expect(r.code).toBe(0);
    const out = json<Out>(r);
    expect(out.decision).toBe("continue");
    expect(out.result.verdict).toBe("revise");
  });

  it("slop-dense replies of every size up to 250 KB are reviewed and continued, not skipped", () => {
    const home = tmpDir();
    pg(bundle, ["session-start"], { home, input: sessionStartInput() });
    const sentence = "It is worth noting that this robust and seamless approach could potentially help. ";
    for (const kb of [16, 64, 128, 250]) {
      let text = "";
      while (text.length < kb * 1024) text += sentence;
      const r = pg(bundle, ["turn-end"], { home, input: turnEndInput(text.slice(0, kb * 1024), { turn_id: `kb-${kb}` }) });
      expect(r.code, `${kb} KB`).toBe(0);
      const out = json<Out>(r);
      expect(out.decision, `${kb} KB`).toBe("continue");
      expect(out.result.skipped_reason, `${kb} KB`).toBeUndefined();
    }
    expect(SESSION).toBeTruthy();
  });
});
