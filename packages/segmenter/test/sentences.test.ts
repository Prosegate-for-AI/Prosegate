import { describe, expect, it } from "vitest";
import { analyse } from "../src/index.js";

const sentences = (t: string): string[] => {
  const a = analyse(t);
  return a.units.filter((u) => u.kind === "sentence").map((u) => t.slice(u.start, u.end));
};

describe("never-break abbreviations (each one, followed by a capitalised word)", () => {
  const capitalised = ["Mr", "Mrs", "Ms", "Dr", "Prof", "Inc", "Ltd", "St", "Jr", "Sr", "Dept"];
  for (const ab of capitalised) {
    it(`${ab}. does not end a sentence`, () => {
      const t = `We asked ${ab}. Brown today. Then we left.`;
      expect(sentences(t)).toEqual([`We asked ${ab}. Brown today.`, "Then we left."]);
    });
  }
  const anyCase = ["e.g", "i.e", "vs", "cf", "approx", "U.S", "fig", "vol", "eq", "ca", "al", "co", "corp", "esp", "incl", "viz"];
  for (const ab of anyCase) {
    it(`${ab}. does not end a sentence, in either case`, () => {
      for (const form of [ab, ab.toUpperCase(), ab.charAt(0).toUpperCase() + ab.slice(1)]) {
        const t = `See ${form}. Brown today. Then we left.`;
        expect(sentences(t), form).toEqual([`See ${form}. Brown today.`, "Then we left."]);
      }
    });
  }
  it("Co. and Corp. in company names", () => {
    expect(sentences("Smith et al. Wrote it. Acme Co. Berlin opened. Globex Corp. Paris too.")).toEqual([
      "Smith et al. Wrote it.",
      "Acme Co. Berlin opened.",
      "Globex Corp. Paris too.",
    ]);
  });
  it("lowercase ms. (milliseconds), no. (the word) and mar. (not a month name) end sentences", () => {
    expect(sentences("It took 5 ms. Then it stopped.")).toEqual(["It took 5 ms.", "Then it stopped."]);
    expect(sentences("Answer: no. Then leave.")).toEqual(["Answer: no.", "Then leave."]);
  });
});

describe("month abbreviations and No. only veto before a digit", () => {
  const months = ["Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Sept", "Oct", "Nov", "Dec"];
  for (const m of months) {
    it(`${m}. 5 stays together; ${m}. Then breaks`, () => {
      expect(sentences(`It closed ${m}. 5 without issues. Done.`)).toEqual([`It closed ${m}. 5 without issues.`, "Done."]);
      expect(sentences(`It closed in ${m}. Then it reopened.`)).toEqual([`It closed in ${m}.`, "Then it reopened."]);
    });
  }
  it("No. before a digit, and a one-word No.", () => {
    expect(sentences("See No. 7 now. No. That is wrong.")).toEqual(["See No. 7 now.", "No.", "That is wrong."]);
  });
});

describe("a.m., p.m. and etc. end sentences unless a weekday, month or time zone follows", () => {
  it("Meet at 9 a.m. Monday for the review. is one unit", () => {
    expect(sentences("Meet at 9 a.m. Monday for the review. Then lunch.")).toEqual(["Meet at 9 a.m. Monday for the review.", "Then lunch."]);
  });
  const soft = ["a.m.", "p.m.", "etc."];
  const nonBreaking = ["Monday", "Tue", "Wednesday", "Sun", "March", "Sept", "Dec", "EST", "PST", "UTC", "CEST", "GMT"];
  for (const ab of soft) {
    for (const next of nonBreaking) {
      it(`${ab} ${next} does not break`, () => {
        expect(sentences(`We meet at 9 ${ab} ${next} for coffee. Then we go.`)).toEqual([`We meet at 9 ${ab} ${next} for coffee.`, "Then we go."]);
      });
    }
    it(`${ab} before an ordinary capitalised word breaks`, () => {
      expect(sentences(`We meet at 9 ${ab} Everyone is welcome. Then we go.`)).toEqual([`We meet at 9 ${ab}`, "Everyone is welcome.", "Then we go."]);
    });
  }
  it("a long ALLCAPS word or a 1-letter token is not a time zone", () => {
    expect(sentences("Open at 9 a.m. UNICEF staff only. Done.")).toEqual(["Open at 9 a.m.", "UNICEF staff only.", "Done."]);
    expect(sentences("Open at 9 a.m. I will come. Done.")).toEqual(["Open at 9 a.m.", "I will come.", "Done."]);
  });
  it("May is not treated as a month here (it is also a verb)", () => {
    expect(sentences("Open at 9 a.m. May I come? Yes.")).toEqual(["Open at 9 a.m.", "May I come?", "Yes."]);
  });
});

describe("initials", () => {
  const table: Array<[string, string[]]> = [
    ["Use option B. Otherwise stop.", ["Use option B.", "Otherwise stop."]],
    ["Set it to X. Because reasons.", ["Set it to X.", "Because reasons."]],
    ["Pick one of A. B. or C. Done.", ["Pick one of A. B. or C.", "Done."]],
    ["J. Smith said hi. Bye.", ["J. Smith said hi.", "Bye."]],
    ["Hello. J. Smith said hi. Bye.", ["Hello.", "J. Smith said hi.", "Bye."]],
    ["John F. Kennedy came. Bye.", ["John F. Kennedy came.", "Bye."]],
    ["J. R. R. Tolkien wrote it. Bye.", ["J. R. R. Tolkien wrote it.", "Bye."]],
    ["J.R.R. Tolkien wrote it. Bye.", ["J.R.R. Tolkien wrote it.", "Bye."]],
    ["It was written by J. Smith and others. Bye.", ["It was written by J. Smith and others.", "Bye."]],
    ["Then A. Einstein replied. Bye.", ["Then A. Einstein replied.", "Bye."]],
    ["See Appendix A. The next step follows.", ["See Appendix A.", "The next step follows."]],
    ["Plan B. Next we test.", ["Plan B.", "Next we test."]],
    ["It was only I. We left.", ["It was only I.", "We left."]],
    ["Vitamin C. 5 mg daily.", ["Vitamin C.", "5 mg daily."]],
    ["Ask Dr. J. Smith today. Bye.", ["Ask Dr. J. Smith today.", "Bye."]],
    ["(J. Smith) came. Bye.", ["(J. Smith) came.", "Bye."]],
  ];
  for (const [input, expected] of table) {
    it(JSON.stringify(input), () => {
      expect(sentences(input)).toEqual(expected);
    });
  }
});

describe("emoji and symbol sentence starters", () => {
  it("Done. ✅ Tests pass. ⚠️ One warning remains. gives 3 units", () => {
    expect(sentences("Done. ✅ Tests pass. ⚠️ One warning remains.")).toEqual(["Done.", "✅ Tests pass.", "⚠️ One warning remains."]);
  });
  it("arrows, check marks and astral emoji start sentences", () => {
    expect(sentences("Built it. → Next we ship. ✓ Verified. 🚀 Launched.")).toEqual(["Built it.", "→ Next we ship.", "✓ Verified.", "🚀 Launched."]);
  });
  it("a lowercase word after the period still does not break", () => {
    expect(sentences("Built it. then shipped it.")).toEqual(["Built it. then shipped it."]);
  });
});

describe("inline numbered steps", () => {
  it("Steps: 1. Install the deps. 2. Run the tests. keeps each number with its step", () => {
    expect(sentences("Steps: 1. Install the deps. 2. Run the tests.")).toEqual(["Steps: 1. Install the deps.", "2. Run the tests."]);
  });
  it("no unit is just a step number", () => {
    const t = "First: 1. Install. 2. Run. 3. Ship. 10. Celebrate.";
    for (const s of sentences(t)) expect(/^\d{1,2}[.)]$/.test(s)).toBe(false);
    expect(sentences(t)).toEqual(["First: 1. Install.", "2. Run.", "3. Ship.", "10. Celebrate."]);
  });
  it("a number that ends a real sentence still breaks", () => {
    expect(sentences("We have step 2. Then we go.")).toEqual(["We have step 2.", "Then we go."]);
    expect(sentences("It costs 5 dollars. 3 more are free.")).toEqual(["It costs 5 dollars.", "3 more are free."]);
  });
  it("a number after an abbreviation period is not a step marker", () => {
    expect(sentences("See Vol. 3. Then stop.")).toEqual(["See Vol. 3.", "Then stop."]);
  });
});

describe("Markdown link text", () => {
  it("does not split inside [text](url)", () => {
    expect(sentences("[Step 1. Install](#install) is first. Next.")).toEqual(["[Step 1. Install](#install) is first.", "Next."]);
  });
  it("brackets that are not links do not protect a period", () => {
    expect(sentences("A [note. Then] more. Done.")).toEqual(["A [note.", "Then] more.", "Done."]);
  });
  it("nested and multiple links", () => {
    expect(sentences("See [A. B](#a) and [C. D](#c). Done.")).toEqual(["See [A. B](#a) and [C. D](#c).", "Done."]);
  });
  it("inline code inside link text", () => {
    expect(sentences("Read [the `a. B` guide. Now](#g) today. Done.")).toEqual(["Read [the `a. B` guide. Now](#g) today.", "Done."]);
  });
});

describe("astral sentence starters", () => {
  it("an astral uppercase letter starts a sentence; an astral lowercase letter does not", () => {
    expect(sentences("Done. 𝒳 is next.")).toEqual(["Done.", "𝒳 is next."]);
    expect(sentences("Done. 𝓍 is next.")).toEqual(["Done. 𝓍 is next."]);
  });
  it("an astral uppercase letter after a title veto and after an initial", () => {
    expect(sentences("Ask Dr. 𝒳 today. Bye.")).toEqual(["Ask Dr. 𝒳 today.", "Bye."]);
  });
});
