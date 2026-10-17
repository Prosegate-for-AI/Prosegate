import { describe, expect, it } from "vitest";
import { analyse } from "../src/index.js";

const quotesOf = (t: string): string[] => {
  const a = analyse(t);
  return a.segments.filter((s) => s.kind === "quote" && !t.slice(s.start, s.end).trimStart().startsWith(">")).map((s) => t.slice(s.start, s.end).trim());
};

describe("1-2 word quotes directly after a user cue", () => {
  const yes: Array<[string, string[]]> = [
    ['You asked me to "leverage" the cache.', ['"leverage"']],
    ['You asked for "seamless integration".', ['"seamless integration"']],
    ['You said "ship it".', ['"ship it"']],
    ['You wrote "done".', ['"done"']],
    ['You mentioned "staging" twice.', ['"staging"']],
    ['You requested "dark mode" last week.', ['"dark mode"']],
    ['You want "less noise" in the output.', ['"less noise"']],
    ['You wanted "fewer steps" originally.', ['"fewer steps"']],
    ["You've asked for “more detail” before.", ["“more detail”"]],
    ["You’ve asked for \"more detail\" before.", ['"more detail"']],
    ['You have asked for "more detail" before.', ['"more detail"']],
    ['You told me "keep it short" today.', ['"keep it short"']],
    ['You noted "flaky" in the ticket.', ['"flaky"']],
    ['When you say "fast" I assume under a second.', ['"fast"']],
    ['when you say "fast" I assume under a second.', ['"fast"']],
    ['The user asked "why" twice.', ['"why"']],
    ['You said that "leverage" is banned.', ['"leverage"']], // one filler word
    ['You said it was "robust".', ['"robust"']], // two filler words
    ['You said that it was "robust".', ['"robust"']], // three filler words
  ];
  for (const [input, expected] of yes) {
    it(`${JSON.stringify(input)}`, () => {
      expect(quotesOf(input)).toEqual(expected);
    });
  }

  const no: string[] = [
    'The "robust" layer wraps every call.',
    'Our "battle tested" logic is a "so called" feature.',
    'He said "ship it" yesterday.',
    'She asked for "seamless integration".',
    'They want "less noise".',
    'It says "done".',
    'You said that it was really "robust".', // four filler words before a 1-word quote
    'You said so. The "robust" layer wraps every call.', // cue in an earlier sentence
    'You said "foo" but the real answer is "bar".', // the second quote is not directly after a cue
    'I said "ship it" yesterday.',
    'We want "less noise".',
  ];
  for (const input of no) {
    it(`leaves ${JSON.stringify(input)} as prose`, () => {
      const q = quotesOf(input);
      if (input.startsWith('You said "foo"')) expect(q).toEqual(['"foo"']);
      else expect(q).toEqual([]);
    });
  }

  it("a 1-2 word quote after a named-source cue is NOT attributed (only user cues count for short quotes)", () => {
    expect(quotesOf('The docs say "done".')).toEqual([]);
    expect(quotesOf('According to Nielsen, "scan first".')).toEqual([]);
  });
});

describe("3+ word quotes: filler words", () => {
  it("allow up to 6 filler words after a user cue", () => {
    expect(quotesOf('You said in your last message "keep the defaults as they are".')).toEqual(['"keep the defaults as they are"']);
    expect(quotesOf('You said one two three four five six "keep the defaults now".')).toEqual(['"keep the defaults now"']);
    expect(quotesOf('You said one two three four five six seven "keep the defaults now".')).toEqual([]);
  });
  it("allow at most 3 after a named source", () => {
    expect(quotesOf('The docs say one two three "keep the defaults now".')).toEqual(['"keep the defaults now"']);
    expect(quotesOf('The docs say one two three four "keep the defaults now".')).toEqual([]);
  });
  it("sentence-ending punctuation between cue and quote blocks attribution", () => {
    expect(quotesOf('You said this. "keep the defaults now" is mine.')).toEqual([]);
  });
});

describe("more cues", () => {
  const yes: Array<[string, string]> = [
    ['The error message says "cannot find module foo".', '"cannot find module foo"'],
    ['The error message says: "cannot find module foo".', '"cannot find module foo"'],
    ['The documentation says "tokens expire after one hour".', '"tokens expire after one hour"'],
    ['The docs state "tokens expire after one hour".', '"tokens expire after one hour"'],
    ["Okafor's docs say \"tokens expire after one hour\".", '"tokens expire after one hour"'],
    ["Okafor’s documentation says \"tokens expire after one hour\".", '"tokens expire after one hour"'],
    ['Your message says "please ship this today".', '"please ship this today"'],
    ['Your request says "please ship this today".', '"please ship this today"'],
    ['In your words: "keep it simple and small".', '"keep it simple and small"'],
    ['Your request: "keep it simple and small".', '"keep it simple and small"'],
    ['Quoting you: "keep it simple and small".', '"keep it simple and small"'],
    ['You said **"fix it right now please"** earlier.', '"fix it right now please"'],
    ['You said *"fix it right now please"* earlier.', '"fix it right now please"'],
    ['You said _"fix it right now please"_ earlier.', '"fix it right now please"'],
    ['(you said "do it now please") and then left.', '"do it now please"'],
    ['You said ("do it now please") earlier.', '"do it now please"'],
    ['**You said "fix it right now"** and left.', '"fix it right now"'],
  ];
  for (const [input, expected] of yes) {
    it(`${JSON.stringify(input)}`, () => {
      expect(quotesOf(input)).toEqual([expected]);
    });
  }

  it("pronoun subjects stay non-attributing", () => {
    for (const s of ["He", "She", "It", "They", "We", "This", "That", "There", "Someone"]) {
      expect(quotesOf(`${s} says "this is a longer quote here".`), s).toEqual([]);
      expect(quotesOf(`${s} wrote "this is a longer quote here".`), s).toEqual([]);
    }
  });
});

describe("a cue line ending in a colon followed by a quote-only paragraph or list item", () => {
  it("a paragraph that is entirely a quote", () => {
    const t = 'You asked:\n\n"fix the bug now"\n\nOk then.';
    expect(quotesOf(t)).toEqual(['"fix the bug now"']);
  });
  it("a one-word quote counts too", () => {
    expect(quotesOf('You asked:\n\n"why"\n\nOk.')).toEqual(['"why"']);
  });
  it("trailing punctuation after the closing quote is allowed", () => {
    expect(quotesOf('The docs say:\n\n"tokens expire soon".\n\nOk.')).toEqual(['"tokens expire soon"']);
  });
  it("every list item that is entirely a quote, until one is not", () => {
    const t = 'Your request:\n\n- "add retry logic"\n- "bump the deps"\n- plain item here\n- "not covered by the cue"';
    expect(quotesOf(t)).toEqual(['"add retry logic"', '"bump the deps"']);
  });
  it("a numbered list directly under the cue line", () => {
    const t = 'You asked for:\n1. "retry logic"\n2. "better logs"\n';
    expect(quotesOf(t)).toEqual(['"retry logic"', '"better logs"']);
  });
  it("a paragraph that only starts with a quote is not whole-element", () => {
    expect(quotesOf('You asked:\n\n"fix the bug" and then more words follow.')).toEqual([]);
  });
  it("the cue line must end with a colon and contain a cue", () => {
    expect(quotesOf('You asked.\n\n"fix the bug now"\n\nOk.')).toEqual([]);
    expect(quotesOf('Here is the text:\n\n"fix the bug now"\n\nOk.')).toEqual([]);
    expect(quotesOf('He said:\n\n"fix the bug now"\n\nOk.')).toEqual([]);
  });
  it("only the very next element is covered; code between cancels the cue", () => {
    expect(quotesOf('You asked:\n\nSome other paragraph.\n\n"fix the bug now"')).toEqual([]);
    expect(quotesOf('You asked:\n\n```\ncode\n```\n\n"fix the bug now"')).toEqual([]);
  });
  it("a heading is not a cue line and a quote under it is not covered", () => {
    expect(quotesOf('# You asked:\n\n"fix the bug now"')).toEqual([]);
  });
  it("a cue line in a list item covers the next paragraph", () => {
    expect(quotesOf('- You wrote:\n\n"keep it small"\n')).toEqual(['"keep it small"']);
  });
});

describe("quote shape", () => {
  it("quote segments include both marks and the units around them are flagged", () => {
    const t = 'You asked me to "leverage" the cache.';
    const a = analyse(t);
    expect(a.segments.map((s) => `${s.kind}:${t.slice(s.start, s.end)}`)).toEqual(["prose:You asked me to ", 'quote:"leverage"', "prose: the cache."]);
    expect(a.units.map((u) => [t.slice(u.start, u.end), u.continuation, u.continued])).toEqual([
      ["You asked me to", false, true],
      ["the cache.", true, false],
    ]);
  });
  it("curly quotes with a short user cue", () => {
    expect(quotesOf("You asked for “seamless integration” today.")).toEqual(["“seamless integration”"]);
  });
  it("the quote's inline code is not a mask outside it", () => {
    const t = 'You said "run `npm test` now" and `ok`.';
    expect(analyse(t).masks.map((m) => t.slice(m.start, m.end))).toEqual(["`ok`"]);
  });
});
