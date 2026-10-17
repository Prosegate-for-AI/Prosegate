// feedback_text (what the model reads, 03 template) and the user notice (09). Both follow
// docs/02 ADR-12 exactly; src/render.golden.test.ts pins the strings. Pure functions, no I/O.
// No emoji and no colour codes in any string produced here.

import { CATEGORIES } from './types.js';
import type { Category, Severity } from './types.js';

/** The slice of a result the renderers read. ReviewResult and the lenient result both satisfy it. */
export interface RenderableFinding {
  category: Category;
  rule_id: string | null;
  severity: Severity;
  span: { start: number; end: number; text: string };
  instruction: { text: string };
}

export interface RenderableResult {
  profile: { id: string };
  pass: 1 | 2;
  findings: readonly RenderableFinding[];
}

export const OVERRIDE_LINE = 'Session override: prosegate advisory';
export const REPLY_LINE = `Reply with the revised response only. ${OVERRIDE_LINE}`;
export const FEEDBACK_TRIM = 80;
export const NOTICE_TRIM = 60;
export const NOTICE_MAX_LINES = 6;
export const NOTICE_MAX_LINES_FIRST = 5;

const MID_DOT = '·';
const EM_DASH = '—';
const ARROW = '→';
const ELLIPSIS = '…';
const SEP = ` ${MID_DOT} `;

const CATEGORY_INDEX = new Map<Category, number>(CATEGORIES.map((c, i) => [c, i]));

/** ADR-12: count by Unicode code points; over-long text becomes its first N-1 code points + '…'. */
export function trimCodePoints(s: string, max: number): string {
  const points = Array.from(s);
  if (points.length <= max) return s;
  return points.slice(0, max - 1).join('') + ELLIPSIS;
}

/**
 * A finding line must stay one line (09: one line per finding), so line breaks inside a span or an
 * instruction collapse to a single space. Text without line breaks is untouched.
 */
function oneLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, ' ');
}

function plural(n: number, noun: string): string {
  return n === 1 ? `1 ${noun}` : `${n} ${noun}s`;
}

function inDocumentOrder<F extends RenderableFinding>(findings: readonly F[]): F[] {
  return [...findings].sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
}

/** Pass 1 renders block and warn; pass 2 renders block only; info never (03, 09). */
function renderedFor(pass: 1 | 2, findings: readonly RenderableFinding[]): RenderableFinding[] {
  return findings.filter((f) => f.severity === 'block' || (pass === 1 && f.severity === 'warn'));
}

export interface FeedbackTextOptions {
  /** ADR-12 `render_channel: via_model`: the notice the model is asked to carry verbatim. */
  noticeViaModel?: string;
}

/** The string the model receives. '' when there is nothing to render. */
export function renderFeedbackText(result: RenderableResult, opts: FeedbackTextOptions = {}): string {
  const shown = inDocumentOrder(renderedFor(result.pass, result.findings));
  if (shown.length === 0) return '';
  const lines: string[] = [
    `[Prosegate] ${plural(shown.length, 'finding')} against profile "${result.profile.id}" (pass ${result.pass}/2). Revise your last response.`,
  ];
  shown.forEach((f, i) => {
    const rule = f.rule_id === null ? '' : ` (${f.rule_id})`;
    const span = trimCodePoints(oneLine(f.span.text), FEEDBACK_TRIM);
    lines.push(`${i + 1}. ${f.category}${rule} ${EM_DASH} "${span}" ${ARROW} ${oneLine(f.instruction.text)}`);
  });
  if (opts.noticeViaModel !== undefined) {
    lines.push(`Begin your revised response with this line, verbatim: ${opts.noticeViaModel}`);
  }
  lines.push(REPLY_LINE);
  return lines.join('\n');
}

export interface NoticeContext {
  mode: 'enforce' | 'advisory' | 'quiet' | 'off';
  render: 'diff' | 'summary' | 'none';
  /** The caller decides when a notice is the first of its session (out of scope here). */
  firstNoticeOfSession: boolean;
  phase: 'pass1' | 'pass2' | 'shipped';
  /** Number of block findings pass 1 reported. Required when phase is 'pass2'. */
  pass1BlockCount?: number;
}

function profileSlug(id: string): string {
  const i = id.lastIndexOf('/');
  return i === -1 ? id : id.slice(i + 1);
}

function categoryLabel(c: Category): string {
  return c.replace(/_/g, ' ');
}

function countsByCategory(findings: readonly RenderableFinding[]): string {
  const counts = new Map<Category, number>();
  for (const f of findings) counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => (CATEGORY_INDEX.get(a[0]) ?? 0) - (CATEGORY_INDEX.get(b[0]) ?? 0))
    .map(([c, n]) => `${categoryLabel(c)} ${n}`)
    .join(', ');
}

/** ADR-12 columns: label padded to max(8, longest + 2), then an optional rule-id column, then the span. */
function findingLines(findings: readonly RenderableFinding[]): string[] {
  const labels = findings.map((f) => categoryLabel(f.category));
  const labelWidth = Math.max(8, Math.max(...labels.map((l) => l.length)) + 2);
  const anyRule = findings.some((f) => f.rule_id !== null);
  const ruleWidth = anyRule ? Math.max(...findings.map((f) => f.rule_id?.length ?? 0)) + 2 : 0;
  return findings.map((f, i) => {
    const rule = anyRule ? (f.rule_id ?? '').padEnd(ruleWidth) : '';
    const span = trimCodePoints(oneLine(f.span.text), NOTICE_TRIM);
    return `  ${(labels[i] ?? '').padEnd(labelWidth)}${rule}"${span}"`;
  });
}

/**
 * The user notice (09, ADR-12), or null when nothing should be shown: zero rendered findings,
 * mode 'quiet' or 'off', or render 'none'. Lines are joined with '\n', no trailing newline.
 *
 * Choices the spec leaves open (see the W1.1 report):
 *  - advisory mode always renders the summary form (09: "shown in `summary` form"), whatever
 *    `render` says, and never adds the override line (advisory is already what it names);
 *  - pass2 and shipped notices are single lines whatever `render` says (09 "Pass cap");
 *  - the first-notice override line is added to an enforce pass-1 notice in diff and summary form.
 */
export function renderNotice(result: RenderableResult, ctx: NoticeContext): string | null {
  if (ctx.mode === 'quiet' || ctx.mode === 'off' || ctx.render === 'none') return null;

  const advisory = ctx.mode === 'advisory';
  const blockOnly = !advisory && ctx.phase !== 'pass1';
  const pass: 1 | 2 = blockOnly ? 2 : 1;
  const shown = renderedFor(pass, result.findings);
  const k = shown.length;
  if (k === 0) return null;

  const slug = profileSlug(result.profile.id);

  if (advisory) {
    return `Prosegate${SEP}profile ${slug}${SEP}${plural(k, 'finding')} (${countsByCategory(shown)})${SEP}advisory, not enforced`;
  }

  if (ctx.phase === 'pass2') {
    const n = ctx.pass1BlockCount;
    if (n === undefined || !Number.isInteger(n) || n < 1) {
      throw new Error("renderNotice: phase 'pass2' requires pass1BlockCount (a positive integer)");
    }
    const verb = n === 1 ? 'remains' : 'remain';
    return `Prosegate${SEP}${k} of ${plural(n, 'finding')} ${verb}${SEP}revising, pass 2 of 2`;
  }

  if (ctx.phase === 'shipped') {
    const verb = k === 1 ? 'remains' : 'remain';
    return `Prosegate${SEP}${plural(k, 'finding')} ${verb} after 2 passes${SEP}shipped as is`;
  }

  const lines = [
    `Prosegate${SEP}profile ${slug}${SEP}${plural(k, 'finding')} (${countsByCategory(shown)})${SEP}revising, pass 1 of 2`,
  ];
  if (ctx.render === 'diff') {
    const ordered = shown
      .map((f, i) => ({ f, i }))
      .sort(
        (a, b) =>
          (CATEGORY_INDEX.get(a.f.category) ?? 0) - (CATEGORY_INDEX.get(b.f.category) ?? 0) ||
          a.f.span.start - b.f.span.start ||
          a.f.span.end - b.f.span.end ||
          a.i - b.i,
      )
      .map((x) => x.f);
    const cap = ctx.firstNoticeOfSession ? NOTICE_MAX_LINES_FIRST : NOTICE_MAX_LINES;
    lines.push(...findingLines(ordered.slice(0, cap)));
  }
  if (ctx.firstNoticeOfSession) lines.push(`  ${OVERRIDE_LINE}`);
  return lines.join('\n');
}
