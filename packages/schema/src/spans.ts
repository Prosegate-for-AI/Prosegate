interface SpanLike {
  span: { start: number; end: number; text: string };
}

/**
 * 03: "text must equal the slice; consumers drop mismatches". Exact comparison of
 * text.slice(start, end) with span.text, in UTF-16 code units. No normalisation of any kind.
 */
export function spanMatches(text: string, finding: SpanLike): boolean {
  const { start, end, text: spanText } = finding.span;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) {
    return false;
  }
  return text.slice(start, end) === spanText;
}

/** Keeps findings whose span matches the text, preserving order; the input array is not mutated. */
export function dropMismatchedSpans<F extends SpanLike>(text: string, findings: readonly F[]): F[] {
  return findings.filter((f) => spanMatches(text, f));
}
