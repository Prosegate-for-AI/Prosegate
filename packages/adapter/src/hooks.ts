// The three hook entry points (05): session-start, turn-start, turn-end. Each takes its parsed input
// and a Ctx and returns the JSON the shim reads. Nothing here writes to the process; the caller
// prints the output and maps any exception to fail-open (exit 1).

import { PackVersionError, reviewRulesDetailed } from "@prosegate/engine";
import { BUNDLED_PROFILE_YAML, type ResolvedProfile } from "@prosegate/profiles";
import { type Category, type ReviewRequest, type ReviewResult, renderNotice } from "@prosegate/schema";
import { countWords } from "@prosegate/segmenter";
import { ENGINE_BUDGET_MAX_MS, reviewCap, type Ctx } from "./ctx.js";
import { sleepSync, sweepTempFiles } from "./fs-secure.js";
import {
  buildInject,
  debugNoticeLine,
  overlaysIgnoredLine,
  profileUpdatedLine,
  resolutionIssueLine,
  tooLongLine,
  truncatedLine,
  uncheckedLine,
} from "./inject.js";
import { loweredNoticeLine, lowerFor } from "./lowering.js";
import { log } from "./log.js";
import { effectiveMode, renderFor, type EffectiveMode } from "./modes.js";
import {
  baseProfileId,
  integerVersion,
  profileSummary,
  profileUpdate,
  resolveAndLoad,
} from "./profiles.js";
import { buildTurnReport, summaryLine } from "./report.js";
import type { LastTurn, SessionStartInput, SessionState, TurnEndInput, TurnRecord, TurnStartInput } from "./schemas.js";
import {
  SessionStore,
  defaultState,
  deriveTurnId,
  normaliseCwd,
  readCwdProfiles,
  readProfileVersions,
  rememberProfileVersion,
  sweepLeftovers,
  sweepSessions,
  turnKey,
} from "./store.js";
import { INIT_CHECK_SESSION } from "./init-check.js";
import { withFakeReviewer } from "./test-seam.js";
import { timed, timingsLine } from "./timing.js";
import {
  enforcementEvent,
  errorEvent,
  isKnownHarness,
  recordEvents,
  reviewEvent,
  sessionStartEvent,
  type TelemetryDraft,
} from "./telemetry.js";

/** ADR-30: a reply is reviewed up to this much prose; the rest is not, and the user can see that (status, telemetry). */
export const MAX_PROSE_REVIEWED = 100 * 1024;
export const USER_MESSAGE_MAX = 2000;
/** A turn's pass record is forgotten this long after its last update (ADR-31). */
export const TURN_RECORD_TTL_MS = 60 * 60 * 1000;

export interface SessionStartOutput {
  inject: string;
  /** Lines for the user, never the model (ADR-28). */
  notice: string | null;
  active_profile: string;
  offline: boolean;
}
export interface TurnStartOutput {
  inject: string | null;
  candidate: string | null;
}
export interface TurnEndOutput {
  decision: "allow" | "continue";
  feedback_text: string;
  render: "diff" | "summary" | "none";
  result: ReviewResult;
  notice: string | null;
}

/** What a handler wants written to stderr besides its JSON (the debug warning). */
export interface HandlerOutcome<T> {
  output: T;
  stderr: string[];
}

export function trimUserMessage(text: string): string {
  if (text.length <= USER_MESSAGE_MAX) return text;
  const cut = text.slice(0, USER_MESSAGE_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function crashIfAsked(ctx: Ctx, stage: string): void {
  const asked = ctx.testHooks.crash;
  if (asked === stage) throw new Error(`injected crash in ${stage}`);
  // Exceptions that escape the hook's own catch, to exercise the last-resort handlers in cli.ts.
  if (asked === `${stage}:escape`) setTimeout(() => { throw new Error(`injected escape in ${stage}`); }, 0);
  if (asked === `${stage}:reject`) void Promise.reject(new Error(`injected rejection in ${stage}`));
}

function requestedProfile(ctx: Ctx, cwd: string): string {
  return readCwdProfiles(ctx)[normaliseCwd(ctx, cwd)]?.profile ?? baseProfileId(ctx);
}

/** The profile's cap on revisions (04: 1 or 2). Notices say "pass k of <cap>" (ADR-31). */
function passCapOf(resolved: ResolvedProfile): 1 | 2 {
  return resolved.enforcement.pass_cap;
}

/** The schema renderers say "of 2" and "after 2 passes"; a profile with pass_cap 1 reads "of 1" and "after 1 pass". */
function withCap(text: string, cap: 1 | 2): string {
  return cap === 2 ? text : text.replace(/pass (\d) of 2/g, `pass $1 of ${cap}`).replace(/after 2 passes/g, "after 1 pass");
}

function suppressesNotices(eff: EffectiveMode): boolean {
  return eff.headless || eff.mode === "quiet" || eff.mode === "off";
}

// ---- session-start --------------------------------------------------------------------------------

export function sessionStart(input: SessionStartInput, ctx: Ctx): HandlerOutcome<SessionStartOutput> {
  crashIfAsked(ctx, "session-start");
  const source = input.source ?? "startup";
  // ADR-31: modes reset on startup and clear (09 "cleared at next session start") and survive resume, compact and fork;
  // compact fires mid-turn and never touches pass counts.
  const fresh = source === "startup" || source === "clear";
  const store = new SessionStore(ctx, input.session_id);
  store.ensure();
  const existing = store.readState();
  const requested = !fresh && existing !== null ? existing.active_profile : requestedProfile(ctx, input.cwd);
  const loaded = resolveAndLoad(ctx, requested);
  const { resolved } = loaded;

  const summary = profileSummary(resolved, loaded.bodies);
  const prior = readProfileVersions(ctx)[resolved.id];
  const lines: string[] = [];
  const versionNow = integerVersion(resolved.version);
  if (prior !== undefined) {
    const update = profileUpdate(prior, { version: versionNow, summary });
    if (update.fires) lines.push(profileUpdatedLine(resolved.id, versionNow, update.rulesChanged));
  }
  rememberProfileVersion(ctx, resolved.id, versionNow, summary);

  const init = { session_id: input.session_id, harness: input.harness, cwd: input.cwd, context_mode: input.mode, active_profile: requested };
  const base = existing ?? defaultState(ctx, init);
  const kept = fresh ? defaultState(ctx, init) : base;
  const provisional: SessionState = {
    ...kept,
    harness: input.harness,
    cwd: input.cwd,
    context_mode: input.mode,
    active_profile: requested,
    // The integrity record (ADR-30): taken at session start, not at compact.
    local_hashes: source === "compact" && existing !== null ? existing.local_hashes : loaded.local.hashes,
    last_seen_profile_version: prior?.version ?? kept.last_seen_profile_version,
    created_at: fresh ? ctx.now() : base.created_at,
  };
  const eff = effectiveMode(ctx, provisional, resolved);
  const lowering = lowerFor(ctx, provisional, eff, loaded);
  const quiet = suppressesNotices(eff);

  const showOverlays = !quiet && resolved.overlays_ignored && !provisional.overlays_notice_shown && resolved.policy !== null;
  if (showOverlays && resolved.policy !== null) lines.push(overlaysIgnoredLine(resolved.policy.org_name));
  const issueLine = resolutionIssueLine(loaded.issues);
  const showIssue = !quiet && issueLine !== null && !provisional.resolution_notice_shown;
  if (showIssue && issueLine !== null) lines.push(issueLine);
  const debugDir = ctx.debug && !eff.headless && !provisional.debug_notice_shown;
  if (debugDir) lines.push(debugNoticeLine(`${store.dir}`));
  // The "already shown" record starts over at every session start (ADR-30): a state.json edit made in one
  // session cannot keep the line from the next. The record only suppresses repeats inside a session.
  const showLowered = !eff.headless && lowering.what !== "";
  if (showLowered) lines.unshift(loweredNoticeLine(lowering.what));

  store.updateState(
    () => provisional,
    () => ({
      ...provisional,
      overlays_notice_shown: provisional.overlays_notice_shown || showOverlays,
      resolution_notice_shown: provisional.resolution_notice_shown || showIssue,
      debug_notice_shown: provisional.debug_notice_shown || debugDir,
      lowered_shown: showLowered ? lowering.what : "",
    }),
  );
  store.writeProfileCache(resolved);
  sweepSessions(ctx, input.session_id);
  sweepLeftovers(ctx);

  const events: TelemetryDraft[] = [];
  if (isKnownHarness(input.harness) && input.session_id !== INIT_CHECK_SESSION) {
    const profileCount = new Set([...Object.keys(loaded.local.profiles), ...Object.keys(BUNDLED_PROFILE_YAML)]).size;
    events.push(sessionStartEvent({ harness: input.harness, profileCount, offline: true }));
  }
  if (loaded.fellBack) events.push(errorEvent("profile_resolution_failed"));
  if (showLowered) events.push(enforcementEvent({ decision: "allow", overrideUsed: true }));
  recordEvents(ctx, events);

  return {
    output: { inject: buildInject(resolved), notice: lines.length === 0 ? null : lines.join("\n"), active_profile: resolved.id, offline: true },
    stderr: [],
  };
}

// ---- turn-start -----------------------------------------------------------------------------------

export function turnStart(input: TurnStartInput, ctx: Ctx): HandlerOutcome<TurnStartOutput> {
  crashIfAsked(ctx, "turn-start");
  const store = new SessionStore(ctx, input.session_id);
  const message = trimUserMessage(input.user_message);
  const turnId = input.turn_id !== undefined && input.turn_id !== null && input.turn_id !== "" ? input.turn_id : deriveTurnId(input.session_id, input.user_message);
  // Replaces any earlier turn.json, a stale one included (ADR-31).
  store.writeTurn({ turn_id: turnId, user_message: message, ts: ctx.now() });
  try {
    sweepTempFiles(store.dir, ctx.now());
  } catch {
    // a leftover temp file is swept at the next session start
  }
  const key = turnKey(turnId);
  const now = ctx.now();
  store.updateState(
    () => defaultState(ctx, { session_id: input.session_id, harness: "unknown", cwd: ctx.cwd, context_mode: "interactive", active_profile: requestedProfile(ctx, ctx.cwd) }),
    // turn-start never resets a turn's pass count (ADR-31): anything that can run `prosegate turn-start`
    // could otherwise reset the real turn in the middle of a revision. It creates an empty record for its
    // own turn id if there is none, and forgets records an hour old. A repeated message is a new turn
    // because its Stop arrives with continuation=false (see turnEnd).
    (s) => {
      const turns = Object.fromEntries(Object.entries(s.turns).filter(([, r]) => now - r.updated_at < TURN_RECORD_TTL_MS));
      if (!Object.hasOwn(turns, key)) turns[key] = { ...EMPTY_RECORD, updated_at: now };
      return { ...s, turns };
    },
  );
  // Selection heuristics are Phase 5 (04 "Selection and hysteresis"): nothing to inject yet.
  return { output: { inject: null, candidate: null }, stderr: [] };
}

// ---- turn-end -------------------------------------------------------------------------------------

function skippedResult(
  resolved: ResolvedProfile,
  pass: 1 | 2,
  reason: NonNullable<ReviewResult["skipped_reason"]>,
): ReviewResult {
  return {
    schema: "prosegate.findings/1",
    verdict: "skipped",
    skipped_reason: reason,
    profile: { id: resolved.id, version: resolved.version, resolved_from: [...resolved.resolved_from] },
    pass,
    segments: [],
    findings: [],
    cleared: [],
    stats: {
      prose_chars: 0,
      sentence_count: 0,
      findings_by_category: {},
      rule_packs: resolved.packs.map((p) => ({ id: p.id, version: p.version })),
      reviewer: null,
      rules_latency_ms: 0,
    },
    feedback_text: "",
  };
}

function proseWords(result: ReviewResult, text: string): number {
  let n = 0;
  for (const s of result.segments) if (s.kind === "prose") n += countWords(text.slice(s.start, s.end));
  return n;
}

const EMPTY_RECORD: TurnRecord = { count: 0, pass1: [], pass1_block_count: 0, profile_id: "", profile_version: "", shipped_shown: false, updated_at: 0 };

export function turnEnd(input: TurnEndInput, ctx: Ctx): HandlerOutcome<TurnEndOutput> {
  try {
    return turnEndInner(input, ctx);
  } catch (error) {
    // The hook fails open (the reply is not held), so the turn is over: its user message must not outlive it (ADR-31).
    try {
      new SessionStore(ctx, input.session_id).deleteTurn();
    } catch {
      // swept at the next session start
    }
    throw error;
  }
}

function turnEndInner(input: TurnEndInput, ctx: Ctx): HandlerOutcome<TurnEndOutput> {
  crashIfAsked(ctx, "turn-end");
  const startupMs = ctx.elapsedMs();
  const store = new SessionStore(ctx, input.session_id);
  const existing = timed("store", () => store.readState());
  const turnFile = timed("store", () => store.readTurn());
  const stderr: string[] = [];

  // Live hook input outranks the stored turn.json (ADR-29): a stale file must not stand in for a turn-start that failed.
  const liveMessage = input.user_message ?? "";
  const userMessage = trimUserMessage(liveMessage !== "" ? liveMessage : (turnFile?.user_message ?? ""));
  const shimId = input.turn_id !== undefined && input.turn_id !== null && input.turn_id !== "" ? input.turn_id : null;
  const turnId = shimId ?? (liveMessage !== "" ? deriveTurnId(input.session_id, liveMessage) : (turnFile?.turn_id ?? deriveTurnId(input.session_id, "")));
  const key = turnKey(turnId);

  const fresh = (): SessionState =>
    defaultState(ctx, { session_id: input.session_id, harness: "unknown", cwd: ctx.cwd, context_mode: "interactive", active_profile: requestedProfile(ctx, ctx.cwd) });
  const state = existing ?? fresh();

  let rec: TurnRecord = state.turns[key] ?? EMPTY_RECORD;
  if (input.continuation === false && rec.count > 0) {
    if (shimId === null) {
      // Our own continuation always arrives with continuation=true, so with no shim turn id this is a new turn (ADR-30, ADR-31).
      log(ctx, "warn", "turn_reset", "continuation=false with a pass count and no turn id: treated as a new turn");
      rec = EMPTY_RECORD;
    } else {
      log(ctx, "warn", "continuation_mismatch", "the harness says this is not a continuation but a pass count exists; the count wins");
    }
  }

  // The profile is fixed for the turn: pass 2 and the cap check use the profile pass 1 used (ADR-31).
  const activeId = rec.count > 0 && rec.profile_id !== "" ? rec.profile_id : state.active_profile;
  // Re-resolved at every turn-end from bundled and local sources; profile.json is not consulted (ADR-19).
  const loaded = resolveAndLoad(ctx, activeId, (r) => effectiveMode(ctx, state, r).mode === "off");
  const { resolved } = loaded;
  const eff = effectiveMode(ctx, state, resolved);
  const cap = passCapOf(resolved);
  const stateForLowering = existing === null ? { ...state, local_hashes: loaded.local.hashes } : state;
  const lowering = lowerFor(ctx, stateForLowering, eff, loaded);
  const lowered = lowering.what !== "";
  const events: TelemetryDraft[] = [];
  if (loaded.fellBack) events.push(errorEvent("profile_resolution_failed"));

  const pass: 1 | 2 = rec.count === 0 ? 1 : 2;
  const capCheck = rec.count >= cap;

  // The text of this turn, for --debug only (07): written locally; the user is told through `notice`.
  let debugDir: string | null = null;
  if (ctx.debug) {
    debugDir = store.writeDebug(`${key}-${ctx.now()}`, { turn_id: turnId, user_message: userMessage, assistant_text: input.assistant_text });
    stderr.push(`prosegate: --debug wrote this turn's text to ${debugDir}; delete it when you are done.`);
  }

  let result: ReviewResult;
  let reviewed = false;
  let truncated = false;
  let decision: "allow" | "continue" = "allow";
  let skippedWhy: "off" | "budget" | null = null;

  if (eff.mode === "off") {
    skippedWhy = "off";
    // 03 has no `off` reason; `advisory_mode` is the closest ("reviewing is not enforced here").
    result = skippedResult(resolved, pass, "advisory_mode");
  } else {
    if (ctx.testHooks.delayMs !== undefined) sleepSync(ctx.testHooks.delayMs);
    const cutoff = reviewCap(ctx);
    const trip = (code: "turn_budget_exceeded" | "pack_rejected", why: string): ReviewResult => {
      skippedWhy = "budget";
      events.push(errorEvent(code));
      log(ctx, "warn", code, why);
      return skippedResult(resolved, pass, "reviewer_unavailable");
    };
    if (ctx.elapsedMs() > cutoff) {
      result = trip("turn_budget_exceeded", "the 6 s cap was spent before the review started");
    } else {
      const request: ReviewRequest = {
        schema: "prosegate.review/1",
        text: input.assistant_text,
        context: {
          user_message: userMessage,
          // The shim has no CLAUDE.md access in v0; style constraints are deferred (brief, W3.1 report).
          style_constraints: "",
          mode: eff.headless ? "headless" : "interactive",
        },
        profile_id: resolved.id,
        pass,
        stages: ["rules"],
        session_id: input.session_id,
        turn_id: turnId,
        prior_findings: pass === 2 ? rec.pass1.map((f) => f.id) : [],
      };
      const enforce = eff.mode === "enforce" || eff.mode === "quiet";
      // ADR-29: the engine gets the time left under the 6 s cap, at most 2 s. The 200 ms of 10 is a publish-time gate.
      const budgetMs = ctx.testHooks.engineBudgetMs ?? Math.max(100, Math.min(ENGINE_BUDGET_MAX_MS, cutoff - ctx.elapsedMs()));
      try {
        const detailed = timed("review", () =>
          reviewRulesDetailed({ request, resolved, packs: loaded.packs, enforce, capCheck, budgetMs, maxProseChars: MAX_PROSE_REVIEWED }),
        );
        if (detailed.diagnostics.budget_exceeded) {
          // The engine returns partial results on a budget trip; a partial review must not continue the model.
          result = trip("turn_budget_exceeded", "the engine budget ran out during the review");
        } else if (ctx.elapsedMs() > cutoff) {
          result = trip("turn_budget_exceeded", "the review finished after the 6 s cap");
        } else {
          result = detailed.result;
          result = withFakeReviewer(result, ctx, { text: input.assistant_text, pass, capCheck, enforce, priorIds: request.prior_findings, profileId: resolved.id });
          reviewed = true;
          truncated = detailed.diagnostics.truncated;
          if (truncated) {
            events.push(errorEvent("turn_truncated"));
            log(ctx, "info", "turn_truncated", "only the first part of a long reply was reviewed");
          }
        }
      } catch (error) {
        if (!(error instanceof PackVersionError)) throw error;
        result = trip("pack_rejected", "a loaded pack is not the version the profile pinned");
      }
    }
  }

  // N7: a revision (or the cap check) with no prose units, for instance the reply moved into a blockquote or
  // an indented block, cannot show that anything was fixed. The engine reports every earlier finding as gone;
  // nothing is cleared, and the turn ships with those findings as the remainder.
  const recheckFailed = reviewed && pass === 2 && rec.pass1.length > 0 && result.stats.prose_chars === 0;
  if (recheckFailed) result = { ...result, cleared: [] };
  const unrechecked = recheckFailed ? rec.pass1.length : 0;

  const continueSupported = input.continue_supported !== false;
  let wouldContinue = reviewed && !capCheck && result.verdict === "revise";
  if (wouldContinue && !continueSupported) wouldContinue = false;
  if (wouldContinue) decision = "continue";
  const enforcementUnavailable = reviewed && !capCheck && result.verdict === "revise" && !continueSupported;

  // ---- notice ---------------------------------------------------------------------------------
  const phase = capCheck ? "shipped" : pass === 2 ? "pass2" : "pass1";
  const render = reviewed ? renderFor(eff, resolved, phase) : "none";
  let reviewNotice: string | null = null;
  if (recheckFailed) {
    // The shipped line, worded for what happened; it shows once per turn, like the cap's own (ADR-31).
    if (!eff.headless && eff.mode === "enforce" && !rec.shipped_shown) reviewNotice = uncheckedLine(unrechecked);
  } else if (reviewed && !eff.headless && !(capCheck && rec.shipped_shown)) {
    reviewNotice = renderNotice(result, {
      mode: eff.mode,
      render,
      firstNoticeOfSession: !state.first_notice_shown,
      phase,
      ...(rec.pass1_block_count > 0 ? { pass1BlockCount: rec.pass1_block_count } : {}),
    });
    if (reviewNotice !== null) reviewNotice = withCap(reviewNotice, cap);
  }
  const firstNoticeSpent = reviewNotice !== null && !recheckFailed && phase === "pass1" && eff.mode === "enforce";
  const shippedShownNow = (capCheck || recheckFailed) && (reviewNotice !== null || (eff.headless && reviewed));

  // Once-per-session lines (09, ADR-18, ADR-30) wait for a turn with no review notice of its own and are
  // hidden in quiet, off and headless; the lowered-enforcement and debug lines are about the user's own
  // safety and show in every mode but headless.
  const extra: string[] = [];
  let spentResolution = false;
  let spentOverlays = false;
  if (reviewNotice === null && decision === "allow" && !suppressesNotices(eff)) {
    const line = resolutionIssueLine(loaded.issues);
    if (!state.resolution_notice_shown && line !== null) {
      extra.push(line);
      spentResolution = true;
    }
    if (!state.overlays_notice_shown && resolved.overlays_ignored && resolved.policy !== null) {
      extra.push(overlaysIgnoredLine(resolved.policy.org_name));
      spentOverlays = true;
    }
  }
  const showLowered = !eff.headless && lowered && lowering.what !== state.lowered_shown;
  const showDebug = !eff.headless && ctx.debug && !state.debug_notice_shown && debugDir !== null;
  if (showDebug && debugDir !== null) extra.push(debugNoticeLine(debugDir));
  // N9: a reply longer than the review limit was only partly read. The user is told on the allow (or the next one,
  // when this turn asks for a revision), in every mode but headless, whose report carries the same fact.
  const truncatedHere = truncated && reviewed;
  const nothingRead = truncatedHere && result.verdict === "skipped";
  const showTruncated = !eff.headless && decision === "allow" && (truncatedHere || state.truncated_pending === true);
  const truncatedNotice = showTruncated ? (nothingRead ? tooLongLine() : truncatedLine()) : null;
  const noticeLines = [
    ...(showLowered ? [loweredNoticeLine(lowering.what)] : []),
    ...extra,
    ...(reviewNotice === null ? [] : [reviewNotice]),
    ...(truncatedNotice === null ? [] : [truncatedNotice]),
  ];
  const notice = noticeLines.length === 0 ? null : noticeLines.join("\n");

  // ---- last-turn summary for `status` -----------------------------------------------------------
  const count = result.findings.length;
  let outcome: LastTurn["outcome"];
  if (skippedWhy === "off") outcome = "off";
  else if (skippedWhy === "budget") outcome = "budget";
  else if (recheckFailed) outcome = "shipped";
  else if (result.verdict === "skipped") outcome = nothingRead ? "too_long" : result.skipped_reason === "below_floor" ? "too_short" : "no_prose";
  else if (truncated) outcome = "truncated";
  else if (eff.mode === "advisory") outcome = "advisory";
  else if (decision === "continue") outcome = "revised";
  else if (capCheck && count > 0) outcome = "shipped";
  else outcome = "clean";
  const newCount = decision === "continue" ? rec.count + 1 : rec.count;
  const lastTurn: LastTurn = { outcome, findings: reviewed ? Math.max(count, rec.pass1.length) : 0, fixed: reviewed ? result.cleared.length : 0, remaining: reviewed ? (recheckFailed ? unrechecked : count) : 0, revisions: Math.min(2, newCount) };

  // ---- persist --------------------------------------------------------------------------------
  const pass1 = pass === 1 && reviewed ? result.findings.map((f) => ({ id: f.id, category: f.category })) : rec.pass1;
  const pass1BlockCount = pass === 1 && reviewed ? result.findings.filter((f) => f.severity === "block").length : rec.pass1_block_count;
  const pinned = rec.count > 0 && rec.profile_id !== "";
  const nextRecord: TurnRecord = {
    count: newCount,
    pass1,
    pass1_block_count: pass1BlockCount,
    profile_id: pinned ? rec.profile_id : resolved.id,
    profile_version: pinned ? rec.profile_version : resolved.version,
    shipped_shown: rec.shipped_shown || shippedShownNow,
    updated_at: ctx.now(),
  };
  const ordinalAfter = reviewed && pass === 1 ? state.turn_ordinal + 1 : state.turn_ordinal;
  const saved = timed("store", () =>
    store.updateState(
      () => stateForLowering,
      (s) => ({
        ...s,
        turns: reviewed || decision === "continue" ? { ...s.turns, [key]: nextRecord } : s.turns,
        first_notice_shown: s.first_notice_shown || firstNoticeSpent,
        resolution_notice_shown: s.resolution_notice_shown || spentResolution,
        overlays_notice_shown: s.overlays_notice_shown || spentOverlays,
        debug_notice_shown: s.debug_notice_shown || showDebug,
        lowered_shown: lowered ? (showLowered ? lowering.what : s.lowered_shown) : "",
        truncated_pending: decision === "allow" ? false : s.truncated_pending === true || truncatedHere,
        turn_ordinal: Math.max(s.turn_ordinal, ordinalAfter),
        last_turn: reviewed || skippedWhy !== null ? lastTurn : s.last_turn,
      }),
    ),
  );

  // The turn ended: its prose-bearing files go (ADR-31).
  if (decision === "allow") {
    try {
      store.deleteTurn();
      if (!ctx.debug) store.deleteDebug();
    } catch {
      log(ctx, "warn", "retention_failed", "could not delete the turn files");
    }
  }

  // ---- headless report --------------------------------------------------------------------------
  if (eff.headless && reviewed) {
    try {
      const shippedRemaining = capCheck ? result.findings.length : recheckFailed ? unrechecked : 0;
      const entry = buildTurnReport({ turn: key, ordinal: saved.turn_ordinal, result, decision, passes: capCheck ? 2 : pass, shippedRemaining, tooLong: nothingRead, ts: ctx.now() });
      timed("store", () => store.upsertReport(entry));
      // One line per reviewed turn, when the turn ends (09 "Headless and CI"); the shim passes adapter stderr through.
      if (decision === "allow" && !((capCheck || recheckFailed) && rec.shipped_shown)) stderr.push(summaryLine(entry));
    } catch {
      // The decision is already persisted; a report that cannot be written must not undo it.
      log(ctx, "warn", "report_failed", "could not write report.json");
    }
  }

  // ---- telemetry ------------------------------------------------------------------------------
  if (reviewed) {
    const clearedIds = new Set(result.cleared);
    const clearedCategories: Category[] = rec.pass1.filter((f) => clearedIds.has(f.id)).map((f) => f.category);
    events.push(
      reviewEvent({
        profileId: resolved.id,
        pass: result.pass,
        verdict: result.verdict,
        skippedReason: result.skipped_reason,
        proseWords: proseWords(result, input.assistant_text),
        byCategory: result.stats.findings_by_category,
        ruleIds: result.findings.flatMap((f) => (f.rule_id === null ? [] : [f.rule_id])),
        cleared: result.cleared.length,
        clearedCategories,
      }),
    );
  }
  if (skippedWhy === "off") {
    // 09: with enforcement off the only telemetry is override_used.
    timed("telemetry", () => recordEvents(ctx, [enforcementEvent({ decision: "allow", overrideUsed: true })]));
  } else {
    events.push(enforcementEvent({ decision, overrideUsed: lowered, enforcementUnavailable }));
    timed("telemetry", () => recordEvents(ctx, events));
  }

  if (ctx.env["PROSEGATE_TIMINGS"] === "1") stderr.push(timingsLine(startupMs, ctx.elapsedMs()));

  // `render` is what the shim shows the user; a silent allow shows nothing.
  const shown =
    eff.headless && reviewed && render !== "none"
      ? "summary"
      : notice === null && decision === "allow"
        ? "none"
        : render === "none" && notice !== null
          ? "summary"
          : render;
  return {
    output: {
      decision,
      feedback_text: decision === "continue" ? withCap(result.feedback_text, cap) : "",
      render: shown,
      result,
      notice,
    },
    stderr,
  };
}
