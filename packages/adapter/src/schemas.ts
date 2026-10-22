// Strict zod schemas for everything the adapter reads from outside its own process memory: the
// three hook inputs (05) and the session store files. Strict means an unknown field is an error;
// a hook input that does not parse is a fail-open exit 1, and a store file that does not parse is
// rediscovered as missing (the store is a cache of decisions, never a source of policy; ADR-19).

import { z } from "zod";
import { CATEGORIES } from "@prosegate/schema";
import { SESSION_ID_RE } from "./ctx.js";

const SessionId = z.string().regex(SESSION_ID_RE, "session_id must match [A-Za-z0-9_-]{1,128}");
/** A tool name or similar short token from the harness. */
const ShortString = z.string().max(300);
/** Hook JSON is read whole; this cap is about shape. The stdin cap (12 MB) bounds the bytes, the engine bounds the review (ADR-30). */
export const MAX_TEXT = 12_000_000;

export const HarnessModeSchema = z.enum(["interactive", "headless"]);

export const SESSION_SOURCES = ["startup", "resume", "clear", "compact", "fork"] as const;

export const SessionStartInputSchema = z.strictObject({
  harness: z.string().min(1).max(64),
  session_id: SessionId,
  cwd: z.string().min(1).max(4096),
  mode: HarnessModeSchema,
  /** Why the session started (ADR-31). Absent means `startup`. */
  source: z.enum(SESSION_SOURCES).optional(),
});
export type SessionStartInput = z.infer<typeof SessionStartInputSchema>;

export const TurnStartInputSchema = z.strictObject({
  session_id: SessionId,
  user_message: z.string().max(MAX_TEXT),
  tool_calls_so_far: z.array(ShortString).max(2000),
  /** The shim's turn id (Claude Code's prompt_id), the same one turn-end carries (ADR-33). Absent means the adapter derives one. */
  turn_id: z.string().max(300).nullish(),
});
export type TurnStartInput = z.infer<typeof TurnStartInputSchema>;

export const TurnEndInputSchema = z.strictObject({
  session_id: SessionId,
  /** The shim's turn id (Claude Code's prompt_id); absent or empty means the adapter derives one (05). */
  turn_id: z.string().max(300).nullish(),
  assistant_text: z.string().max(MAX_TEXT),
  user_message: z.string().max(MAX_TEXT).nullish(),
  tool_calls: z.array(ShortString).max(2000),
  continuation: z.boolean(),
  /** False when the harness cannot continue the model, so `enforcement_unavailable` can be recorded (ADR-29). Default true. */
  continue_supported: z.boolean().optional(),
});
export type TurnEndInput = z.infer<typeof TurnEndInputSchema>;

// ---- session store ----------------------------------------------------------------------------

export const ModeSchema = z.enum(["enforce", "advisory", "quiet", "off"]);
export type Mode = z.infer<typeof ModeSchema>;

const FindingRef = z.strictObject({ id: z.string().regex(/^[0-9a-f]{10}$/), category: z.enum(CATEGORIES) });

export const TurnRecordSchema = z.strictObject({
  /** Distinguishes repeated user prompts when the harness supplies no unique turn id. */
  reviewer_turn_started_at: z.number().int().min(0).optional(),
  /** Review passes that ended in `continue` for this turn: 0, 1, or 2 (the cap). */
  count: z.number().int().min(0).max(2),
  /** Findings reported on pass 1 (ids and categories only; ids are hashes of span text and stay on this machine). */
  pass1: z.array(FindingRef).max(500),
  pass1_block_count: z.number().int().min(0),
  /** The profile pass 1 used; pass 2 and the cap check use it too (ADR-31). */
  profile_id: z.string().max(80),
  profile_version: z.string().max(80),
  /** The "shipped as is" notice was already shown for this turn (ADR-31). */
  shipped_shown: z.boolean(),
  updated_at: z.number().int().min(0),
});
export type TurnRecord = z.infer<typeof TurnRecordSchema>;

export const OUTCOMES = ["clean", "revised", "shipped", "advisory", "too_short", "no_prose", "budget", "truncated", "too_long", "off"] as const;

/** What `prosegate status` says about the last reviewed turn. */
export const LastTurnSchema = z.strictObject({
  outcome: z.enum(OUTCOMES),
  findings: z.number().int().min(0),
  fixed: z.number().int().min(0),
  remaining: z.number().int().min(0),
  revisions: z.number().int().min(0).max(2),
});
export type LastTurn = z.infer<typeof LastTurnSchema>;

export const StateSchema = z.strictObject({
  v: z.literal(1),
  session_id: SessionId,
  harness: z.string().max(64),
  cwd: z.string().max(4096),
  /** The harness's own interactive/headless flag from session-start. */
  context_mode: HarnessModeSchema,
  /** The user's explicit override; null follows the profile (enforce unless the profile says advisory). */
  mode: ModeSchema.nullable(),
  active_profile: z.string().max(80),
  previous_profile: z.string().max(80).nullable(),
  /** The suggested profile, awaiting a model decision. */
  candidate: z.string().max(80).nullable(),
  candidate_streak: z.number().int().min(0).max(1000),
  /** A selection is visible on the next completed turn, including when there are no findings. */
  selection_notice: z.string().max(80).nullable().optional(),
  /** Refresh style guidance at the next user prompt after a manual choice or one-shot reversion. */
  profile_context_pending: z.boolean().optional(),
  turns: z.record(z.string().regex(/^[0-9a-f]{16}$/), TurnRecordSchema),
  first_notice_shown: z.boolean(),
  overlays_notice_shown: z.boolean(),
  resolution_notice_shown: z.boolean(),
  last_seen_profile_version: z.string().max(80).nullable(),
  /** sha256 (16 hex) of every local profile and pack file at session start; a change is a lowering reason (ADR-30). */
  local_hashes: z.record(z.string().max(400), z.string().max(40)),
  /** The lowered-enforcement reason last shown to the user ('' when none); it shows again when it changes. */
  lowered_shown: z.string().max(400),
  debug_notice_shown: z.boolean(),
  /** A reply was only partly reviewed and its turn is still revising: the user hears of it on the next allow (N9). Absent means false. */
  truncated_pending: z.boolean().optional(),
  /** Reviewed turns so far, for the headless line's turn number. */
  turn_ordinal: z.number().int().min(0),
  last_turn: LastTurnSchema.nullable(),
  created_at: z.number().int().min(0),
  updated_at: z.number().int().min(0),
});
export type SessionState = z.infer<typeof StateSchema>;

export const TurnFileSchema = z.strictObject({
  turn_id: z.string().max(300),
  user_message: z.string().max(MAX_TEXT),
  ts: z.number().int().min(0),
});
export type TurnFile = z.infer<typeof TurnFileSchema>;

export const CwdProfilesSchema = z.record(z.string().max(4096), z.strictObject({ profile: z.string().max(80), ts: z.number().int().min(0) }));
export type CwdProfiles = z.infer<typeof CwdProfilesSchema>;

/**
 * Per profile: the integer version and what the profile pinned, as of the last session start. The
 * "profile updated" line (ADR-28) fires only when the integer or a pinned pack moved, so the user's
 * own `rule off` never triggers it. `summary` holds `pack:<id>` -> version and `rule:<id>` -> fingerprint.
 */
export const ProfileVersionsSchema = z.record(
  z.string().max(80),
  z.strictObject({ version: z.string().max(80), summary: z.record(z.string().max(120), z.string().max(80)) }),
);
export type ProfileVersions = z.infer<typeof ProfileVersionsSchema>;

const ReportFinding = z.strictObject({
  category: z.enum(CATEGORIES),
  rule_id: z.string().max(80).nullable(),
  severity: z.enum(["block", "warn", "info"]),
  /** Trimmed to 80 characters: the CI log reader needs to see what was flagged. */
  text: z.string().max(200),
});

export const TurnReportSchema = z.strictObject({
  turn: z.string().regex(/^[0-9a-f]{16}$/),
  /** 1-based ordinal of the reviewed turn in this session. */
  ordinal: z.number().int().min(0),
  profile: z.string().max(80),
  /** Review passes run so far for this turn (1 or 2; the cap check after pass 2 does not count). */
  passes: z.number().int().min(0).max(3),
  verdict: z.enum(["pass", "revise", "skipped"]),
  skipped_reason: z.string().max(40).optional(),
  findings: z.array(ReportFinding).max(200),
  /** Pass-1 findings no longer present at pass 2. */
  cleared: z.number().int().min(0),
  /** Findings that survived the cap and shipped. */
  shipped_remaining: z.number().int().min(0),
  decision: z.enum(["allow", "continue"]),
  ts: z.number().int().min(0),
});
export type TurnReport = z.infer<typeof TurnReportSchema>;

export const ReportFileSchema = z.strictObject({
  schema: z.literal("prosegate.report/1"),
  session_id: SessionId,
  turns: z.array(TurnReportSchema).max(100),
});
export type ReportFile = z.infer<typeof ReportFileSchema>;
