import { describe, expect, it } from "vitest";
import { analyse } from "../src/index.js";

const kinds = (t: string): string[] => analyse(t).segments.map((s) => `${s.kind}:${JSON.stringify(t.slice(s.start, s.end))}`);
const unitTexts = (t: string): string[] => analyse(t).units.map((u) => `${u.kind}:${t.slice(u.start, u.end)}`);

describe("a fence opener as the first content of a list item", () => {
  it("- ```bash: the marker stays prose, the code is a code segment, nothing leaks into units", () => {
    const t = "- ```bash\n  npm i leakword\n  ```\n- Next item is prose.";
    expect(kinds(t)).toEqual(['prose:"- "', 'code:"```bash\\n  npm i leakword\\n  ```\\n"', 'prose:"- Next item is prose."']);
    expect(unitTexts(t)).toEqual(["list_item:Next item is prose."]);
    expect(analyse(t).units.some((u) => t.slice(u.start, u.end).includes("leakword"))).toBe(false);
  });

  it("1. ```bash (ordered)", () => {
    const t = "1. ```bash\n   npm i leakword\n   ```\n2. Next item is prose.";
    expect(kinds(t)).toEqual(['prose:"1. "', 'code:"```bash\\n   npm i leakword\\n   ```\\n"', 'prose:"2. Next item is prose."']);
    expect(unitTexts(t)).toEqual(["list_item:Next item is prose."]);
  });

  it("also with *, +, a task box and a tilde fence", () => {
    for (const marker of ["* ", "+ ", "- [ ] ", "- [x] "]) {
      const t = `${marker}\`\`\`sh\n  leak\n  \`\`\`\n- after`;
      expect(unitTexts(t), marker).toEqual(["list_item:after"]);
    }
    const tilde = "- ~~~sh\n  leak\n  ~~~\n- after";
    expect(unitTexts(tilde)).toEqual(["list_item:after"]);
  });

  it("after an earlier item and an earlier text, in the same list", () => {
    const t = "- first item here\n- ```sh\n  leak\n  ```\n- last item here";
    expect(unitTexts(t)).toEqual(["list_item:first item here", "list_item:last item here"]);
    expect(analyse(t).paragraphs.map((p) => p.block_id)).toEqual(["b1", "b1"]);
  });

  it("an unterminated fence on a marker line runs to the end", () => {
    const t = "- ```sh\n  leak one\n- leak two";
    expect(unitTexts(t)).toEqual([]);
    expect(analyse(t).segments.map((s) => s.kind)).toEqual(["prose", "code"]);
  });

  it("a fence-looking span with more text after it on the marker line is just prose", () => {
    const t = "- ```not a fence``` but inline code\n- next item";
    expect(analyse(t).segments.map((s) => s.kind)).toEqual(["prose"]);
    expect(unitTexts(t)).toEqual(["list_item:```not a fence``` but inline code", "list_item:next item"]);
  });

  it("the closing fence is found at any indentation", () => {
    const t = "- ```sh\nleak\n```\n- after";
    expect(unitTexts(t)).toEqual(["list_item:after"]);
  });
});

describe("tables", () => {
  it("a table inside a list item indented 4+ spaces is a table", () => {
    const t = "- a\n\n    | a | b |\n    |---|---|\n    | 1 | 2 |\n- c";
    expect(analyse(t).segments.map((s) => s.kind)).toEqual(["prose", "table", "prose"]);
    expect(unitTexts(t)).toEqual(["list_item:a", "list_item:c"]);
  });
  it("outside a list, an indented pipe table is indented code", () => {
    const t = "Intro.\n\n    | a | b |\n    |---|---|\n    | 1 | 2 |\n";
    expect(analyse(t).segments.map((s) => s.kind)).toEqual(["prose", "code"]);
  });
});

describe("typographic bullets", () => {
  for (const b of ["•", "‣", "◦", "▪", "●"]) {
    it(`${b} followed by a space is a list marker`, () => {
      const t = `Intro text.\n\n${b} first item\n${b} second item`;
      expect(unitTexts(t)).toEqual(["sentence:Intro text.", "list_item:first item", "list_item:second item"]);
    });
  }
  it("without the space it is text", () => {
    expect(unitTexts("•nospace here")).toEqual(["sentence:•nospace here"]);
  });
  it("nested under a dash list", () => {
    expect(unitTexts("- a one\n  • b two\n  • c three")).toEqual(["list_item:a one", "list_item:b two", "list_item:c three"]);
  });
});

describe("indented code after a heading or a thematic break", () => {
  it("an ATX heading directly followed by an indented line", () => {
    const t = "# Heading\n    code line\n\nAfter.";
    expect(analyse(t).segments.map((s) => s.kind)).toEqual(["prose", "code", "prose"]);
  });
  it("a setext heading directly followed by an indented line", () => {
    const t = "Title\n=====\n    code line\n";
    expect(analyse(t).segments.map((s) => s.kind)).toEqual(["prose", "code"]);
  });
  it("a thematic break directly followed by an indented line", () => {
    const t = "Before.\n\n***\n    code line\n";
    expect(analyse(t).segments.map((s) => s.kind)).toEqual(["prose", "prose", "code"]);
  });
  it("a plain paragraph followed by an indented line stays a paragraph", () => {
    const t = "Plain text\n    more of the same paragraph";
    expect(analyse(t).segments.map((s) => s.kind)).toEqual(["prose"]);
  });
  it("a list item followed by an indented line stays a list continuation", () => {
    const t = "- item\n    more of the item";
    expect(analyse(t).segments.map((s) => s.kind)).toEqual(["prose"]);
    expect(unitTexts(t)).toEqual(["list_item:item\n    more of the item"]);
  });
});

describe("BOM and NBSP at the start of a line", () => {
  it("a BOM at offset 0 is whitespace for block detection: a fence after it is code", () => {
    const t = "﻿```js\ncode\n```\n\nText here.";
    expect(analyse(t).segments.map((s) => s.kind)).toEqual(["code", "prose"]);
    expect(analyse(t).segments[0]?.start).toBe(0);
  });
  it("a BOM before a heading, a list item and a quote", () => {
    expect(unitTexts("﻿# Title\n\nBody.")).toEqual(["heading:Title", "sentence:Body."]);
    expect(unitTexts("﻿- item")).toEqual(["list_item:item"]);
    expect(analyse("﻿> quoted\n").segments.map((s) => s.kind)).toEqual(["quote"]);
  });
  it("a BOM that is not at offset 0 is an ordinary character", () => {
    const t = "Text.\n\n﻿```js\ncode\n```";
    // the BOM line is plain text, so the closing fence becomes an (unterminated) opener
    expect(analyse(t).segments.map((s) => s.kind)).toEqual(["prose", "prose", "code"]);
  });
  it("NBSP indentation before a fence", () => {
    const t = "   ```js\ncode\n```\n\nText here.";
    expect(analyse(t).segments.map((s) => s.kind)).toEqual(["code", "prose"]);
  });
  it("four NBSP before a line after a blank line make indented code", () => {
    const t = "Intro.\n\n    code here\n";
    expect(analyse(t).segments.map((s) => s.kind)).toEqual(["prose", "code"]);
  });
});

describe("YAML front matter", () => {
  it("a --- block at offset 0 closed by --- is a code segment, not a setext heading", () => {
    const t = "---\ntitle: Notes\ntags: [a, b]\n---\n\nBody text here.";
    expect(kinds(t)).toEqual(['code:"---\\ntitle: Notes\\ntags: [a, b]\\n---\\n\\n"', 'prose:"Body text here."']);
    expect(unitTexts(t)).toEqual(["sentence:Body text here."]);
  });
  it("closed by ...", () => {
    const t = "---\ntitle: Notes\n...\n\nBody.";
    expect(analyse(t).segments.map((s) => s.kind)).toEqual(["code", "prose"]);
  });
  it("a first line that is a YAML comment", () => {
    const t = "---\n# comment\nkey: v\n---\nBody.";
    expect(analyse(t).segments.map((s) => s.kind)).toEqual(["code", "prose"]);
  });
  it("after a BOM", () => {
    const t = "﻿---\ntitle: Notes\n---\nBody.";
    expect(analyse(t).segments.map((s) => s.kind)).toEqual(["code", "prose"]);
  });
  it("with trailing spaces on the fences", () => {
    const t = "---  \ntitle: Notes\n---  \nBody.";
    expect(analyse(t).segments.map((s) => s.kind)).toEqual(["code", "prose"]);
  });
  it("not front matter: no closer, a blank second line, prose second line, or not at offset 0", () => {
    expect(analyse("---\ntitle: Notes\nBody.").segments.map((s) => s.kind)).toEqual(["prose"]);
    expect(analyse("---\n\nA rule above, then prose.\n\n---\nmore").segments.every((s) => s.kind === "prose")).toBe(true);
    expect(analyse("---\nJust a sentence here.\n---\nmore").segments.every((s) => s.kind === "prose")).toBe(true);
    expect(analyse("Text.\n\n---\ntitle: Notes\n---\nBody.").segments.every((s) => s.kind === "prose")).toBe(true);
  });
});

describe("HTML comments are masks", () => {
  const masks = (t: string): string[] => analyse(t).masks.map((m) => `${m.kind}:${t.slice(m.start, m.end)}`);

  it("inline, standalone and multi-line comments", () => {
    expect(masks("Text <!-- hidden. Comment --> more text.")).toEqual(["html_comment:<!-- hidden. Comment -->"]);
    expect(masks("<!-- only a comment -->")).toEqual(["html_comment:<!-- only a comment -->"]);
    expect(masks("Line one <!-- a\nb --> line two.")).toEqual(["html_comment:<!-- a\nb -->"]);
    expect(masks("a <!-- one --> b <!-- two --> c")).toEqual(["html_comment:<!-- one -->", "html_comment:<!-- two -->"]);
  });
  it("an unclosed <!-- masks nothing: it is literal text", () => {
    expect(masks("Text <!-- unclosed comment here.\n\nNext paragraph.")).toEqual([]);
    expect(masks("a <!-- one --> b <!-- unclosed c")).toEqual(["html_comment:<!-- one -->"]);
    expect(masks("a <!-- x `code` y")).toEqual(["inline_code:`code`"]);
  });
  it("a comment swallows inline code inside it; code containing <!-- is code", () => {
    expect(masks("a <!-- see `x` here --> b")).toEqual(["html_comment:<!-- see `x` here -->"]);
    expect(masks("a `<!-- not a comment` b")).toEqual(["inline_code:`<!-- not a comment`"]);
    expect(masks("`code` then <!-- c --> then `more`")).toEqual(["inline_code:`code`", "html_comment:<!-- c -->", "inline_code:`more`"]);
  });
  it("a URL or path inside a comment is not reported separately", () => {
    expect(masks("a <!-- see https://x.io/a.b and src/a.ts --> b")).toEqual(["html_comment:<!-- see https://x.io/a.b and src/a.ts -->"]);
  });
  it("sentences do not break inside a comment", () => {
    const t = "Before <!-- TODO. Fix this. --> after. Next.";
    expect(unitTexts(t)).toEqual(["sentence:Before <!-- TODO. Fix this. --> after.", "sentence:Next."]);
  });
  it("comments in list items and headings", () => {
    expect(masks("- item <!-- c --> text")).toEqual(["html_comment:<!-- c -->"]);
    expect(masks("# Title <!-- c -->")).toEqual(["html_comment:<!-- c -->"]);
  });
  it("<!-- inside an attributed quote is dropped with the quote", () => {
    const t = 'You said "keep <!-- this --> comment out of it" there.';
    expect(masks(t)).toEqual([]);
  });
});

describe("whitespace characters that make a line blank (isWs)", () => {
  for (const [name, ch] of [
    ["U+3000 ideographic space", "　"],
    ["U+2028 line separator", " "],
    ["U+FEFF", "﻿"],
    ["U+202F narrow no-break space", " "],
    ["U+00A0", " "],
    ["U+2003 em space", " "],
    ["U+205F", " "],
    ["U+1680", " "],
    ["U+2029", " "],
    ["tab", "\t"],
    ["form feed", "\f"],
    ["vertical tab", "\v"],
  ] as const) {
    it(`a line holding only ${name} separates paragraphs`, () => {
      const t = `One.\n${ch}\nTwo.`;
      expect(analyse(t).segments.map((s) => s.kind)).toEqual(["prose", "prose"]);
    });
  }
  it("U+200B (zero width space) is not whitespace", () => {
    expect(analyse("One.\n​\nTwo.").segments.map((s) => s.kind)).toEqual(["prose"]);
  });
  it("trimming uses the same set: units exclude surrounding U+3000 / U+202F", () => {
    const t = "　 Hello there. 　";
    expect(unitTexts(t)).toEqual(["sentence:Hello there."]);
  });
});
