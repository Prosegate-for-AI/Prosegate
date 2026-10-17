import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type Analysis, analyse } from "../src/index.js";

const fx = (n: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", `${n}.md`), "utf8");
const slice = (t: string, s: { start: number; end: number }): string => t.slice(s.start, s.end);
const shape = (a: Analysis): string[] => a.paragraphs.map((p) => `${p.kind[0]}:${p.block_id}`);

/**
 * How the engine will use the contract for closing_similarity: the first non-heading paragraph and
 * the last non-heading block (consecutive-or-not paragraphs sharing a block_id merged).
 */
function firstAndLastBlock(a: Analysis, text: string): [string, string] {
  const paras = a.paragraphs.filter((p) => p.kind !== "heading");
  const first = paras[0];
  const last = paras[paras.length - 1];
  if (first === undefined || last === undefined) return ["", ""];
  const firstBlock = paras.filter((p) => p.block_id === first.block_id);
  const lastBlock = paras.filter((p) => p.block_id === last.block_id);
  const join = (ps: typeof paras): string => ps.map((p) => slice(text, p)).join("\n");
  return [join(firstBlock), join(lastBlock)];
}

describe("Paragraph.kind and Paragraph.block_id", () => {
  it("heading-first design doc: headings, text paragraphs and lists, with ids in order of first appearance", () => {
    const t = fx("design-doc");
    const a = analyse(t);
    expect(shape(a)).toEqual(["h:b1", "h:b2", "t:b3", "h:b4", "l:b5", "h:b6", "t:b7", "h:b8", "t:b9", "h:b10", "l:b11"]);
    const [first, last] = firstAndLastBlock(a, t);
    expect(first).toBe(
      "Every public endpoint currently shares one global limit. A single noisy tenant can therefore starve everyone else, and support has seen three incidents in the last quarter.",
    );
    expect(last).toBe("Should webhooks count against the limit?\n- Do we expose remaining tokens in a header?");
  });

  it("a tight list is one list paragraph", () => {
    const t = "Intro text.\n\n- a one\n- b two\n- c three\n";
    const a = analyse(t);
    expect(shape(a)).toEqual(["t:b1", "l:b2"]);
    expect(a.paragraphs[1]?.unit_indexes).toEqual([1, 2, 3]);
  });

  it("a loose list is one list paragraph per item, all with the same block_id", () => {
    const t = "Intro text.\n\n- a one\n\n- b two\n\n- c three\n";
    const a = analyse(t);
    expect(shape(a)).toEqual(["t:b1", "l:b2", "l:b2", "l:b2"]);
    const [first, last] = firstAndLastBlock(a, t);
    expect(first).toBe("Intro text.");
    expect(last).toBe("a one\nb two\nc three");
  });

  it("a list interrupted by a fenced block or an indented paragraph keeps its block_id", () => {
    const fenced = analyse("1. First step:\n   ```sh\n   npm i\n   ```\n2. Second step.\n");
    expect(shape(fenced)).toEqual(["l:b1", "l:b1"]);
    const para = analyse("- first item\n\n    an indented paragraph of the first item\n\n- second item\n");
    expect(shape(para)).toEqual(["l:b1", "t:b2", "l:b1"]);
  });

  it("two lists separated by a paragraph are two blocks; a list restarted after text is a new block", () => {
    const a = analyse("- a one\n- b two\n\nA paragraph between.\n\n- c three\n- d four\n");
    expect(shape(a)).toEqual(["l:b1", "t:b2", "l:b3"]);
  });

  it("the pieces of one text paragraph that an attributed quote cut share a block_id", () => {
    const a = analyse('You said "keep the migration reversible at all costs" in the kickoff. Then it ended.\n\nNext paragraph.');
    expect(shape(a)).toEqual(["t:b1", "t:b1", "t:b2"]);
  });

  it("a list item cut by a quote stays in its list block", () => {
    const a = analyse('- You said "keep the migration reversible" and left\n- Another item\n');
    expect(shape(a)).toEqual(["l:b1", "l:b1"]);
  });

  it("a heading directly above a list is its own block", () => {
    const a = analyse("## Plan\n- one\n- two\n");
    expect(shape(a)).toEqual(["h:b1", "l:b2"]);
  });

  it("empty and code-only turns have no paragraphs", () => {
    expect(analyse("").paragraphs).toEqual([]);
    expect(analyse("```\nx\n```\n").paragraphs).toEqual([]);
  });
});

describe("Unit.text_start", () => {
  const starts = (t: string): string[] => analyse(t).units.map((u) => t.slice(u.text_start, u.text_start + 6));

  it("skips emphasis markers: **Great question!** Let's dive…", () => {
    const t = "**Great question!** Let's dive into it.";
    const a = analyse(t);
    expect(a.units.map((u) => [slice(t, u), t[u.text_start]])).toEqual([
      ["**Great question!**", "G"],
      ["Let's dive into it.", "L"],
    ]);
    expect(a.units[0]?.text_start).toBe(2);
  });

  it('skips quotes: "Certainly!" she said.', () => {
    const t = '"Certainly!" she said.';
    const a = analyse(t);
    expect(a.units[0]?.text_start).toBe(1);
    expect(t[a.units[0]?.text_start ?? 0]).toBe("C");
  });

  it("skips brackets: (Note that it works.)", () => {
    const t = "(Note that it works.)";
    expect(analyse(t).units[0]?.text_start).toBe(1);
  });

  it("skips ~ _ ' [ and curly quotes", () => {
    expect(starts("~~Gone~~ is fine.")).toEqual(["Gone~~"]);
    expect(starts("_Soft_ start here.")).toEqual(["Soft_ "]);
    expect(starts("'Quoted' start here.")).toEqual(["Quoted"]);
    expect(starts("[Linked](#x) start here.")).toEqual(["Linked"]);
    expect(starts("“Curly” start here.")).toEqual(["Curly”"]);
    expect(starts("‘Single’ start here.")).toEqual(["Single"]);
  });

  it("skips leading emoji and symbols, including astral ones and variation selectors", () => {
    const t = "Done. ✅ Tests pass. ⚠️ One warning. 🚀🚀 Shipped now. → Next up.";
    const a = analyse(t);
    expect(a.units.map((u) => t.slice(u.text_start, u.text_start + 5))).toEqual(["Done.", "Tests", "One w", "Shipp", "Next "]);
  });

  it("is the unit start for plain text, and works for headings and list items", () => {
    const t = "# **Bold** title\n\n- 🎉 item one\n\nPlain.";
    const a = analyse(t);
    expect(a.units.map((u) => t.slice(u.text_start, u.text_start + 4))).toEqual(["Bold", "item", "Plain"].map((s) => s.slice(0, 4)));
    expect(a.units[2]?.text_start).toBe(a.units[2]?.start);
  });

  it("inline code at the start: the first word character may be inside the span", () => {
    const t = "`npm` is required here.";
    expect(analyse(t).units[0]?.text_start).toBe(1);
  });

  it("digits count as word characters", () => {
    const t = "(3) items remain.";
    expect(analyse(t).units[0]?.text_start).toBe(1);
  });

  it("for a continuation unit it is the first word after the quote", () => {
    const t = 'You said "keep the migration reversible" , so I did.';
    const a = analyse(t);
    expect(t.slice(a.units[1]?.text_start ?? 0)).toBe("so I did.");
  });
});

describe("Unit.continuation and Unit.continued", () => {
  it("a sentence cut before and after a quote has the right flags on each piece", () => {
    const t = 'We read "keep the migration reversible" last week and left.';
    const a = analyse(t);
    // A user-less cue is absent, so this is prose: both flags false.
    expect(a.units.map((u) => [u.continuation, u.continued])).toEqual([[false, false]]);

    const t2 = 'You said "keep the migration reversible" and you wrote "keep it small and simple" again.';
    const b = analyse(t2);
    expect(b.units.map((u) => [slice(t2, u), u.continuation, u.continued])).toEqual([
      ["You said", false, true], // cut before the first quote
      ["and you wrote", true, true], // after the first, before the second
      ["again.", true, false], // after the second
    ]);
  });

  it("a piece before a quote at the end of the sentence is continued; the piece after the sentence end is not a continuation", () => {
    const t = 'You said "keep the migration reversible." Then it ended.';
    const a = analyse(t);
    expect(a.units.map((u) => [slice(t, u), u.continuation, u.continued])).toEqual([
      ["You said", false, true],
      ["Then it ended.", false, false],
    ]);
  });

  it("an unattributed sentence has neither flag", () => {
    const a = analyse("Just a sentence. And another one.");
    expect(a.units.every((u) => !u.continuation && !u.continued)).toBe(true);
  });

  it("list items: the item cut by a quote has both pieces flagged", () => {
    const t = '- You said "keep the migration reversible" and left';
    const a = analyse(t);
    expect(a.units.map((u) => [u.kind, slice(t, u), u.continuation, u.continued])).toEqual([
      ["list_item", "You said", false, true],
      ["list_item", "and left", true, false],
    ]);
  });
});

describe("bold spans", () => {
  const boldOf = (t: string): string[] => analyse(t).bold.map((b) => slice(t, b));

  it("a bold span that crosses a quote segment is dropped; bold outside the quote survives", () => {
    const t = '**You said "fix the bug now" and __x__ too**';
    expect(boldOf(t)).toEqual(["__x__"]);
    for (const b of analyse(t).bold) {
      const seg = analyse(t).segments.find((s) => s.start <= b.start && b.end <= s.end);
      expect(seg?.kind).toBe("prose");
    }
  });

  it("only the outermost of nested bold spans is counted", () => {
    expect(boldOf("**a __b__ c**")).toEqual(["**a __b__ c**"]);
    expect(boldOf("__a **b** c__ and **d**")).toEqual(["__a **b** c__", "**d**"]);
    expect(boldOf("**a __b __c__ d__ e**")).toEqual(["**a __b __c__ d__ e**"]);
  });

  it("bold spans are reported in document order", () => {
    const t = "**one** and __two__ and **three**";
    expect(boldOf(t)).toEqual(["**one**", "__two__", "**three**"]);
  });
});
