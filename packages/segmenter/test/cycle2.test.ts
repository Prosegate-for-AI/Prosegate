import { describe, expect, it } from "vitest";
import { analyse } from "../src/index.js";

const slice = (t: string, s: { start: number; end: number }): string => t.slice(s.start, s.end);
const kinds = (t: string): string[] => analyse(t).segments.map((s) => s.kind);
const unitsOf = (t: string): string[] => analyse(t).units.map((u) => `${u.kind[0]}:${slice(t, u)}`);
const quotesOf = (t: string): string[] =>
  analyse(t)
    .segments.filter((s) => s.kind === "quote" && !t.slice(s.start, s.end).trimStart().startsWith(">"))
    .map((s) => t.slice(s.start, s.end).trim());

describe("front matter must look like YAML", () => {
  it("prose between two rules is not front matter", () => {
    const t = "---\nNote: I fixed the bug in the parser.\n\nThe tests pass now.\n\n---\nDone.";
    expect(kinds(t).every((k) => k === "prose")).toBe(true);
    expect(unitsOf(t)).toContain("s:The tests pass now.");
  });
  it("a key line followed by prose is not front matter", () => {
    const t = "---\nNote: I fixed it\nThe tests pass now\n---\nBody.";
    expect(kinds(t).every((k) => k === "prose")).toBe(true);
  });
  it("keys, lists, continuation lines and comments are", () => {
    expect(kinds("---\ntitle: Notes\ntags:\n  - a\n  - b\nlist:\n- x\n# comment\nlong: >\n  folded text\n---\n\nBody.")).toEqual(["code", "prose"]);
    expect(kinds("---\ntitle: Notes\n...\nBody.")).toEqual(["code", "prose"]);
  });
  it("a blank line inside rules it out; so does an empty block", () => {
    expect(kinds("---\ntitle: Notes\n\nauthor: me\n---\nBody.").every((k) => k === "prose")).toBe(true);
    expect(kinds("---\n---\nBody.").every((k) => k === "prose")).toBe(true);
  });
});

describe("model drafts are not swallowed as quotes", () => {
  it("you want / you wanted attribute only when the quote follows directly", () => {
    expect(quotesOf('You want "less noise" in the output.')).toEqual(['"less noise"']);
    expect(quotesOf('You wanted: "fewer steps in the flow".')).toEqual(['"fewer steps in the flow"']);
    expect(quotesOf('If you want to decline politely, you could write: "Great question! I\'d love to delve into this".')).toEqual([]);
    expect(quotesOf('You want a reply that says "thanks for the update, I will look soon" probably.')).toEqual([]);
    expect(quotesOf('You want to say "thanks for the update, I will look soon" probably.')).toEqual([]);
  });
  it("phrases offering a draft cancel the cue", () => {
    for (const lead of [
      'You said it, and here is a reply:',
      'You asked, so for example:',
      'You asked, for instance:',
      'You wrote this, something like:',
      'You said that, you could write:',
      'You said that, you could say:',
      "You said so; here's a draft:",
      'You asked. Suggested reply:',
      'You asked, draft:',
    ]) {
      expect(quotesOf(`${lead} "Overall, this robust approach is great and I hope this helps".`), lead).toEqual([]);
    }
    // the same cue without the draft phrase is a quote
    expect(quotesOf('You said: "Overall, this robust approach is great and I hope this helps".')).toHaveLength(1);
  });
  it("cue lines offering a draft do not carry", () => {
    expect(quotesOf('If you want to decline politely, you could write:\n\n"Great question! I\'d love to delve into this…"')).toEqual([]);
    expect(quotesOf('Here is the summary you wanted:\n\n"Overall, this robust approach is good."')).toEqual([]);
    expect(quotesOf('Here\'s what you asked:\n\n"Overall, this robust approach is good."')).toEqual([]);
    expect(quotesOf('For example, you asked:\n\n"Overall, this robust approach is good."')).toEqual([]);
  });
  it("the carry ends with the first list or paragraph after the cue line", () => {
    const t = 'You asked:\n- "a"\n- "b"\n\n"Both are done, and I hope this helps!"';
    expect(quotesOf(t)).toEqual(['"a"', '"b"']);
    const t2 = 'You asked:\n\n"first request here"\n\n"Second paragraph is the model, I hope this helps!"';
    expect(quotesOf(t2)).toEqual(['"first request here"']);
    const t3 = 'You asked:\n\nSome other paragraph.\n\n"fix the bug now"';
    expect(quotesOf(t3)).toEqual([]);
  });
});

describe("more cue coverage", () => {
  it("cue lines: bold labels, bold or italic quotes, parenthetical commentary, more labels", () => {
    expect(quotesOf('**You asked:**\n\n"fix the bug now"')).toEqual(['"fix the bug now"']);
    expect(quotesOf('You asked:\n\n**"fix the bug now"**')).toEqual(['"fix the bug now"']);
    expect(quotesOf('You asked:\n\n*"fix the bug now"*')).toEqual(['"fix the bug now"']);
    expect(quotesOf('You asked:\n\n"fix the bug now" (from your first message)')).toEqual(['"fix the bug now"']);
    expect(quotesOf('You asked:\n\n"fix the bug now" (from your first message).')).toEqual(['"fix the bug now"']);
    for (const label of ["Your original message:", "From your message:", "Quoting your message:", "Your phrase:", "Your original prompt:", "Quoting you:"]) {
      expect(quotesOf(`${label}\n\n"fix the bug now"`), label).toEqual(['"fix the bug now"']);
    }
  });
  it("new cues", () => {
    const cases: Array<[string, string]> = [
      ['You used the word "leverage" twice.', '"leverage"'],
      ['You called it "the retry thing" earlier.', '"the retry thing"'],
      ['Your phrase "seamless integration" is vague.', '"seamless integration"'],
      ['You described it as "a thin wrapper around fetch".', '"a thin wrapper around fetch"'],
      ['By "robust" you mean fast.', '"robust"'],
      ['By "robust", you mean fast and small.', '"robust"'],
      ["You're asking for \"less noise\" overall.", '"less noise"'],
      ["You’re asking for “less noise” overall.", "“less noise”"],
      ['You are asking for "a smaller bundle" here.', '"a smaller bundle"'],
      ['The issue says "retries are not idempotent in v2".', '"retries are not idempotent in v2"'],
      ['The ticket says: "retries are not idempotent in v2".', '"retries are not idempotent in v2"'],
      ['The user wants "a smaller bundle" here.', '"a smaller bundle"'],
      ['Your original prompt asked for "a smaller bundle" here.', '"a smaller bundle"'],
    ];
    for (const [t, q] of cases) expect(quotesOf(t), t).toEqual([q]);
  });
  it("filler limits stay: 6 after a user cue, 3 after a named source", () => {
    expect(quotesOf('You used the word one two three four five six "keep it small" there.')).toEqual(['"keep it small"']);
    expect(quotesOf('You used the word one two three four five six seven "keep it small" there.')).toEqual([]);
  });
  it("pronoun subjects stay non-attributing with the new cues", () => {
    expect(quotesOf('He called it "the retry thing" earlier.')).toEqual([]);
    expect(quotesOf('They are asking for "a smaller bundle" here.')).toEqual([]);
    expect(quotesOf('She described it as "a thin wrapper around fetch".')).toEqual([]);
  });
});

describe("indented code inside a list", () => {
  it("content indented 4+ beyond the item's content column, after a blank line, is code", () => {
    const t = "1. Run:\n\n        npm i leakword\n\n2. Next";
    expect(kinds(t)).toEqual(["prose", "code", "prose"]);
    expect(unitsOf(t)).toEqual(["l:Run:", "l:Next"]);
  });
  it("bullet items, nested items and tabs", () => {
    expect(kinds("- Run:\n\n      npm i leakword\n\n- Next")).toEqual(["prose", "code", "prose"]);
    expect(kinds("- a\n  - Run:\n\n        npm i leakword\n\n- Next")).toEqual(["prose", "code", "prose"]);
    expect(kinds("- Run:\n\n\t\tnpm i leakword\n- Next")).toEqual(["prose", "code", "prose"]);
  });
  it("less than 4 beyond the content column is a continuation paragraph, not code", () => {
    expect(kinds("1. Run:\n\n      not code, six spaces\n\n2. Next")).toEqual(["prose", "prose", "prose"]);
    expect(kinds("- item\n\n    four spaces is only the item's paragraph\n- Next")).toEqual(["prose", "prose"]);
  });
  it("without a blank line before it, it is a continuation line", () => {
    expect(kinds("1. Run:\n        npm i leakword\n2. Next")).toEqual(["prose"]);
  });
  it("the code block spans blank lines and stops at the first line indented less", () => {
    const t = "- Run:\n\n      a\n\n      b\n  continues the item\n- Next";
    const a = analyse(t);
    expect(a.segments.map((s) => `${s.kind}:${JSON.stringify(slice(t, s).trimEnd())}`)).toEqual([
      'prose:"- Run:"',
      'code:"      a\\n\\n      b"',
      'prose:"  continues the item\\n- Next"',
    ]);
  });
});

describe("HTML comments across paragraphs", () => {
  it("a comment that starts a line and spans a blank line is one non-prose block", () => {
    const t = "Before.\n\n<!-- TODO\n\nremove this. Really. -->\n\nAfter.";
    expect(kinds(t)).toEqual(["prose", "code", "prose"]);
    expect(unitsOf(t)).toEqual(["s:Before.", "s:After."]);
  });
  it("a multi-line comment without a blank line stays a mask inside its paragraph", () => {
    const t = "Before <!-- a\nb --> after.";
    expect(kinds(t)).toEqual(["prose"]);
    expect(analyse(t).masks.map((m) => `${m.kind}:${slice(t, m)}`)).toEqual(["html_comment:<!-- a\nb -->"]);
  });
  it("an unclosed <!-- masks nothing and starts no block", () => {
    const t = "Before.\n\n<!-- never closed\n\nstill prose.";
    expect(kinds(t)).toEqual(["prose", "prose", "prose"]);
    expect(analyse(t).masks).toEqual([]);
  });
  it("the comment block ends on the line holding -->", () => {
    const t = "<!--\nx\n\ny\n--> trailing text\n\nNext paragraph.";
    expect(analyse(t).segments.map((s) => `${s.kind}:${JSON.stringify(slice(t, s).trimEnd())}`)).toEqual([
      'code:"<!--\\nx\\n\\ny\\n--> trailing text"',
      'prose:"Next paragraph."',
    ]);
  });
  it("several comments, a code fence containing <!--, and a comment inside a list", () => {
    expect(kinds("<!-- a\n\nb -->\n\ntext\n\n<!-- c\n\nd -->")).toEqual(["code", "prose", "code"]);
    expect(kinds("```\n<!-- not a comment\n\n-->\n```\n\ntext")).toEqual(["code", "prose"]);
    expect(kinds("- item\n\n  <!-- a\n\n  b -->\n- next")).toEqual(["prose", "code", "prose"]);
  });
});

describe("bold spans never overlap", () => {
  const boldOf = (t: string): string[] => analyse(t).bold.map((b) => slice(t, b));
  it("crossing markers report only the first opened span", () => {
    expect(boldOf("**x __y** z__")).toEqual(["**x __y**"]);
    expect(boldOf("__x **y__ z**")).toEqual(["__x **y__"]);
  });
  it("results are sorted and disjoint for a mixed run", () => {
    const t = "**a** __b__ **c __d** e__ **f __g__ h** __i **j** k__";
    const bs = analyse(t).bold;
    for (let i = 1; i < bs.length; i++) expect((bs[i] as { start: number }).start).toBeGreaterThanOrEqual((bs[i - 1] as { end: number }).end);
    expect(boldOf(t)).toEqual(["**a**", "__b__", "**c __d**", "**f __g__ h**", "__i **j** k__"]);
  });
});

describe("closing block contract", () => {
  const blocks = (t: string): string[] => analyse(t).paragraphs.filter((p) => p.kind !== "heading").map((p) => p.block_id);
  it("a one-paragraph reply: the first non-heading paragraph is the last block", () => {
    const b = blocks("Just one paragraph of text. And another sentence.");
    expect(new Set(b).size).toBe(1);
  });
  it("a heading plus one list: the only non-heading block is one block", () => {
    const b = blocks("## Plan\n\n- one\n\n- two\n\n- three\n");
    expect(b).toHaveLength(3);
    expect(new Set(b).size).toBe(1);
  });
  it("two distinct blocks give a distinct first and last", () => {
    const b = blocks("Intro text here.\n\n- one\n- two\n");
    expect(new Set(b).size).toBe(2);
  });
});
