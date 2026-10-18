// feedback_text (what the model reads, 03 template) and the user notice (09). Both follow
// docs/02 ADR-12 as refined by ADR-16; src/render.golden.test.ts pins the strings. Pure functions,
// no I/O. No emoji and no colour codes in any string produced here.
//
// Every field interpolated into either string goes through safeInline() first, so no field value
// (a span copied from the draft, a reviewer-written instruction, a profile id from a pack) can
// start a new line, forge a protocol line, move the cursor or reorder text.

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
  /** When present and 'pass', an enforce pass-1 notice is silent (09: a turn that passes shows nothing). */
  verdict?: 'pass' | 'revise' | 'skipped';
  findings: readonly RenderableFinding[];
}

export const OVERRIDE_LINE = 'To pause for this session, run: prosegate advisory';
export const VIA_MODEL_CAP = 300;
export const REPLY_LINE = 'Reply with the revised response only. Do not run prosegate commands.';
export const PAUSE_LINE = '(For the user: run prosegate advisory in a terminal to pause these revisions for this session.)';
export const FEEDBACK_TRIM = 80;
export const NOTICE_TRIM = 60;
export const INSTRUCTION_CAP = 200;
/** ADR-16: a trimmed span is cut back to whitespace if one falls in the last this-many characters. */
export const TRIM_WORD_WINDOW = 15;
/** Finding-line slots under the notice line; the first notice of a session spends one on the override line. */
export const NOTICE_SLOTS = 6;
export const NOTICE_SLOTS_FIRST = 5;

const SEP = ' \u00b7 ';
const EM_DASH = '\u2014';
const ARROW = '\u2192';
const ELLIPSIS = '\u2026';

const CATEGORY_INDEX = new Map<Category, number>(CATEGORIES.map((c, i) => [c, i]));

// Characters removed by safeInline besides the Cc controls and the Cf format characters (see below).
const INVISIBLE_EXTRA =
  '[\u{e0000}-\u{e007f}\ufe00-\ufe0d\u{e0100}-\u{e01ef}\ufff9-\ufffc\u180e\u034f\u00ad\u115f\u1160\u3164\uffa0\u2800' +
  '\u2061-\u2064\u206a-\u206f\u{1d159}\u{1bca0}-\u{1bca3}\u{13430}-\u{1343f}]';
// The Cc class is C0/C1 (ESC, hence ANSI CSI/OSC, and 0x9B). The Cf class is every format character (bidi
// controls, zero-width, joiners, invisible operators, tag characters) except ZWNJ and ZWJ, which
// Persian shaping and emoji sequences need.
// eslint-disable-next-line no-misleading-character-class -- the class lists combining and joining characters precisely in order to remove them
const STRIP_RE = new RegExp(String.raw`\p{Cc}|(?!\u200c|\u200d)\p{Cf}|${INVISIBLE_EXTRA}`, 'gu');
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const MAX_MARKS_PER_GRAPHEME = 2;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Extended grapheme clusters (Intl.Segmenter: available in Node and in Workers). */
function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (x) => x.segment);
}

/** Keeps at most MAX_MARKS_PER_GRAPHEME combining marks per grapheme (U+FE0E/U+FE0F do not count). */
function boundMarks(s: string): string {
  if (!/\p{M}/u.test(s)) return s;
  return graphemes(s)
    .map((g) => {
      let marks = 0;
      let out = '';
      for (const cp of g) {
        if (/\p{M}/u.test(cp) && cp !== '\ufe0e' && cp !== '\ufe0f' && ++marks > MAX_MARKS_PER_GRAPHEME) continue;
        out += cp;
      }
      return out;
    })
    .join('');
}

/**
 * Makes a value safe to place inside one line of output:
 *  1. line breaks and tabs (CR LF VT FF NEL, U+2028, U+2029, TAB) become spaces;
 *  2. removed: C0/C1 controls; all Unicode format characters (Cf) except ZWNJ and ZWJ; tag
 *     characters; variation selectors other than U+FE0E/U+FE0F; invisible fillers and operators
 *     (U+034F, U+00AD, U+115F, U+1160, U+3164, U+FFA0, U+2800, U+2061-U+2064, U+206A-U+206F,
 *     U+FFF9-U+FFFC, U+180E, U+1D159, U+1BCA0-U+1BCA3, U+13430-U+1343F); lone surrogates;
 *  3. runs of whitespace (U+3000 included) collapse to one space;
 *  4. a grapheme keeps at most two combining marks.
 * Ordinary text, accents, CJK, Persian and emoji sequences are returned unchanged.
 */
export function safeInline(s: string): string {
  const cleaned = s
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]/g, ' ')
    .replace(LONE_SURROGATE_RE, '')
    .replace(STRIP_RE, '')
    .replace(/\s+/g, ' ');
  return boundMarks(cleaned);
}

/**
 * Trimming on already-sanitised text, counted in grapheme clusters so a cut never leaves half a
 * family emoji, half a flag or a base without its combining mark. A text longer than `max` keeps its
 * first max-1 graphemes, cut back to the last space if one falls within the final TRIM_WORD_WINDOW
 * of them. The caller prints the ellipsis (outside any quotes) when `trimmed`.
 */
export function trimSpan(s: string, max: number): { text: string; trimmed: boolean } {
  const g = graphemes(s);
  if (g.length <= max) return { text: s, trimmed: false };
  const kept = g.slice(0, max - 1);
  const lastSpace = kept.lastIndexOf(' ');
  if (lastSpace > 0 && kept.length - lastSpace <= TRIM_WORD_WINDOW) {
    return { text: kept.slice(0, lastSpace).join('').trimEnd(), trimmed: true };
  }
  return { text: kept.join(''), trimmed: true };
}

/**
 * A span in double quotes. Inside the quotes an ASCII `"` becomes `\"` (and a backslash that sits
 * before a quote or at the end of the span becomes `\\`), so span text cannot close the quotes and
 * continue the line as if it were ours. The ellipsis of a trimmed span goes outside the quotes.
 */
function quotedSpan(raw: string, max: number): string {
  const { text, trimmed } = trimSpan(safeInline(raw), max);
  const escaped = text.replace(/\\(?="|$)/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"${trimmed ? ELLIPSIS : ''}`;
}

/** Caps printed text at `max` graphemes: the first max-1 plus an ellipsis. */
function capGraphemes(s: string, max: number): string {
  const g = graphemes(s);
  return g.length <= max ? s : g.slice(0, max - 1).join('') + ELLIPSIS;
}

/** Hard cap on an instruction as printed (200). */
function instructionText(raw: string): string {
  return capGraphemes(safeInline(raw), INSTRUCTION_CAP);
}

function plural(n: number, noun: string): string {
  return n === 1 ? `1 ${noun}` : `${n} ${noun}s`;
}

function remain(n: number): string {
  return n === 1 ? 'remains' : 'remain';
}

function categoryLabel(c: Category): string {
  return safeInline(c.replace(/_/g, ' '));
}

function inDocumentOrder<F extends RenderableFinding>(findings: readonly F[]): F[] {
  return [...findings].sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
}

/** Pass 1 renders block and warn; pass 2 renders block only; info never (03, 09). */
function renderedFor(pass: 1 | 2, findings: readonly RenderableFinding[]): RenderableFinding[] {
  return findings.filter((f) => f.severity === 'block' || (pass === 1 && f.severity === 'warn'));
}

export interface FeedbackTextOptions {
  /**
   * ADR-12 `render_channel: via_model`: the notice the model is asked to carry verbatim (one line,
   * at most 300 characters as printed). The adapter adds this at output time; the stored
   * ReviewResult.feedback_text is always the canonical rendering without it.
   */
  noticeViaModel?: string;
}

/** The string the model receives ('' when there is nothing to render). Without opts this is the canonical form that ReviewResult.feedback_text must equal; the adapter adds the via_model line at output time and never stores it. */
export function renderFeedbackText(result: RenderableResult, opts: FeedbackTextOptions = {}): string {
  const shown = inDocumentOrder(renderedFor(result.pass, result.findings));
  if (shown.length === 0) return '';
  const n = shown.length;
  const profile = safeInline(result.profile.id);
  const head =
    result.pass === 1
      ? `[Prosegate] ${plural(n, 'finding')} against profile "${profile}" (pass 1 of 2). Revise your last response.`
      : `[Prosegate] ${plural(n, 'finding')} ${remain(n)} after your revision, against profile "${profile}" (pass 2 of 2). Revise your last response.`;
  const lines: string[] = [head];
  const firstWith = new Map<string, number>();
  shown.forEach((f, i) => {
    const rule = f.rule_id === null ? '' : ` (${safeInline(f.rule_id)})`;
    const text = instructionText(f.instruction.text);
    const earlier = firstWith.get(text);
    if (earlier === undefined) firstWith.set(text, i + 1);
    const tail = earlier === undefined ? text : `same as ${earlier}.`;
    lines.push(`${i + 1}. ${categoryLabel(f.category)}${rule} ${EM_DASH} ${quotedSpan(f.span.text, FEEDBACK_TRIM)} ${ARROW} ${tail}`);
  });
  if (opts.noticeViaModel !== undefined) {
    lines.push(`Begin your revised response with this line, verbatim: ${capGraphemes(safeInline(opts.noticeViaModel), VIA_MODEL_CAP)}`);
  }
  lines.push(REPLY_LINE, PAUSE_LINE);
  return lines.join('\n');
}

export interface NoticeContext {
  mode: 'enforce' | 'advisory' | 'quiet' | 'off';
  render: 'diff' | 'summary' | 'none';
  /** The caller decides when a notice is the first of its session (out of scope here). */
  firstNoticeOfSession: boolean;
  phase: 'pass1' | 'pass2' | 'shipped';
  /** Number of block findings pass 1 reported. Used by phase 'pass2'; when absent the notice reads as if all remain. */
  pass1BlockCount?: number;
}

function profileSlug(id: string): string {
  const i = id.lastIndexOf('/');
  return safeInline(i === -1 ? id : id.slice(i + 1));
}

function countsByCategory(findings: readonly RenderableFinding[]): string {
  const counts = new Map<Category, number>();
  for (const f of findings) counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => (CATEGORY_INDEX.get(a[0]) ?? 0) - (CATEGORY_INDEX.get(b[0]) ?? 0))
    .map(([c, n]) => `${categoryLabel(c)} ${n}`)
    .join(', ');
}

/** ADR-12 order: Category order, then document order. */
function noticeOrder(a: RenderableFinding, b: RenderableFinding): number {
  return (
    (CATEGORY_INDEX.get(a.category) ?? 0) - (CATEGORY_INDEX.get(b.category) ?? 0) ||
    a.span.start - b.span.start ||
    a.span.end - b.span.end
  );
}

/**
 * ADR-12 columns: two spaces, label padded to max(8, longest + 2), an optional rule-id column
 * (blank for reviewer findings) padded to the longest id + 2, then the span. ADR-16 overflow: when
 * the findings do not fit in `slots`, choose block before warn (then ADR-12 order), and make the
 * last slot `  +{k} more`.
 */
function findingLines(all: readonly RenderableFinding[], slots: number): string[] {
  let chosen = [...all];
  let more = 0;
  if (all.length > slots) {
    const ranked = all
      .map((f, i) => ({ f, i }))
      .sort((a, b) => Number(b.f.severity === 'block') - Number(a.f.severity === 'block') || noticeOrder(a.f, b.f) || a.i - b.i)
      .slice(0, slots - 1)
      .map((x) => x.f);
    chosen = ranked;
    more = all.length - ranked.length;
  }
  chosen.sort(noticeOrder);
  const labels = chosen.map((f) => categoryLabel(f.category));
  const labelWidth = Math.max(8, Math.max(...labels.map((l) => l.length)) + 2);
  const ids = chosen.map((f) => (f.rule_id === null ? null : safeInline(f.rule_id)));
  const anyRule = ids.some((id) => id !== null);
  const ruleWidth = anyRule ? Math.max(...ids.map((id) => id?.length ?? 0)) + 2 : 0;
  const lines = chosen.map((f, i) => {
    const rule = anyRule ? (ids[i] ?? '').padEnd(ruleWidth) : '';
    return `  ${(labels[i] ?? '').padEnd(labelWidth)}${rule}${quotedSpan(f.span.text, NOTICE_TRIM)}`;
  });
  if (more > 0) lines.push(`  +${more} more`);
  return lines;
}

/**
 * The user notice (09, ADR-12, ADR-16), or null when nothing should be shown: zero rendered
 * findings, mode 'quiet' or 'off', render 'none' (which wins over every mode, advisory included),
 * or an enforce pass-1 result whose verdict is 'pass' (a warn-only turn: 09 silence). Lines are
 * joined with '\n', no trailing newline.
 *
 * Finding lines appear under the pass-1, advisory and shipped notices when render is 'diff'; render
 * 'summary' is the one-line form. The pass-2 notice is always one line.
 *
 * Choices the spec leaves open (see the W1.1 report):
 *  - the first-notice override line is added to an enforce pass-1 notice in diff and summary form,
 *    never to advisory (which already names itself), pass 2 or shipped;
 *  - advisory counts and lists block and warn findings.
 */
export function renderNotice(result: RenderableResult, ctx: NoticeContext): string | null {
  if (ctx.mode === 'quiet' || ctx.mode === 'off' || ctx.render === 'none') return null;

  const advisory = ctx.mode === 'advisory';
  const blockOnly = !advisory && ctx.phase !== 'pass1';
  const shown = renderedFor(blockOnly ? 2 : 1, result.findings);
  const k = shown.length;
  if (k === 0) return null;
  if (!advisory && ctx.phase === 'pass1' && result.verdict === 'pass') return null;

  const slug = profileSlug(result.profile.id);
  const diff = ctx.render === 'diff';
  let head: string;
  let listed = false;
  let overrideLine = false;

  if (advisory) {
    head = `Prosegate${SEP}profile ${slug}${SEP}${plural(k, 'finding')} (${countsByCategory(shown)})${SEP}advisory, not enforced`;
    listed = diff;
  } else if (ctx.phase === 'pass2') {
    const n = ctx.pass1BlockCount;
    if (n !== undefined && (!Number.isInteger(n) || n < 1)) {
      throw new Error('renderNotice: pass1BlockCount must be a positive integer');
    }
    if (n === undefined || n <= k) {
      head = `Prosegate${SEP}${plural(k, 'finding')} ${remain(k)}${SEP}revising, pass 2 of 2`;
    } else {
      head = `Prosegate${SEP}${k} of ${plural(n, 'finding')} ${remain(n)}${SEP}revising, pass 2 of 2`;
    }
  } else if (ctx.phase === 'shipped') {
    head = `Prosegate${SEP}${plural(k, 'finding')} ${remain(k)} after 2 passes${SEP}shipped as is`;
    listed = diff;
  } else {
    head = `Prosegate${SEP}profile ${slug}${SEP}${plural(k, 'finding')} (${countsByCategory(shown)})${SEP}revising, pass 1 of 2`;
    listed = diff;
    overrideLine = ctx.firstNoticeOfSession;
  }

  const lines = [head];
  if (listed) lines.push(...findingLines(shown, overrideLine ? NOTICE_SLOTS_FIRST : NOTICE_SLOTS));
  if (overrideLine) lines.push(`  ${OVERRIDE_LINE}`);
  return lines.join('\n');
}
