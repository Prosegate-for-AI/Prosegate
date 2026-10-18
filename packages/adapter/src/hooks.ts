// The three hook entry points (05): session-start, turn-start, turn-end. Each takes its parsed input
// and a Ctx and returns the JSON the shim reads. Nothing here writes to the process; the caller
// prints the output and maps any exception to fail-open (exit 1).

import { PackVersionError, reviewRulesDetailed } from "@prosegate/engine";
import { BUNDLED_PROFILE_YAML } from "@prosegate/profiles";
import { baseProfileId, profileSummary, resolveAndLoad } from "./profiles.js";
import { type ReviewRequest, type ReviewResult, renderNotice, type Category } from "@prosegate/schema";
import { countWords } from "@prosegate/segmenter";
import type { ResolvedProfile } from "@prosegate/profiles";
import type { Ctx } from "./ctx.js";
import { sleepSync } from "./fs-secure.js";
import { timed, timingsLine } from "./timing.js";
import { buildInject, overlaysIgnoredLine, profileUpdatedLine, resolutionIssueLine } from "./inject.js";
import { log } from "./log.js";
import { effectiveMode, renderFor } from "./modes.js";
import { buildTurnReport } from "./report.js";
import type { SessionStartInput, SessionState, TurnEndInput, TurnStartInput } from "./schemas.js";
import {
  SessionStore,
  defaultState,
  deriveTurnId,
  normaliseCwd,
  readCwdProfiles,
  readProfileVersions,
  rememberProfileVersion,
  sweepSessions,
  turnKey,
} from "./store.js";
import {
  enforcementEvent,
  errorEvent,
  isKnownHarness,
  recordEvents,
  reviewEvent,
  sessionStartEvent,
  type TelemetryDraft,
} from "./telemetry.js";

export const TURN_BUDGET_MS = 6000;
/** Inputs above this much prose skip review (finding 11: a 1.3 MB input ran 0 rules after tripping the budget). */
export const MAX_PROSE_CHARS = 256 * 1024;
export const USER_MESSAGE_MAX = 2000;

export interface SessionStartOutput {
  inject: string;
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
  if (ctx.testHooks.crash === stage) throw new Error(`injected crash in ${stage}`);
}

function requestedProfile(ctx: Ctx, state: SessionState | null, cwd: string): string {
  if (state !== null) return state.active_profile;
  return readCwdProfiles(ctx)[normaliseCwd(ctx, cwd)]?.profile ?? baseProfileId(ctx);
}

// ---- session-start --------------------------------------------------------------------------------

export function sessionStart(input: SessionStartInput, ctx: Ctx): HandlerOutcome<SessionStartOutput> {
  crashIfAsked(ctx, "session-start");
  const store = new SessionStore(ctx, input.session_id);
  store.ensure();
  const existing = store.readState();
  const loaded = resolveAndLoad(ctx, requestedProfile(ctx, existing, input.cwd));
  const { resolved } = loaded;

  const versions = readProfileVersions(ctx);
  const prior = versions[resolved.id];
  const extra: string[] = [];
  if (prior !== undefined && prior.version !== resolved.version) {
    let changes = 0;
    const now = profileSummary(resolved);
    for (const key of new Set([...Object.keys(prior.summary), ...Object.keys(now)])) if (prior.summary[key] !== now[key]) changes++;
    extra.push(profileUpdatedLine(resolved.id, resolved.version, changes));
  }
  rememberProfileVersion(ctx, resolved.id, resolved.version, profileSummary(resolved));

  const showOverlays = resolved.overlays_ignored && existing?.overlays_notice_shown !== true && resolved.policy !== null;
  if (showOverlays && resolved.policy !== null) extra.push(overlaysIgnoredLine(resolved.policy.org_name));

  const init = {
    session_id: input.session_id,
    harness: input.harness,
    cwd: input.cwd,
    context_mode: input.mode,
    active_profile: requestedProfile(ctx, existing, input.cwd),
  };
  store.updateState(
    () => defaultState(ctx, init),
    (s) => ({
      ...s,
      harness: input.harness,
      cwd: input.cwd,
      context_mode: input.mode,
      overlays_notice_shown: s.overlays_notice_shown || showOverlays,
      last_seen_profile_version: prior?.version ?? s.last_seen_profile_version,
    }),
  );
  store.writeProfileCache(resolved);
  sweepSessions(ctx, input.session_id);

  const events: TelemetryDraft[] = [];
  if (isKnownHarness(input.harness)) {
    const profileCount = new Set([...Object.keys(loaded.local.profiles), ...Object.keys(BUNDLED_PROFILE_YAML)]).size;
    events.push(sessionStartEvent({ harness: input.harness, profileCount, offline: true }));
  }
  if (loaded.fellBack) events.push(errorEvent("profile_resolution_failed"));
  recordEvents(ctx, events);

  return {
    output: { inject: buildInject(resolved, extra), active_profile: resolved.id, offline: true },
    stderr: [],
  };
}

// ---- turn-start -----------------------------------------------------------------------------------

export function turnStart(input: TurnStartInput, ctx: Ctx): HandlerOutcome<TurnStartOutput> {
  crashIfAsked(ctx, "turn-start");
  const store = new SessionStore(ctx, input.session_id);
  const message = trimUserMessage(input.user_message);
  store.writeTurn({ turn_id: deriveTurnId(input.session_id, input.user_message), user_message: message, ts: ctx.now() });
  store.updateState(
    () => defaultState(ctx, { session_id: input.session_id, harness: "unknown", cwd: ctx.cwd, context_mode: "interactive", active_profile: requestedProfile(ctx, null, ctx.cwd) }),
    // A new user prompt starts a new turn: every earlier pass count is over. This is what lets a
    // shim that derives turn ids from a hash of the user message repeat a message safely.
    (s) => ({ ...s, turns: {} }),
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

export function turnEnd(input: TurnEndInput, ctx: Ctx): HandlerOutcome<TurnEndOutput> {
  crashIfAsked(ctx, "turn-end");
  const budgetMs = ctx.testHooks.budgetMs ?? TURN_BUDGET_MS;
  const store = new SessionStore(ctx, input.session_id);
  const startupMs = ctx.elapsedMs();
  const existing = timed("store", () => store.readState());
  const turnFile = timed("store", () => store.readTurn());
  const stderr: string[] = [];

  const userMessage = trimUserMessage(turnFile?.user_message ?? input.user_message ?? "");
  const turnId =
    input.turn_id !== undefined && input.turn_id !== null && input.turn_id !== ""
      ? input.turn_id
      : input.user_message !== undefined && input.user_message !== null && input.user_message !== ""
        ? deriveTurnId(input.session_id, input.user_message)
        : (turnFile?.turn_id ?? deriveTurnId(input.session_id, ""));
  const key = turnKey(turnId);

  const requested = requestedProfile(ctx, existing, ctx.cwd);
  const fresh = (): SessionState =>
    defaultState(ctx, { session_id: input.session_id, harness: "unknown", cwd: ctx.cwd, context_mode: "interactive", active_profile: requested });
  const state = existing ?? fresh();

  // Re-resolved at every turn-end from bundled and local sources; profile.json is not consulted (ADR-19).
  const loaded = resolveAndLoad(ctx, state.active_profile, (r) => effectiveMode(ctx, state, r).mode === "off");
  const { resolved } = loaded;
  const eff = effectiveMode(ctx, state, resolved);
  const events: TelemetryDraft[] = [];
  if (loaded.fellBack) events.push(errorEvent("profile_resolution_failed"));

  const rec = state.turns[key] ?? { count: 0, pass1: [], pass1_block_count: 0, updated_at: ctx.now() };
  if (input.continuation === false && rec.count > 0) {
    log(ctx, "warn", "continuation_mismatch", "the harness says this is not a continuation but a pass count exists; the count wins");
  }
  const pass: 1 | 2 = rec.count === 0 ? 1 : 2;
  const capCheck = rec.count >= 2;

  // The text of this turn, for --debug only (07): written locally with a warning.
  if (ctx.debug) {
    const dir = store.writeDebug(`${key}-${ctx.now()}`, { turn_id: turnId, user_message: userMessage, assistant_text: input.assistant_text });
    stderr.push(`prosegate: --debug wrote this turn's text to ${dir}; delete it when you are done.`);
  }

  let result: ReviewResult;
  let reviewed = false;
  let decision: "allow" | "continue" = "allow";
  let skippedWhy: "off" | "size" | "budget" | null = null;

  if (eff.mode === "off") {
    skippedWhy = "off";
    // 03 has no `off` reason; `advisory_mode` is the closest ("reviewing is not enforced here").
    result = skippedResult(resolved, pass, "advisory_mode");
  } else if (input.assistant_text.length > MAX_PROSE_CHARS) {
    skippedWhy = "size";
    result = skippedResult(resolved, pass, "no_prose");
    events.push(errorEvent("turn_budget_exceeded"));
  } else {
    if (ctx.testHooks.delayMs !== undefined) sleepSync(ctx.testHooks.delayMs);
    if (ctx.elapsedMs() > budgetMs) {
      skippedWhy = "budget";
      result = skippedResult(resolved, pass, "reviewer_unavailable");
      events.push(errorEvent("turn_budget_exceeded"));
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
      try {
        const detailed = timed("review", () => reviewRulesDetailed({ request, resolved, packs: loaded.packs, enforce, capCheck, budgetMs: ctx.testHooks.engineBudgetMs }));
        if (detailed.diagnostics.budget_exceeded) {
          // The engine returns partial results on a budget trip; a partial review must not continue the model.
          skippedWhy = "budget";
          result = skippedResult(resolved, pass, "reviewer_unavailable");
          events.push(errorEvent("turn_budget_exceeded"));
        } else if (ctx.elapsedMs() > budgetMs) {
          skippedWhy = "budget";
          result = skippedResult(resolved, pass, "reviewer_unavailable");
          events.push(errorEvent("turn_budget_exceeded"));
        } else {
          result = detailed.result;
          reviewed = true;
        }
      } catch (error) {
        if (!(error instanceof PackVersionError)) throw error;
        skippedWhy = "budget";
        result = skippedResult(resolved, pass, "reviewer_unavailable");
        events.push(errorEvent("pack_rejected"));
      }
    }
  }

  if (reviewed && !capCheck && eff.mode !== "advisory" && result.verdict === "revise") decision = "continue";

  // ---- notice ---------------------------------------------------------------------------------
  const phase = capCheck ? "shipped" : pass === 2 ? "pass2" : "pass1";
  const render = reviewed ? renderFor(eff, resolved, phase) : "none";
  let notice: string | null = null;
  if (reviewed && !eff.headless) {
    notice = renderNotice(result, {
      mode: eff.mode,
      render,
      firstNoticeOfSession: !state.first_notice_shown,
      phase,
      ...(rec.pass1_block_count > 0 ? { pass1BlockCount: rec.pass1_block_count } : {}),
    });
  }
  const firstNoticeSpent = notice !== null && phase === "pass1" && eff.mode === "enforce";

  // Once-per-session lines (09, ADR-18) wait for a turn that has no review notice of its own.
  let pendingLines: string[] = [];
  let spentResolution = false;
  let spentOverlays = false;
  if (notice === null && decision === "allow" && !eff.headless && eff.mode !== "quiet" && eff.mode !== "off") {
    if (!state.resolution_notice_shown) {
      const l = resolutionIssueLine(loaded.issues);
      if (l !== null) {
        pendingLines.push(l);
        spentResolution = true;
      }
    }
    if (!state.overlays_notice_shown && resolved.overlays_ignored && resolved.policy !== null) {
      pendingLines.push(overlaysIgnoredLine(resolved.policy.org_name));
      spentOverlays = true;
    }
    pendingLines = pendingLines.slice(0, 2);
    if (pendingLines.length > 0) notice = pendingLines.join("\n");
  }

  // ---- persist --------------------------------------------------------------------------------
  const newCount = decision === "continue" ? rec.count + 1 : rec.count;
  const pass1 =
    pass === 1 && reviewed
      ? result.findings.map((f) => ({ id: f.id, category: f.category }))
      : rec.pass1;
  const pass1BlockCount = pass === 1 && reviewed ? result.findings.filter((f) => f.severity === "block").length : rec.pass1_block_count;
  timed("store", () => store.updateState(
    () => state,
    (s) => ({
      ...s,
      turns: reviewed || decision === "continue" ? { ...s.turns, [key]: { count: newCount, pass1, pass1_block_count: pass1BlockCount, updated_at: ctx.now() } } : s.turns,
      first_notice_shown: s.first_notice_shown || firstNoticeSpent,
      resolution_notice_shown: s.resolution_notice_shown || spentResolution,
      overlays_notice_shown: s.overlays_notice_shown || spentOverlays,
    }),
  ));

  // ---- headless report ------------------------------------------------------------------------
  if (eff.headless && reviewed) {
    const shippedRemaining = capCheck ? result.findings.length : 0;
    timed("store", () => store.upsertReport(buildTurnReport({ turn: key, result, decision, passes: capCheck ? 2 : pass, shippedRemaining, ts: ctx.now() })));
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
    events.push(enforcementEvent({ decision, overrideUsed: eff.overrideUsed }));
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
    output: { decision, feedback_text: decision === "continue" ? result.feedback_text : "", render: shown, result, notice },
    stderr,
  };
}
