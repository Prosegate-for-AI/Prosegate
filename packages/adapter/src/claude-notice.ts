// One notice per turn on Claude Code's allow path (ADR-33). Claude Code prefixes every line of a `systemMessage` with
// "Stop says: ", so the adapter's several lines (the lowered-enforcement line, once-per-session lines, the review notice with
// its finding lines, the long-reply line) would read as several notices. The shim folds them: the first review notice (or the
// first line) is the header, every other single line joins it after " · ", and at most three finding lines follow, then
// "  …and N more". A notice that is only single lines becomes one line. The adapter's own notice is unchanged for harnesses
// with a channel of their own.

const LOWERED = /^Prosegate · (enforcement is lowered in this session \(.+\)) · prosegate status$/;
const MORE_MARKER = /^ {2}\+(\d+) more$/;
const REVIEW_HEADER = /could not be re-checked|shipped as is|revising, pass|advisory, not enforced|finding(s)? (remain|\()/;
export const MAX_FINDING_LINES = 3;

interface Block {
  header: string;
  rows: string[];
}

function blocks(lines: readonly string[]): Block[] {
  const out: Block[] = [];
  for (const line of lines) {
    if (line.startsWith(" ") && out.length > 0) (out[out.length - 1] as Block).rows.push(line);
    else out.push({ header: line, rows: [] });
  }
  return out;
}

/** Folds the adapter's multi-line `notice` into the single notice Claude Code shows. */
export function foldClaudeNotice(notice: string): string {
  const all = blocks(notice.split("\n").filter((l) => l !== ""));
  if (all.length <= 1 && all[0]?.rows.length === 0) return notice;
  const withRows = all.filter((b) => b.rows.length > 0).at(-1);
  const others = all.filter((b) => !LOWERED.test(b.header));
  const primary = withRows ?? others.find((b) => REVIEW_HEADER.test(b.header)) ?? others[0] ?? (all[0] as Block);
  const tail = all
    .filter((b) => b !== primary)
    .map((b) => {
      const lowered = LOWERED.exec(b.header);
      return lowered?.[1] ?? b.header.replace(/^Prosegate · /, "");
    });
  // A lowered line standing alone keeps its pointer to `prosegate status`; folded into a header it is shortened to the fact.
  const header = tail.length === 0 ? primary.header : [primary.header, ...tail].join(" · ");
  let hidden = 0;
  const shown: string[] = [];
  for (const row of primary.rows) {
    const marker = MORE_MARKER.exec(row);
    if (marker !== null) hidden += Number(marker[1]);
    else if (shown.length < MAX_FINDING_LINES) shown.push(row);
    else hidden += 1;
  }
  return [header, ...shown, ...(hidden > 0 ? [`  …and ${hidden} more`] : [])].join("\n");
}
