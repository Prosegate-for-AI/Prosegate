// Second mutation sweep (see boundaries.test.ts): cases that killed the mutants of the second round.

import { describe, expect, it } from "vitest";
import { analyse } from "../src/index.js";

const slice = (t: string, s: { start: number; end: number }): string => t.slice(s.start, s.end);
const quotesOf = (t: string): string[] =>
  analyse(t)
    .segments.filter((s) => s.kind === "quote" && !t.slice(s.start, s.end).trimStart().startsWith(">"))
    .map((s) => t.slice(s.start, s.end).trim());
const unitsOf = (t: string): string[] => analyse(t).units.map((u) => `${u.kind[0]}:${slice(t, u)}`);

describe("second mutation sweep", () => {
  it("a list marker indented exactly 4 columns outside a list is not a list item", () => {
    expect(analyse("Intro.\n\n    - item here").segments.map((s) => s.kind)).toEqual(["prose", "code"]);
    expect(analyse("Intro.\n\n   - item here").segments.map((s) => s.kind)).toEqual(["prose", "prose"]);
  });
  it("an underline indented 4+ columns does not make a setext heading", () => {
    expect(unitsOf("Title\n    ===")).toEqual(["s:Title\n    ==="]);
    expect(unitsOf("Title\n   ===")).toEqual(["h:Title"]);
  });
  it("ordered markers take at most 9 digits", () => {
    expect(unitsOf("123456789. nine digits")).toEqual(["l:nine digits"]);
    expect(unitsOf("1234567890. ten digits")).toEqual(["s:1234567890. ten digits"]);
  });
  it("a sentence that starts with inline code containing a period and space stays whole", () => {
    expect(unitsOf("`a. B` is code. Next one.")).toEqual(["s:`a. B` is code.", "s:Next one."]);
  });
  it("a quote at the very start of the element is opaque to the splitter", () => {
    const t = '"Do this. Then that please" — Ada Lovelace. Next one.';
    const a = analyse(t);
    expect(a.units.map((u) => [slice(t, u), u.continuation])).toEqual([
      ["— Ada Lovelace.", true],
      ["Next one.", false],
    ]);
  });
  it("inline code right after an opening mark may itself contain quote marks", () => {
    const t = 'You said "`say "hi"` and then more words" ok.';
    expect(quotesOf(t)).toEqual(['"`say "hi"` and then more words"']);
  });
});
