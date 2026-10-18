import { describe, expect, it } from "vitest";
import { profile, run } from "./helpers.js";
import { CLEAN } from "./fixtures/realistic/clean-corpus.js";
import { CLEAN2 } from "./fixtures/realistic/clean-corpus2.js";
import { CLEAN4 } from "./fixtures/realistic/clean-corpus4.js";
import { NEW_CHAT_CODE } from "./fixtures/realistic/new-chat-code.js";
import { NEW_EXTRA } from "./fixtures/realistic/new-extra.js";
import { NEW_INC_EMAIL } from "./fixtures/realistic/new-inc-email.js";
import { NEW_PR_DESIGN } from "./fixtures/realistic/new-pr-design.js";
import { TICS2 } from "./fixtures/realistic/tics2.js";

// ADR-26: the second realistic sample, from the W2.2 re-verification: 71 fresh clean replies and 20 fresh
// tic-dense replies. Floors are bypassed so every document runs.

const PROFILES = ["local/base", "local/pr-description", "local/design-doc", "local/email", "local/chat-reply"] as const;
const NATURAL = [...CLEAN, ...CLEAN2, ...CLEAN4];
const FRESH = [...NEW_CHAT_CODE, ...NEW_EXTRA, ...NEW_INC_EMAIL, ...NEW_PR_DESIGN];

describe("fresh clean replies (false positives, second sample)", () => {
  it("has 71 documents", () => {
    expect(FRESH.length).toBe(71);
  });

  it("zero block findings under base, pr-description, design-doc and chat-reply", () => {
    for (const p of ["local/base", "local/pr-description", "local/design-doc", "local/chat-reply"]) {
      const resolved = profile(p);
      const blocks = FRESH.flatMap((d) =>
        run(d.text, { profile: resolved })
          .result.findings.filter((f) => f.severity === "block")
          .map((f) => `${p} ${d.id} ${f.rule_id}`),
      );
      expect(blocks, p).toEqual([]);
    }
  });

  it("under email the only blocks are core.structure.001 on replies with headings (08 raises it to block for that profile)", () => {
    const resolved = profile("local/email");
    const blocks = FRESH.flatMap((d) =>
      run(d.text, { profile: resolved })
        .result.findings.filter((f) => f.severity === "block")
        .map((f) => [d.id, f.rule_id ?? ""] as [string, string]),
    );
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every(([, rule]) => rule === "core.structure.001")).toBe(true);
  });

  it("none of the ADR-26 phrases fires on either clean sample", () => {
    const NEW_PHRASES =
      /excellent question|really good question|good catch|absolutely right|of course!|sure!|happy to help|hope that helps|hopefully this helps|feel free to ask|in short|to sum up|in a nutshell|simply put|bottom line is|keep in mind that|important to remember|notably,|interestingly,|can potentially|empowers|blazing-fast|silver bullet|but also|in this response|the following is/i;
    const fired: string[] = [];
    for (const d of [...NATURAL, ...FRESH]) {
      for (const c of run(d.text).diagnostics.candidates) {
        const s = d.text.slice(c.start, c.end);
        if (NEW_PHRASES.test(s)) fired.push(`${d.id} ${c.rule_id} ${s}`);
      }
    }
    expect(fired).toEqual([]);
  });

  it("prints findings per rule per profile", () => {
    const rules = new Map<string, Map<string, number>>();
    const blocks = new Map<string, number>();
    for (const p of PROFILES) {
      const resolved = profile(p);
      for (const d of FRESH) {
        for (const f of run(d.text, { profile: resolved }).result.findings) {
          const row = rules.get(f.rule_id ?? "") ?? new Map<string, number>();
          row.set(p, (row.get(p) ?? 0) + 1);
          rules.set(f.rule_id ?? "", row);
          if (f.severity === "block") blocks.set(p, (blocks.get(p) ?? 0) + 1);
        }
      }
    }
    const head = `rule${" ".repeat(20)}${PROFILES.map((p) => p.slice(6).padEnd(16)).join("")}`;
    const lines = [...rules.keys()].sort().map((r) => `${r.padEnd(24)}${PROFILES.map((p) => String(rules.get(r)?.get(p) ?? 0).padEnd(16)).join("")}`);
    console.log(`\nfindings (block + warn) over ${FRESH.length} fresh clean replies\n${head}\n${lines.join("\n")}\nblock findings: ${PROFILES.map((p) => `${p.slice(6)}=${blocks.get(p) ?? 0}`).join(" ")}\n`);
    expect(blocks.get("local/base") ?? 0).toBe(0);
  });
});

describe("fresh tic-dense replies (recall by category, second sample)", () => {
  // The honest numbers after ADR-26's lists (no phrase beyond them was added to chase the target).
  const EXPECTED: Record<string, [number, number]> = { filler: [24, 45], vocab: [34, 37], triad: [7, 8], hedge: [24, 27], structure: [1, 3], repetition: [2, 3] };

  it("has 20 documents, and recall by category is recorded", () => {
    expect(TICS2.length).toBe(20);
    const per: Record<string, [number, number]> = {};
    for (const t of TICS2) {
      const fs = run(t.text, { profile: profile(t.profile ?? "local/base") }).diagnostics.all_findings;
      for (const [w, cat] of t.want) {
        const c = (per[cat] ??= [0, 0]);
        c[1]++;
        const i = t.text.indexOf(w);
        const hit = i < 0 ? undefined : fs.find((f) => f.span.start < i + w.length && i < f.span.end && (cat === "structure" || cat === "repetition" ? true : f.scope !== "document"));
        if (hit) c[0]++;
      }
    }
    const total = Object.values(per).reduce((a, [g]) => a + g, 0);
    const all = Object.values(per).reduce((a, [, n]) => a + n, 0);
    console.log(
      `\nfresh tic recall by category\n${Object.entries(per)
        .map(([k, [g, n]]) => `  ${k.padEnd(11)} ${g}/${n} = ${((g / n) * 100).toFixed(0)}%`)
        .join("\n")}\n  total       ${total}/${all} = ${((total / all) * 100).toFixed(0)}%\n`,
    );
    expect(per).toEqual(EXPECTED);
    expect(total / all).toBeGreaterThanOrEqual(0.7);
  });
});
