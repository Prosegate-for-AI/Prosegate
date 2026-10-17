import { describe, expect, it } from "vitest";
import { analyse } from "../src/index.js";

const slice = (t: string, s: { start: number; end: number }): string => t.slice(s.start, s.end);
const sentences = (t: string): string[] => {
  const a = analyse(t);
  return a.units.filter((u) => u.kind === "sentence").map((u) => slice(t, u));
};
const kinds = (t: string): string[] => analyse(t).segments.map((s) => `${s.kind}:${slice(t, s)}`);
const quotes = (t: string): string[] => {
  const a = analyse(t);
  return a.segments.filter((s) => s.kind === "quote").map((s) => slice(t, s));
};

describe("sentence splitter", () => {
  const table: Array<[string, string, string[]]> = [
    ["plain", "One. Two. Three.", ["One.", "Two.", "Three."]],
    ["question and exclamation", "Really? Yes! Fine.", ["Really?", "Yes!", "Fine."]],
    ["lowercase after a period is not a break", "It is v. good. then more", ["It is v. good. then more"]],
    ["e.g. and i.e.", "Use tools, e.g. Git or Hg, i.e. a VCS. Done.", ["Use tools, e.g. Git or Hg, i.e. a VCS.", "Done."]],
    ["titles", "Mr. Smith met Dr. Jones and Prof. Lee. They talked.", ["Mr. Smith met Dr. Jones and Prof. Lee.", "They talked."]],
    ["Mrs. and Ms.", "Mrs. Brown and Ms. Green left. Bye.", ["Mrs. Brown and Ms. Green left.", "Bye."]],
    ["Inc. and Ltd.", "Acme Inc. Berlin and Globex Ltd. Paris merged. Done.", ["Acme Inc. Berlin and Globex Ltd. Paris merged.", "Done."]],
    ["vs. and cf.", "Compare A vs. B, cf. Chapter 3. Then stop.", ["Compare A vs. B, cf. Chapter 3.", "Then stop."]],
    ["approx.", "It takes approx. 5 minutes. Wait.", ["It takes approx. 5 minutes.", "Wait."]],
    ["No. before a number vs. as an answer", "See No. 7. No. We left.", ["See No. 7.", "No.", "We left."]],
    ["initials", "J. Smith and J. R. R. Tolkien met. Yes.", ["J. Smith and J. R. R. Tolkien met.", "Yes."]],
    ["U.S., a.m., p.m.", "In the U.S. Army at 9 a.m. They left at 5 p.m. Sharp.", ["In the U.S. Army at 9 a.m.", "They left at 5 p.m.", "Sharp."]],
    ["etc. can end a sentence", "Pens, paper, etc. We left.", ["Pens, paper, etc.", "We left."]],
    ["decimals", "It costs 3.14 dollars. Pi is 3.14159.", ["It costs 3.14 dollars.", "Pi is 3.14159."]],
    ["0.5 ms", "Latency is 0.5 ms. Good.", ["Latency is 0.5 ms.", "Good."]],
    ["versions", "Use v1.2.3 or 1.2.x. Node 22.6 works.", ["Use v1.2.3 or 1.2.x.", "Node 22.6 works."]],
    ["file names and paths", "Edit README.md and src/index.ts. Then ./a.b runs.", ["Edit README.md and src/index.ts.", "Then ./a.b runs."]],
    ["URL then sentence", "See https://example.com/a.b. Then go.", ["See https://example.com/a.b.", "Then go."]],
    ["email then sentence", "Write to a.b@example.com. Then wait.", ["Write to a.b@example.com.", "Then wait."]],
    ["ellipsis then lowercase", "Well... maybe not. Fine.", ["Well... maybe not.", "Fine."]],
    ["ellipsis then uppercase breaks", "Well... Maybe not.", ["Well...", "Maybe not."]],
    ["unicode ellipsis", "Hmm… so what. Next.", ["Hmm… so what.", "Next."]],
    ["closing quote stays with sentence", 'He said "stop." Then he left.', ['He said "stop."', "Then he left."]],
    ["closing paren stays with sentence", "It works (mostly.) Then it broke.", ["It works (mostly.)", "Then it broke."]],
    ["closing bracket and curly quote", "See [1.] Then ”this.” Next.", ["See [1.]", "Then ”this.”", "Next."]],
    ["break before an opening quote", 'It ended. "Next" began.', ["It ended.", '"Next" began.']],
    ["break before a bracket", "It ended. (Next began.)", ["It ended.", "(Next began.)"]],
    ["break before a digit", "It ended. 3 more came.", ["It ended.", "3 more came."]],
    ["break at end of text", "Only one.", ["Only one."]],
    ["no terminal punctuation", "no punctuation at all", ["no punctuation at all"]],
    ["newline is not a break", "line one\nline two\nline three.", ["line one\nline two\nline three."]],
    ["newline after a period is a break", "Line one.\nLine two.", ["Line one.", "Line two."]],
    ["multiple terminators", "What?! Really?? Yes!!! OK.", ["What?!", "Really??", "Yes!!!", "OK."]],
    ["inline code is opaque", "Run `a. B` now. Done.", ["Run `a. B` now.", "Done."]],
    ["emphasis closers", "**Done.** Next. _Last._ End.", ["**Done.**", "Next.", "_Last._", "End."]],
    ["bare ellipsis character only", "…", []],
    ["Fig. and Vol.", "See Fig. 2 and Vol. 3. Done.", ["See Fig. 2 and Vol. 3.", "Done."]],
    ["month abbreviation before a day", "It closed Mar. 3. Then stop.", ["It closed Mar. 3.", "Then stop."]],
    ["non-latin uppercase starts a sentence", "Мир. Привет. Ünï. Éa.", ["Мир.", "Привет.", "Ünï.", "Éa."]],
    ["non-breaking space after the period", "One.\u00A0Two.", ["One.", "Two."]],
    ["tab after the period", "One.\tTwo.", ["One.", "Two."]],
  ];
  for (const [name, input, expected] of table) {
    it(name, () => {
      expect(sentences(input)).toEqual(expected);
    });
  }

  it("does not split a list item and does not let a heading end a sentence", () => {
    const t = "- First. Second. Third.\n- Another one. Yes.\n\n# Title. With dot";
    const a = analyse(t);
    expect(a.units.map((u) => `${u.kind}:${slice(t, u)}`)).toEqual([
      "list_item:First. Second. Third.",
      "list_item:Another one. Yes.",
      "heading:Title. With dot",
    ]);
  });
});

describe("attributed quotes: cue present", () => {
  const yes: Array<[string, string]> = [
    ['You said "keep the migration reversible at all costs" earlier.', '"keep the migration reversible at all costs"'],
    ['you wrote "this should be three words" there', '"this should be three words"'],
    ['You asked "why is this so slow" twice.', '"why is this so slow"'],
    ['You mentioned "the staging box is down" yesterday.', '"the staging box is down"'],
    ['You requested "a dark mode toggle please" in March.', '"a dark mode toggle please"'],
    ['As you put it, "ship it fast".', '"ship it fast"'],
    ['The user said "please make it shorter now".', '"please make it shorter now"'],
    ['The user wrote "this is far too long" above.', '"this is far too long"'],
    ['The user asked "can you fix this bug" earlier.', '"can you fix this bug"'],
    ['According to Nielsen, "users scan before they read".', '"users scan before they read"'],
    ['According to the docs, "tokens expire after one hour".', '"tokens expire after one hour"'],
    ['The docs says "tokens expire after one hour".', '"tokens expire after one hour"'],
    ['The spec states "implementations must reject duplicates".', '"implementations must reject duplicates"'],
    ['The RFC reads "a client must not retry unsafely".', '"a client must not retry unsafely"'],
    ['The README notes "run pnpm install first".', '"run pnpm install first"'],
    ['The error says: "cannot find module foo".', '"cannot find module foo"'],
    ['Ada Lovelace wrote "the engine weaves algebraic patterns".', '"the engine weaves algebraic patterns"'],
    ['Linus said, "talk is cheap, show me".', '"talk is cheap, show me"'],
    ['As the docs put it: "prefer composition over inheritance".', '"prefer composition over inheritance"'],
    ['As Knuth puts it "premature optimisation is evil".', '"premature optimisation is evil"'],
    ['“Measure twice and cut once” — Carpenter Proverb', "“Measure twice and cut once”"],
    ['"Measure twice and cut once" — Carpenter Proverb', '"Measure twice and cut once"'],
    ['"Measure twice and cut once"—Carpenter Proverb', '"Measure twice and cut once"'],
    ['"Measure twice and cut once" -- Carpenter Proverb.', '"Measure twice and cut once"'],
    ['You said that: "keep it small and simple" okay.', '"keep it small and simple"'],
    ['YOU SAID "KEEP IT SMALL AND SIMPLE" OK.', '"KEEP IT SMALL AND SIMPLE"'],
    ["You said “keep it small and simple” okay.", "“keep it small and simple”"],
  ];
  for (const [input, quoted] of yes) {
    it(`quotes ${quoted} in ${JSON.stringify(input)}`, () => {
      expect(quotes(input)).toEqual([quoted]);
    });
  }
});

describe("attributed quotes: stays prose", () => {
  const no: string[] = [
    'The "robust" layer wraps every call.',
    'Our "battle tested" logic is a "so called" feature.',
    'It is "good enough for now" as a fix.', // 4 words, no cue
    'The release notes call it "a clean break from the legacy API" today.',
    'He said "we will ship on Friday" and left.',
    'She wrote "this is how it works" in the doc.',
    'They say "the check is in the mail" a lot.',
    'It reads "return the first match found" there.',
    'Someone on the thread wrote "this should just work now" earlier.',
    'You said "ship it" and then you asked "why not now".', // 2-word quote; "why not now" has a cue
    'You said earlier that we really should maybe "revisit it after launch" soon.', // cue too far
    'You said so. Then I wrote "this is a different sentence" in the doc.', // cue in an earlier sentence
    'You said "foo" but the real answer is "bar baz qux" for sure.', // cue belongs to the first quote only
    'As Knuth. "premature optimisation is evil" here.', // sentence break between name and quote
    'According to. "premature optimisation is evil" here.',
    '"Measure twice and cut once" — the carpenter said.', // lowercase credit
    '"Measure twice and cut once" — The next day came.', // not a name
    'This is "an unmatched quote here and more',
    'This is an unmatched" quote here and more',
    'Use 5" pipe and 6" pipe and 7" pipe here.',
  ];
  for (const input of no) {
    it(`leaves ${JSON.stringify(input)} as prose`, () => {
      const q = quotes(input);
      // "why not now" legitimately has a cue in the one case that mixes both; check the rest of the table strictly.
      if (input.startsWith('You said "ship it" and then')) expect(q).toEqual(['"why not now"']);
      else expect(q).toEqual([]);
    });
  }

  it("treats a quote inside inline code as code, not as a quote", () => {
    const t = 'You said `"keep it small and simple"` once.';
    expect(quotes(t)).toEqual([]);
    expect(analyse(t).masks).toHaveLength(1);
  });

  it("does not attribute across another quote", () => {
    const t = 'You said "alpha beta gamma" and "delta epsilon zeta" together.';
    expect(quotes(t)).toEqual(['"alpha beta gamma"']);
  });

  it("never crosses a paragraph break", () => {
    const t = 'You said "alpha beta\n\ngamma delta" there.';
    expect(quotes(t)).toEqual([]);
  });

  it("splits the surrounding prose into prose / quote / prose with exact boundaries", () => {
    const t = 'You said "alpha beta gamma" ok.';
    expect(kinds(t)).toEqual(["prose:You said ", 'quote:"alpha beta gamma"', "prose: ok."]);
  });

  it("does not quote headings", () => {
    const t = '# You said "alpha beta gamma" ok';
    expect(quotes(t)).toEqual([]);
  });

  it("units around a quote are continuations, never sentence starts", () => {
    const t = 'You said "alpha beta gamma" and left. Then it ended.';
    const a = analyse(t);
    expect(a.units.map((u) => [slice(t, u), u.continuation])).toEqual([
      ["You said", false],
      ["and left.", true],
      ["Then it ended.", false],
    ]);
  });

  it("a list item cut by a quote yields a second list_item unit marked as a continuation", () => {
    const t = '- You said "alpha beta gamma" and left';
    const a = analyse(t);
    expect(a.units.map((u) => [u.kind, slice(t, u), u.continuation])).toEqual([
      ["list_item", "You said", false],
      ["list_item", "and left", true],
    ]);
  });
});

describe("segment kinds and the partition", () => {
  it("empty text has no segments", () => {
    const a = analyse("");
    expect(a.segments).toEqual([]);
    expect(a.units).toEqual([]);
    expect(a.paragraphs).toEqual([]);
    expect(a.masks).toEqual([]);
    expect(a.bold).toEqual([]);
    expect(a.prose_words).toBe(0);
    expect(a.language).toBe("unknown");
    expect(a.normalized).toBe("");
  });

  it("whitespace-only text is one prose segment with no units", () => {
    const a = analyse("  \n\t\n");
    expect(a.segments).toEqual([{ id: "s1", kind: "prose", start: 0, end: 5 }]);
    expect(a.units).toEqual([]);
  });

  it("gaps go to the preceding segment; the first segment absorbs leading whitespace", () => {
    const t = "\n\n  A one.\n\n\n```\ncode\n```\n\n\nB two.\n\n";
    const a = analyse(t);
    expect(a.segments.map((s) => `${s.kind}:${JSON.stringify(slice(t, s))}`)).toEqual([
      'prose:"\\n\\n  A one.\\n\\n\\n"',
      'code:"```\\ncode\\n```\\n\\n\\n"',
      'prose:"B two.\\n\\n"',
    ]);
  });

  it("a prose segment's content never contains a blank line", () => {
    const t = "a one\nsame para\n\nb two\n\n\nc three\n";
    for (const s of analyse(t).segments) {
      expect(/[\n\r][ \t]*[\n\r]/.test(slice(t, s).trimEnd().replace(/\r\n/g, "\n"))).toBe(false);
    }
    expect(analyse(t).segments).toHaveLength(3);
  });

  it("every kind is produced", () => {
    const t = [
      "Prose here.",
      "",
      "```js",
      "code",
      "```",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "> quoted",
      "",
      '    indented code',
      "",
      'You said "alpha beta gamma" ok.',
    ].join("\n");
    const ks = analyse(t).segments.map((s) => s.kind);
    expect(ks).toEqual(["prose", "code", "table", "quote", "code", "prose", "quote", "prose"]);
    expect(ks).not.toContain("tool_output");
  });

  it("a fence needs its marker character and length to close; an unterminated fence runs to the end", () => {
    expect(kinds("a\n\n```\nx\n~~~\ny\n")).toEqual(["prose:a\n\n", "code:```\nx\n~~~\ny\n"]);
    expect(kinds("~~~~\nx\n~~~\ny\n~~~~\nz")).toEqual(["code:~~~~\nx\n~~~\ny\n~~~~\n", "prose:z"]);
    expect(kinds("```js title=a\nx\n```")).toEqual(["code:```js title=a\nx\n```"]);
  });

  it("three backticks on one line with text after them is inline code, not a fence", () => {
    const t = "```inline``` stays prose.";
    expect(analyse(t).segments.map((s) => s.kind)).toEqual(["prose"]);
  });

  it("indented code needs a blank line before it and is not a list continuation", () => {
    expect(analyse("para\n    not code\n").segments.map((s) => s.kind)).toEqual(["prose"]);
    expect(analyse("para\n\n    code\n").segments.map((s) => s.kind)).toEqual(["prose", "code"]);
    expect(analyse("    code first\n").segments.map((s) => s.kind)).toEqual(["code"]);
    expect(analyse("- item\n\n    still the item\n").segments.map((s) => s.kind)).toEqual(["prose", "prose"]);
    expect(analyse("para\n\n\tcode\n").segments.map((s) => s.kind)).toEqual(["prose", "code"]);
  });

  it("indented code spans blank lines between indented lines but stops at an unindented one", () => {
    const t = "p\n\n    a\n\n    b\n\nq\n";
    expect(kinds(t)).toEqual(["prose:p\n\n", "code:    a\n\n    b\n\n", "prose:q\n"]);
  });

  it("a table needs a delimiter row with a matching cell count", () => {
    expect(analyse("a | b\n--|--\n1 | 2").segments.map((s) => s.kind)).toEqual(["table"]);
    expect(analyse("a | b | c\n--|--\n1 | 2").segments.map((s) => s.kind)).toEqual(["prose"]);
    expect(analyse("just | pipes\nno delimiter").segments.map((s) => s.kind)).toEqual(["prose"]);
    expect(analyse("| a |\n|---|\n| 1 |\n\nafter").segments.map((s) => s.kind)).toEqual(["table", "prose"]);
  });

  it("blockquote lines, nested markers and lazy continuation are quote", () => {
    expect(analyse("> a\n> b\n\nc").segments.map((s) => s.kind)).toEqual(["quote", "prose"]);
    expect(analyse(">>>> deep\nlazy\n\nc").segments.map((s) => s.kind)).toEqual(["quote", "prose"]);
    expect(analyse("> a\n- list ends the quote").segments.map((s) => s.kind)).toEqual(["quote", "prose"]);
    expect(analyse("> a\n>\nb").segments.map((s) => s.kind)).toEqual(["quote", "prose"]);
  });
});

describe("units and paragraphs", () => {
  it("tags headings (ATX and setext), list items and sentences, with markers trimmed", () => {
    const t = [
      "# ATX *one* #",
      "",
      "Setext two",
      "----------",
      "",
      "- a",
      "* b",
      "+ c",
      "1. d",
      "2) e",
      "- [ ] f",
      "- [X] g",
      "   - nested h",
      "",
      "Plain sentence.",
    ].join("\n");
    const a = analyse(t);
    expect(a.units.map((u) => `${u.kind}:${slice(t, u)}`)).toEqual([
      "heading:ATX *one*",
      "heading:Setext two",
      "list_item:a",
      "list_item:b",
      "list_item:c",
      "list_item:d",
      "list_item:e",
      "list_item:f",
      "list_item:g",
      "list_item:nested h",
      "sentence:Plain sentence.",
    ]);
  });

  it("an ordered list marker other than 1 does not interrupt a paragraph", () => {
    const t = "The year was\n2019. Then it changed.";
    expect(analyse(t).units.map((u) => u.kind)).toEqual(["sentence", "sentence"]);
    const t2 = "Steps\n1. First\n2. Second";
    expect(analyse(t2).units.map((u) => u.kind)).toEqual(["sentence", "list_item", "list_item"]);
  });

  it("a hash without a space is not a heading", () => {
    const t = "#hashtag and #another";
    expect(analyse(t).units.map((u) => u.kind)).toEqual(["sentence"]);
  });

  it("paragraph rule: a run of sentences; each list block and each heading is its own paragraph", () => {
    const t = ["# H", "Para one. Two.", "- a", "- b", "More text after list is a lazy continuation of b."].join("\n");
    const a = analyse(t);
    // "More text…" directly after a list item continues that item (CommonMark lazy continuation).
    expect(a.units.map((u) => `${u.kind}:${slice(t, u)}`)).toEqual([
      "heading:H",
      "sentence:Para one.",
      "sentence:Two.",
      "list_item:a",
      "list_item:b\nMore text after list is a lazy continuation of b.",
    ]);
    expect(a.paragraphs.map((p) => p.unit_indexes)).toEqual([[0], [1, 2], [3, 4]]);
  });

  it("paragraph offsets span their first unit start to their last unit end, inside one segment", () => {
    const t = "One. Two.\n\nThree. Four.";
    const a = analyse(t);
    expect(a.paragraphs.map((p) => [p.segment_id, slice(t, p)])).toEqual([
      ["s1", "One. Two."],
      ["s2", "Three. Four."],
    ]);
  });

  it("a loose list gives one paragraph per item (blank lines split prose segments)", () => {
    const t = "- a\n\n- b\n\n- c\n";
    const a = analyse(t);
    expect(a.segments.map((s) => s.kind)).toEqual(["prose", "prose", "prose"]);
    expect(a.paragraphs.map((p) => p.unit_indexes)).toEqual([[0], [1], [2]]);
  });

  it("units with no words are dropped", () => {
    const t = "🎉🎉🎉\n\n...\n\n- \n\nReal one.";
    expect(analyse(t).units.map((u) => slice(t, u))).toEqual(["Real one."]);
  });

  it("word counts are per unit and sum to prose_words (headings included, code and quotes excluded)", () => {
    const t = '# Two words\n\nOne two three.\n\n```\nnot counted here\n```\n\nYou said "alpha beta gamma" ok.';
    const a = analyse(t);
    expect(a.units.map((u) => u.words)).toEqual([2, 3, 2, 1]);
    expect(a.prose_words).toBe(8);
  });
});

describe("masks and bold", () => {
  const masksOf = (t: string): string[] => analyse(t).masks.map((m) => `${m.kind}:${slice(t, m)}`);

  it("masks inline code, double-backtick spans, URLs, emails and file paths", () => {
    expect(masksOf("Run `npm test` and ``a ` b`` now.")).toEqual(["inline_code:`npm test`", "inline_code:``a ` b``"]);
    expect(masksOf("See https://x.io/a/b?c=d, or www.x.io/y.")).toEqual(["url:https://x.io/a/b?c=d", "url:www.x.io/y"]);
    expect(masksOf("Mail a.b+c@sub.example.org now.")).toEqual(["email:a.b+c@sub.example.org"]);
    expect(masksOf("Edit src/a.ts, ./b.json, ~/c.md, C:\\d\\e.txt and README.md.")).toEqual([
      "path:src/a.ts",
      "path:./b.json",
      "path:~/c.md",
      "path:C:\\d\\e.txt",
      "path:README.md",
    ]);
  });

  it("does not mask ordinary slashes, versions or plain words", () => {
    expect(masksOf("and/or TCP/IP 24/7 1.5/2.0 v1.2.3 e.g. i.e. U.S. Node 22.6 example.com")).toEqual([]);
  });

  it("an unmatched backtick is literal", () => {
    expect(masksOf("a ` b")).toEqual([]);
    expect(masksOf("a `b")).toEqual([]);
    expect(masksOf("``a` b")).toEqual([]);
  });

  it("masks never cross a segment boundary and never sit inside a quote segment", () => {
    const t = 'The spec says "run `npm test` first now" and `ok`.';
    const a = analyse(t);
    expect(a.masks.map((m) => slice(t, m))).toEqual(["`ok`"]);
    for (const m of a.masks) {
      const seg = a.segments.find((s) => s.start <= m.start && m.end <= s.end);
      expect(seg?.kind).toBe("prose");
    }
  });

  it("finds ** and __ spans, ignoring emphasis, intra-word underscores and unbalanced markers", () => {
    const t = "**a** __b__ *c* _d_ snake__case__x **open and 2 ** 3 ** **e f**";
    expect(analyse(t).bold.map((b) => slice(t, b))).toEqual(["**a**", "__b__", "**e f**"]);
  });

  it("bold inside a quote segment or a code block is not reported", () => {
    const t = 'You said "alpha **beta** gamma" ok.\n\n```\n**x**\n```\n\n**real**';
    expect(analyse(t).bold.map((b) => slice(t, b))).toEqual(["**real**"]);
  });
});

describe("language gate", () => {
  it("is unknown under 40 prose words and decides only from 40", () => {
    const en39 = "The team reviewed the plan and agreed that the first release should ship in March. We cut two features and moved the rest to the next quarter without any disagreement";
    expect(analyse(en39).prose_words).toBeLessThan(40);
    expect(analyse(en39).language).toBe("unknown");
    const fr = "Le serveur de production est tombé hier soir à cause d'une migration mal préparée. Nous avons restauré la base de données depuis la sauvegarde de minuit, puis nous avons rejoué les transactions manquantes une par une. Aucune donnée client n'a été perdue, mais plusieurs commandes ont été retardées de quelques heures.";
    expect(analyse(fr).prose_words).toBeGreaterThanOrEqual(40);
    expect(analyse(fr).language).toBe("non_en");
  });

  it("does not drop prose segments for non_en", () => {
    const fr = "Nous avons restauré la base de données depuis la sauvegarde de minuit, puis nous avons rejoué les transactions manquantes une par une. Aucune donnée client n'a été perdue, mais plusieurs commandes ont été retardées de quelques heures. Pour éviter que cela se reproduise, nous allons ajouter une étape de validation avant chaque déploiement.";
    const a = analyse(fr);
    expect(a.language).toBe("non_en");
    expect(a.segments.map((s) => s.kind)).toEqual(["prose"]);
    expect(a.units.length).toBeGreaterThan(0);
  });

  it("English wrapped in typographic punctuation stays English (words next to dashes and curly quotes still count)", () => {
    const t = "The plan—and the budget—was fine, “but the team” said that the risk was in the schedule—not in the scope, and we agreed that the rest of it was what it was; the end of the day was near and the work was done.";
    expect(analyse(t).prose_words).toBeGreaterThanOrEqual(40);
    expect(analyse(t).language).toBe("en");
  });

  it("English with a lot of code identifiers stays English (masked tokens are ignored)", () => {
    const t = "Run `aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll mmm nnn ooo ppp qqq rrr sss ttt uuu vvv www xxx yyy zzz` and then check that the output is what we expected to see in the report for this case.";
    expect(analyse(t).language).toBe("en");
  });
});

describe("offsets: CRLF, lone CR, astral characters", () => {
  const noBadBoundary = (t: string, p: number): boolean => {
    if (p <= 0 || p >= t.length) return true;
    const prev = t.charCodeAt(p - 1);
    const cur = t.charCodeAt(p);
    if (prev === 13 && cur === 10) return false;
    if (prev >= 0xd800 && prev <= 0xdbff && cur >= 0xdc00 && cur <= 0xdfff) return false;
    return true;
  };

  it("treats \\r\\n as one line break everywhere", () => {
    const t = "# Title\r\n\r\nOne. Two.\r\n- a\r\n- b\r\n\r\n```\r\ncode\r\n```\r\n\r\n> q\r\n\r\nYou said \"alpha beta\r\ngamma\" ok.\r\n";
    const a = analyse(t);
    const offsets = [
      ...a.segments.flatMap((s) => [s.start, s.end]),
      ...a.units.flatMap((u) => [u.start, u.end]),
      ...a.paragraphs.flatMap((p) => [p.start, p.end]),
      ...a.masks.flatMap((m) => [m.start, m.end]),
    ];
    for (const p of offsets) expect(noBadBoundary(t, p), `offset ${p}`).toBe(true);
    expect(a.segments.map((s) => s.kind)).toEqual(["prose", "prose", "code", "quote", "prose", "quote", "prose"]);
    // CRLF text and the same text with LF give the same structure.
    const lf = t.replace(/\r\n/g, "\n");
    const b = analyse(lf);
    expect(b.segments.map((s) => s.kind)).toEqual(a.segments.map((s) => s.kind));
    expect(b.units.map((u) => lf.slice(u.start, u.end))).toEqual(a.units.map((u) => t.slice(u.start, u.end).replace(/\r\n/g, "\n")));
  });

  it("a lone CR is a line break too", () => {
    const t = "a one\rb two\r\rc three";
    expect(analyse(t).segments.map((s) => s.kind)).toEqual(["prose", "prose"]);
    expect(analyse(t).units.map((u) => slice(t, u))).toEqual(["a one\rb two", "c three"]);
  });

  it("never splits a surrogate pair, including around sentence ends and quote marks", () => {
    const t = '😀. 😀 You said "😀 😀 😀" 𝒳. 𝒳 Next.\n\n- 😀 item\n\n𝄞';
    const a = analyse(t);
    const offsets = [
      ...a.segments.flatMap((s) => [s.start, s.end]),
      ...a.units.flatMap((u) => [u.start, u.end]),
      ...a.masks.flatMap((m) => [m.start, m.end]),
    ];
    for (const p of offsets) expect(noBadBoundary(t, p), `offset ${p}`).toBe(true);
  });

  it("slices of units equal what was typed (round trip)", () => {
    const t = "Shipped 🚀 on Friday! Done ✅.";
    const a = analyse(t);
    expect(a.units.map((u) => slice(t, u))).toEqual(["Shipped 🚀 on Friday!", "Done ✅."]);
    expect(a.units[0]?.start).toBe(0);
    expect(a.units[0]?.end).toBe("Shipped 🚀 on Friday!".length);
    expect(a.units[1]?.start).toBe("Shipped 🚀 on Friday! ".length);
  });
});

describe("misc", () => {
  it("normalized has the same length and offsets as text", () => {
    const t = "It’s “quoted” – Dr. Who\u00A0said İ.";
    const a = analyse(t);
    expect(a.normalized.length).toBe(t.length);
    expect(a.normalized).toBe("it's \"quoted\" – dr. who said İ.");
  });

  it("is deterministic and does not mutate shared state between calls", () => {
    const t = 'You said "alpha beta gamma" ok. **x** `y` https://z.io/a.b';
    const first = JSON.stringify(analyse(t));
    for (let i = 0; i < 5; i++) expect(JSON.stringify(analyse(t))).toBe(first);
    analyse("other text, **b** `c`");
    expect(JSON.stringify(analyse(t))).toBe(first);
  });

  it("thematic breaks and front-matter-like rules are prose without units", () => {
    const t = "---\n\nBody.\n";
    const a = analyse(t);
    expect(a.segments.map((s) => s.kind)).toEqual(["prose", "prose"]);
    expect(a.units.map((u) => slice(t, u))).toEqual(["Body."]);
  });
});
