// Boundary and branch tests added after a mutation-testing sweep of src/ (comparison operators,
// boolean connectives, +/-1 offsets): each case below kills a mutant that the earlier tests let live.

import { describe, expect, it } from "vitest";
import { analyse, countWords } from "../src/index.js";
import { languageStats } from "../src/language.js";

const slice = (t: string, s: { start: number; end: number }): string => t.slice(s.start, s.end);
const quotesOf = (t: string): string[] =>
  analyse(t)
    .segments.filter((s) => s.kind === "quote" && !t.slice(s.start, s.end).trimStart().startsWith(">"))
    .map((s) => t.slice(s.start, s.end).trim());
const unitsOf = (t: string): string[] => analyse(t).units.map((u) => `${u.kind[0]}:${slice(t, u)}`);
const masksOf = (t: string): string[] => analyse(t).masks.map((m) => `${m.kind}:${slice(t, m)}`);

describe("word characters at the edges of each class", () => {
  it("0 9 A Z a z are word characters; their neighbours are not", () => {
    expect(countWords("0 9 A Z a z")).toBe(6);
    expect(countWords("/:@[`{")).toBe(0);
    expect(countWords("0/9:A@Z[a`z{")).toBe(6);
    expect(countWords("/0:9@A[Z`a{z")).toBe(6);
  });
  it("text_start lands on each edge character", () => {
    for (const ch of ["0", "9", "A", "Z", "a", "z"]) {
      const t = `(${ch}) rest of it`;
      expect(analyse(t).units[0]?.text_start, ch).toBe(1);
    }
    for (const ch of ["/", ":", "@", "[", "`", "{"]) {
      const t = `${ch}x rest of it`;
      expect(analyse(t).units[0]?.text_start, ch).toBe(1);
    }
  });
});

describe("language statistics tokens", () => {
  it("apostrophes and hyphens join inside a token, nowhere else", () => {
    const text = "don't well-known 'quoted' -dash- a--b";
    const stats = languageStats(text, [[0, text.length]], []);
    // don't | well-known | quoted | dash | a | b
    expect(stats.tokens).toBe(6);
  });
  it("counts curly apostrophes and Unicode tokens like countWords", () => {
    const text = "don’t naïve café";
    expect(languageStats(text, [[0, text.length]], []).tokens).toBe(countWords(text));
  });
});

describe("email masks", () => {
  it("an @ without a local part or without a domain is not an email", () => {
    expect(masksOf("write @example.com now")).toEqual([]);
    expect(masksOf("write name@ now")).toEqual([]);
    expect(masksOf("write name@. now")).toEqual([]);
    expect(masksOf("write name@host now")).toEqual([]);
    expect(masksOf("write name@host.c now")).toEqual(["path:name@host.c"]); // not an email (one-letter TLD); the .c extension makes it a path
  });
  it("a real email next to those", () => {
    expect(masksOf("write @a and b@c.de now")).toEqual(["email:b@c.de"]);
    expect(masksOf("mail first.last+tag@sub.example.org.")).toEqual(["email:first.last+tag@sub.example.org"]);
  });
});

describe("URL and path flags", () => {
  it("URLs without a dot (colon only) and with a dot but no colon or slash", () => {
    expect(masksOf("see http://localhost:3000/api now")).toEqual(["url:http://localhost:3000/api"]);
    expect(masksOf("see http://localhost now")).toEqual(["url:http://localhost"]);
    expect(masksOf("visit www.example.org now")).toEqual(["url:www.example.org"]);
  });
  it("plain words are never masks", () => {
    expect(masksOf("just some plain words here")).toEqual([]);
  });
});

describe("quote marks: what may open and close a straight-quoted run", () => {
  const body = "keep it small and simple";
  it("every listed closer may follow the closing mark", () => {
    for (const c of [".", ",", ";", ":", "!", "?", ")", "]", "}", "-", "'", "’", "—", "–", "…", "*", "_", " "]) {
      const t = `You said "${body}"${c} ok`;
      expect(quotesOf(t), JSON.stringify(c)).toEqual([`"${body}"`]);
    }
  });
  it("a letter or digit directly after the closing mark means it is not a closer", () => {
    expect(quotesOf(`You said "${body}"x ok`)).toEqual([]);
    expect(quotesOf(`You said "${body}"1 ok`)).toEqual([]);
  });
  it("every listed character may precede an opening mark (credit form, so no cue is needed)", () => {
    for (const p of [" ", "(", "[", "{", ":", ";", ",", "-", "/", "*", "_", "—", "–", "‘", "“"]) {
      const t = `X${p}"Measure twice and cut once" — Ada Lovelace`;
      expect(quotesOf(t), JSON.stringify(p)).toEqual(['"Measure twice and cut once"']);
    }
    for (const p of ["a", "5", ".", "!"]) {
      const t = `X${p}"Measure twice and cut once" — Ada Lovelace`;
      expect(quotesOf(t), JSON.stringify(p)).toEqual([]);
    }
  });
  it("an opening mark followed by whitespace or the end of the element, or by another quote mark, opens nothing", () => {
    expect(quotesOf(`You said " ${body}" ok`)).toEqual([]);
    expect(quotesOf(`You said "`)).toEqual([]);
    expect(quotesOf(`You said ""${body}" ok`)).toEqual([]); // the second mark follows a quote mark, not whitespace
    expect(quotesOf(`You said "${body} "`)).toEqual([]); // whitespace before the closing mark
  });
  it("a quote closes at the first valid closer even when later marks exist", () => {
    expect(quotesOf(`You said "${body}" and "the second one here" later`)).toEqual([`"${body}"`]);
  });
});

describe("unmatched marks of one kind do not hide quotes of the other kind", () => {
  const body = "keep it small and simple";
  it("an unmatched curly opener before a straight quote", () => {
    expect(quotesOf(`X \u201c unmatched. You said "${body}" ok`)).toEqual([`"${body}"`]);
  });
  it("an unmatched straight opener before a curly quote", () => {
    expect(quotesOf(`X "unmatched. You said \u201c${body}\u201d ok`)).toEqual([`\u201c${body}\u201d`]);
  });
  it("many unmatched curly openers followed by a quote", () => {
    expect(quotesOf(`${"\u201c a ".repeat(50)} You said "${body}" ok`)).toEqual([`"${body}"`]);
  });
});

describe("cue-line quotes: trailing punctuation after the closing mark", () => {
  for (const c of [".", ",", ";", ":", "!", "?", ")", "]", "*", "_", " ", ".)"]) {
    it(`allows ${JSON.stringify(c)}`, () => {
      expect(quotesOf(`You asked:\n\n"fix it"${c}`)).toEqual(['"fix it"']);
    });
  }
  it("rejects any other trailing text", () => {
    expect(quotesOf('You asked:\n\n"fix it" please')).toEqual([]);
    expect(quotesOf('You asked:\n\n"fix it"-')).toEqual([]);
    expect(quotesOf('You asked:\n\n"fix it"x')).toEqual([]);
  });
});

describe("bold flanking", () => {
  const boldOf = (t: string): string[] => analyse(t).bold.map((b) => slice(t, b));
  it("underscores do not open or close inside a word", () => {
    expect(boldOf("foo__bar__ baz")).toEqual([]);
    expect(boldOf("foo __bar__baz")).toEqual([]);
    expect(boldOf("foo__bar__baz")).toEqual([]);
    expect(boldOf("foo __bar__ baz")).toEqual(["__bar__"]);
  });
  it("asterisks may be intraword", () => {
    expect(boldOf("foo**bar**baz")).toEqual(["**bar**baz".slice(0, 7)]);
  });
  it("a bold opener at the very start of the element", () => {
    expect(boldOf("**x** y")).toEqual(["**x**"]);
    expect(boldOf("- **x** y")).toEqual(["**x**"]);
    expect(boldOf("# **x** y")).toEqual(["**x**"]);
    expect(boldOf("1. **x** y")).toEqual(["**x**"]);
  });
  it("runs of 1 or 4+ are not bold", () => {
    expect(boldOf("*a* ****b**** *c*")).toEqual([]);
  });
});

describe("list items and task boxes", () => {
  it("a task box needs [ ], [x] or [X] followed by whitespace", () => {
    expect(unitsOf("- [ ] todo\n- [x] done\n- [X] done too")).toEqual(["l:todo", "l:done", "l:done too"]);
    expect(unitsOf("- [link] text")).toEqual(["l:[link] text"]);
    expect(unitsOf("- [x]text")).toEqual(["l:[x]text"]);
    expect(unitsOf("- [y] z")).toEqual(["l:[y] z"]);
    expect(unitsOf("- [] z")).toEqual(["l:[] z"]);
    expect(unitsOf("- [ ]")).toEqual([]);
    expect(unitsOf("- [x]")).toEqual([]);
    expect(unitsOf("- [xx] text")).toEqual(["l:[xx] text"]);
  });
  it("an empty marker line takes its text from the next line", () => {
    expect(unitsOf("-\n  continued text here")).toEqual(["l:continued text here"]);
    expect(unitsOf("1.\n   continued text here")).toEqual(["l:continued text here"]);
    expect(unitsOf("-\n")).toEqual([]);
  });
});

describe("setext underlines", () => {
  it("two dashes underline a heading; one dash does not; equals signs need one", () => {
    expect(unitsOf("Title\n--")).toEqual(["h:Title"]);
    expect(unitsOf("Title\n=")).toEqual(["h:Title"]);
    expect(unitsOf("Title\n-")).toEqual(["s:Title -"].map(() => "s:Title\n-"));
    expect(unitsOf("Title\n== x")).toEqual(["s:Title\n== x"]);
  });
});

describe("blockquote lazy continuation after marker-only lines", () => {
  it("a quote line holding only further markers has no content, so a plain line ends the quote", () => {
    const t = "> a\n> >\nplain";
    expect(analyse(t).segments.map((s) => s.kind)).toEqual(["quote", "prose"]);
    const t2 = "> a\n>>\nplain";
    expect(analyse(t2).segments.map((s) => s.kind)).toEqual(["quote", "prose"]);
    const t3 = "> a\n> b\nplain";
    expect(analyse(t3).segments.map((s) => s.kind)).toEqual(["quote"]);
  });
});

describe("initials after punctuation", () => {
  it("a lowercase word ending in . ! ? or : leaves the initial opening a sentence or clause", () => {
    for (const p of ["ok.", "done!", "really?", "note:"]) {
      const t = `${p} J. Smith said hi. Bye.`;
      const us = analyse(t).units.map((u) => slice(t, u));
      expect(us.some((u) => u.endsWith("J. Smith said hi.")), p).toBe(true);
    }
  });
  it("capitalised previous words starting with A and Z count as capitalised", () => {
    for (const w of ["Amy", "Zoe", "Alexander", "Zed"]) {
      const t = `Ask ${w} J. Smith said hi. Bye.`;
      expect(analyse(t).units.map((u) => slice(t, u)), w).toEqual([`Ask ${w} J. Smith said hi.`, "Bye."]);
    }
  });
  it("a lowercase non-lead word before the initial lets the sentence end", () => {
    const t = "Use option q J. Smith said hi.";
    expect(analyse(t).units.map((u) => slice(t, u))).toEqual(["Use option q J.", "Smith said hi."]);
  });
});

describe("inline step markers after each clause punctuation", () => {
  it("after : ; ! ?", () => {
    for (const p of [":", ";", "!", "?"]) {
      const t = `Ready${p} 1. Install it. 2. Run it.`;
      const us = analyse(t).units.map((u) => slice(t, u));
      expect(us.every((u) => u !== "1." && u !== "2."), p).toBe(true);
      expect(us.some((u) => u.includes("1. Install it.")), p).toBe(true);
      expect(us.at(-1), p).toBe("2. Run it.");
    }
  });
});

describe("table delimiter rows", () => {
  it("escaped pipes do not count as cell separators", () => {
    expect(analyse("a \\| b | c\n--- | ---\n1 | 2").segments.map((s) => s.kind)).toEqual(["table"]);
    expect(analyse("a | b | c\n--- | ---\n1 | 2").segments.map((s) => s.kind)).toEqual(["prose"]);
  });
  it("leading and trailing pipes are optional and do not change the cell count", () => {
    expect(analyse("| a | b |\n| - | - |\n| 1 | 2 |").segments.map((s) => s.kind)).toEqual(["table"]);
    expect(analyse("a | b\n- | -\n1 | 2").segments.map((s) => s.kind)).toEqual(["table"]);
    expect(analyse("| a | b\n- | -\n1 | 2").segments.map((s) => s.kind)).toEqual(["table"]);
  });
});

describe("line breaks", () => {
  it("each break style ends a line and the next block starts after it", () => {
    for (const nl of ["\n", "\r\n", "\r"]) {
      const t = `# Head${nl}${nl}Body one.${nl}${nl}- item${nl}`;
      expect(analyse(t).units.map((u) => slice(t, u)), JSON.stringify(nl)).toEqual(["Head", "Body one.", "item"]);
    }
  });
});
