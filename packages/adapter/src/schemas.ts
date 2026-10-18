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
/** Hook JSON is read whole; these caps are about shape, the 256 KB prose cap is applied by the pipeline. */
const MAX_TEXT = 4_000_000;

export const HarnessModeSchema = z.enum(["interactive", "headless"]);

export const SessionStartInputSchema = z.strictObject({
  harness: z.string().min(1).max(64),
  session_id: SessionId,
  cwd: z.string().min(1).max(4096),
  mode: HarnessModeSchema,
});
export type SessionStartInput = z.infer<typeof SessionStartInputSchema>;

export const TurnStartInputSchema = z.strictObject({
  session_id: SessionId,
  user_message: z.string().max(MAX_TEXT),
  tool_calls_so_far: z.array(ShortString).max(2000),
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
});
export type TurnEndInput = z.infer<typeof TurnEndInputSchema>;

// ---- session store ----------------------------------------------------------------------------

export const ModeSchema = z.enum(["enforce", "advisory", "quiet", "off"]);
export type Mode = z.infer<typeof ModeSchema>;

const FindingRef = z.strictObject({ id: z.string().regex(/^[0-9a-f]{10}$/), category: z.enum(CATEGORIES) });

export const TurnRecordSchema = z.strictObject({
  /** Review passes that ended in `continue` for this turn: 0, 1, or 2 (the cap). */
  count: z.number().int().min(0).max(2),
  /** Findings reported on pass 1 (ids and categories only; ids are hashes of span text and stay on this machine). */
  pass1: z.array(FindingRef).max(500),
  pass1_block_count: z.number().int().min(0),
  updated_at: z.number().int().min(0),
});
export type TurnRecord = z.infer<typeof TurnRecordSchema>;

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
  /** Reserved for Phase 5 selection (04 "Selection and hysteresis"). */
  candidate: z.string().max(80).nullable(),
  candidate_streak: z.number().int().min(0).max(1000),
  turns: z.record(z.string().regex(/^[0-9a-f]{16}$/), TurnRecordSchema),
  first_notice_shown: z.boolean(),
  overlays_notice_shown: z.boolean(),
  resolution_notice_shown: z.boolean(),
  last_seen_profile_version: z.string().max(80).nullable(),
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
  profile: z.string().max(80),
  /** Review passes run so far for this turn (1 or 2; the cap check after pass 2 does not count). */
  passes: z.number().int().min(0).max(3),
  verdict: z.enum(["pass", "revise", "skipped"]),
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
