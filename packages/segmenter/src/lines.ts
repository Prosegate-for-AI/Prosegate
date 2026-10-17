/** Line model and character predicates shared by the block scanner and the inline passes. */

export interface Line {
  /** Offset of the first code unit of the line. */
  s: number;
  /** End of the line content, before the line break. */
  ce: number;
  /** End including the line break (`\r\n`, `\n` or a lone `\r`). */
  e: number;
}

/** JS `\s`: used for trimming and for "is this line blank". */
export function isWs(c: number): boolean {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

export function isAsciiAlnum(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

export function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

export function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/** Split into lines. `\r\n` is one break; a lone `\r` is also a break; no line is produced after a final break. */
export function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  const n = text.length;
  let s = 0;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      lines.push({ s, ce: i, e: i + 1 });
      s = i + 1;
      i = s;
    } else if (c === 13) {
      const e = i + 1 < n && text.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
      lines.push({ s, ce: i, e });
      s = e;
      i = e;
    } else {
      i++;
    }
  }
  if (s < n) lines.push({ s, ce: n, e: n });
  return lines;
}

export function isBlankRange(text: string, s: number, e: number): boolean {
  for (let i = s; i < e; i++) if (!isWs(text.charCodeAt(i))) return false;
  return true;
}

/** First index in [s, e) that is not whitespace, or e. */
export function skipWs(text: string, s: number, e: number): number {
  let i = s;
  while (i < e && isWs(text.charCodeAt(i))) i++;
  return i;
}

/** One past the last non-whitespace code unit in [s, e), or s. */
export function trimEnd(text: string, s: number, e: number): number {
  let i = e;
  while (i > s && isWs(text.charCodeAt(i - 1))) i--;
  return i;
}
