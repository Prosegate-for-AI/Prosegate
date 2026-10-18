import { describe, expect, it } from "vitest";
import { foldClaudeNotice } from "../src/claude-notice.js";
import { debugNoticeLine, overlaysIgnoredLine, tooLongLine, truncatedLine, uncheckedLine } from "../src/inject.js";
import { loweredNoticeLine } from "../src/lowering.js";

// ADR-33: Claude Code prefixes every line of a systemMessage with "Stop says: ", so a turn carries one notice: the lowered text and
// every other single line join the header, at most three finding lines follow, then "  …and N more".

const HEADER = "Prosegate · profile chat-reply · 2 findings (filler 2) · advisory, not enforced";
const FILLER = ['  filler   core.filler.001  "Great question!"', '  filler   core.filler.004  "In summary,"'];

describe("foldClaudeNotice", () => {
  it("leaves a one-line notice alone, including a lowered line standing alone (it keeps its pointer to prosegate status)", () => {
    expect(foldClaudeNotice("Prosegate · 1 finding remains after 2 passes · shipped as is")).toBe("Prosegate · 1 finding remains after 2 passes · shipped as is");
    expect(foldClaudeNotice(loweredNoticeLine("advisory"))).toBe(loweredNoticeLine("advisory"));
  });

  it("09's advisory mock: the lowered text moves into the header, the finding lines stay", () => {
    const adapter = [loweredNoticeLine("advisory"), HEADER, ...FILLER].join("\n");
    expect(foldClaudeNotice(adapter)).toBe([`${HEADER} · enforcement is lowered in this session (advisory)`, ...FILLER].join("\n"));
  });

  it("a header with its findings and no lowered line is unchanged", () => {
    const n = [HEADER, ...FILLER].join("\n");
    expect(foldClaudeNotice(n)).toBe(n);
  });

  it("at most three finding lines, then '…and N more' counting the lines cut and the adapter's own '+k more'", () => {
    const rows = ["  a", "  b", "  c", "  d", "  e"];
    expect(foldClaudeNotice([HEADER, ...rows].join("\n"))).toBe([HEADER, "  a", "  b", "  c", "  …and 2 more"].join("\n"));
    expect(foldClaudeNotice([HEADER, ...rows, "  +4 more"].join("\n"))).toBe([HEADER, "  a", "  b", "  c", "  …and 6 more"].join("\n"));
    expect(foldClaudeNotice([HEADER, "  a", "  +2 more"].join("\n"))).toBe([HEADER, "  a", "  …and 2 more"].join("\n"));
    expect(foldClaudeNotice([HEADER, "  a", "  b", "  c"].join("\n"))).toBe([HEADER, "  a", "  b", "  c"].join("\n"));
  });

  it("the lines W3.1 cycle 2 adds join the one notice: could not be re-checked, only the first 100 KB, too long", () => {
    expect(foldClaudeNotice([uncheckedLine(2), truncatedLine()].join("\n"))).toBe(`${uncheckedLine(2)} · only the first 100 KB of prose in this reply was reviewed`);
    expect(foldClaudeNotice([HEADER, ...FILLER, truncatedLine()].join("\n"))).toBe([`${HEADER} · only the first 100 KB of prose in this reply was reviewed`, ...FILLER].join("\n"));
    expect(foldClaudeNotice([loweredNoticeLine("advisory"), tooLongLine()].join("\n"))).toBe("Prosegate · this reply is too long to review; its prose was not checked · enforcement is lowered in this session (advisory)");
  });

  it("once-per-session lines, the lowered text and a long-reply line fold together, in the order the adapter gave them", () => {
    const adapter = [loweredNoticeLine("advisory"), overlaysIgnoredLine("Acme"), debugNoticeLine("/tmp/x"), HEADER, ...FILLER, truncatedLine()].join("\n");
    const folded = foldClaudeNotice(adapter).split("\n");
    expect(folded).toHaveLength(3);
    expect(folded[0]).toBe(
      `${HEADER} · enforcement is lowered in this session (advisory) · your local profiles and rule changes are not used in this session · Acme requires enforcement · debug is on: each turn's text is written to /tmp/x · only the first 100 KB of prose in this reply was reviewed`,
    );
    expect(folded.slice(1)).toEqual(FILLER);
  });

  it("never produces more than one header line or more than four lines", () => {
    const worst = [loweredNoticeLine("off"), overlaysIgnoredLine("Acme"), HEADER, ...Array.from({ length: 12 }, (_, i) => `  row ${String(i)}`), "  +9 more", truncatedLine()].join("\n");
    const lines = foldClaudeNotice(worst).split("\n");
    expect(lines).toHaveLength(5);
    expect(lines.filter((l) => !l.startsWith(" "))).toHaveLength(1);
  });
});
