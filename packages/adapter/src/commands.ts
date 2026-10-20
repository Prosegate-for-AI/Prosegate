// User commands (09 "Override and modes", ADR-27, ADR-28, ADR-31): advisory, enforce, quiet, off,
// profile [<id>], reload, rule off|on|list, status. They act on the session named by PROSEGATE_SESSION
// (or --session), else on the session for the current directory or its nearest ancestor; if several
// are live they list them and ask. Mode-lowering commands refuse an agent's tool context (ADR-27) and
// refuse under org policy `required` (09, ADR-18).

import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { effectiveRule, ResolutionError, bundledProfileSources, parseProfileYaml, type Profile } from "@prosegate/profiles";
import { safeInline } from "@prosegate/schema";
import { agentRefusal, isAgentContext } from "./agent-context.js";
import type { Ctx } from "./ctx.js";
import { createHash } from "node:crypto";
import { ensureDirIn, writeFileAtomic } from "./fs-secure.js";
import { profileSlug } from "./inject.js";
import { loweredNoticeLine, lowerFor, type Lowering } from "./lowering.js";
import { log } from "./log.js";
import { effectiveMode } from "./modes.js";
import { baseProfileId, integerVersion, listProfileIds, loadLocal, resolveAndLoad, resolveSession, type Issue } from "./profiles.js";
import type { LastTurn, Mode } from "./schemas.js";
import { SessionStore, defaultState, findSession, readCwdProfiles, normaliseCwd, rememberCwdProfile, type SessionCandidate } from "./store.js";
import { enforcementEvent, profileSelectEvent, recordEvents } from "./telemetry.js";
import { selectedState } from "./selection.js";

export interface CommandResult {
  code: 0 | 1;
  out: string;
  err: string;
}

const ok = (out: string): CommandResult => ({ code: 0, out: `${out}\n`, err: "" });
const fail = (err: string): CommandResult => ({ code: 1, out: "", err: `${err}\n` });

export const COMMAND_NAMES = ["advisory", "enforce", "quiet", "off", "profile", "reload", "rule", "status"] as const;

/** Messages. Where 09 gives the string it is verbatim; the rest is listed in the W3.1 report for UX review. */
export const MESSAGES = {
  advisory: "Prosegate: advisory for this session. Findings will be shown, not enforced. Run prosegate enforce to restore.",
  enforce: "Prosegate: enforcement restored for this session.",
  alreadyEnforcing: "Prosegate: already enforcing.",
  quiet:
    "Prosegate: quiet for this session. Findings are still enforced; Prosegate's own notices are hidden, though Claude Code still shows each revision request. Run prosegate enforce to restore.",
  off: "Prosegate: off for this session. Nothing will be reviewed. Run prosegate enforce to restore.",
  required: (org: string) => `Prosegate: enforcement is required by ${org}, so this cannot be changed here. Ask an admin to change the policy.`,
} as const;

function noSession(cwd: string): string {
  return `Prosegate: no session found for ${cwd}. Run this from the directory your agent was started in, or set PROSEGATE_SESSION=<id>. If your agent is already running here, Prosegate's hooks are probably not installed.`;
}

function age(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return "just now";
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function ambiguous(ctx: Ctx, candidates: readonly SessionCandidate[]): string {
  const now = ctx.now();
  const rows = candidates.map((c) => `  ${c.id}  last active ${age(now - c.lastActive)}`);
  return [`Prosegate: more than one session is running in ${ctx.cwd}. Pass --session <id> or set PROSEGATE_SESSION to one of:`, ...rows].join("\n");
}

interface Target {
  store: SessionStore | null;
  /** Suffix naming the session when more than one exists. */
  tag: string;
}

/** The session a command acts on, or the CommandResult that explains why there is none. `optional` lets the command run without one. */
function target(ctx: Ctx, optional: boolean): Target | CommandResult {
  const found = findSession(ctx);
  if (found.ok) return { store: found.store, tag: found.named ? ` (session ${found.id})` : "" };
  if (found.reason === "ambiguous") return fail(ambiguous(ctx, found.candidates));
  return optional ? { store: null, tag: "" } : fail(noSession(ctx.cwd));
}

function isResult(t: Target | CommandResult): t is CommandResult {
  return "code" in t;
}

/** The org-policy refusal text when `required` applies to this session, else null. */
function requiredRefusal(ctx: Ctx, activeProfile: string): string | null {
  try {
    const r = resolveSession(ctx, activeProfile);
    if (r.resolved.enforcement.required) return MESSAGES.required(r.resolved.policy?.org_name ?? "your organisation");
    return null;
  } catch (error) {
    if (error instanceof ResolutionError && error.code === "policy_requires_org_profile") return MESSAGES.required(ctx.policy?.org_name ?? "your organisation");
    throw error;
  }
}

function activeProfileOf(ctx: Ctx, store: SessionStore | null): string {
  const state = store?.readState() ?? null;
  if (state !== null) return state.active_profile;
  return readCwdProfiles(ctx)[normaliseCwd(ctx, ctx.cwd)]?.profile ?? baseProfileId(ctx);
}

function setMode(ctx: Ctx, store: SessionStore, mode: Mode): void {
  const existing = store.readState();
  store.updateState(
    () => existing ?? defaultState(ctx, { session_id: store.sessionId, harness: "unknown", cwd: ctx.cwd, context_mode: "interactive", active_profile: baseProfileId(ctx) }),
    (s) => ({ ...s, mode }),
  );
}

function modeCommand(ctx: Ctx, name: "advisory" | "enforce" | "quiet" | "off"): CommandResult {
  const lowering = name !== "enforce";
  if (lowering && isAgentContext(ctx)) {
    log(ctx, "warn", "agent_refused", `agent context refused: ${name}`);
    return fail(agentRefusal(name));
  }
  const t = target(ctx, false);
  if (isResult(t)) return t;
  const store = t.store as SessionStore;
  if (name === "advisory" || name === "off") {
    const refusal = requiredRefusal(ctx, activeProfileOf(ctx, store));
    if (refusal !== null) return fail(refusal);
  }
  if (name === "enforce") {
    const state = store.readState();
    const resolved = state === null ? null : resolveSession(ctx, state.active_profile).resolved;
    if (state !== null && resolved !== null && effectiveMode(ctx, state, resolved).mode === "enforce" && state.mode !== "quiet") return ok(`${MESSAGES.alreadyEnforcing}${t.tag}`);
  }
  setMode(ctx, store, name);
  if (lowering) recordEvents(ctx, [enforcementEvent({ decision: "allow", overrideUsed: true })]);
  return ok(`${MESSAGES[name === "enforce" ? "enforce" : name]}${t.tag}`);
}

// ---- profile -------------------------------------------------------------------------------------

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] as number;
      prev[j] = Math.min(up + 1, (prev[j - 1] as number) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length] as number;
}

/** The nearest id to what the user typed: same slug, a slug that contains it, or a small edit distance. */
function nearMatch(typed: string, ids: readonly string[]): string | null {
  const t = typed.toLowerCase();
  let best: { id: string; score: number } | null = null;
  for (const id of ids) {
    const slug = profileSlug(id);
    let score = Math.min(editDistance(t, slug), editDistance(t, id));
    if (slug.includes(t) || t.includes(slug)) score = Math.min(score, 1);
    if (score <= 2 && (best === null || score < best.score)) best = { id, score };
  }
  return best?.id ?? null;
}

const LIST_CAP = 10;

function availableLine(ids: readonly string[]): string {
  const shown = ids.slice(0, LIST_CAP).join(", ");
  return ids.length > LIST_CAP ? `${shown} (+${ids.length - LIST_CAP} more; run prosegate profile with no argument)` : shown;
}

function issueText(i: Issue): string {
  return i.path === null ? i.reason : `${i.path}: ${i.reason}`;
}

function profileCommand(ctx: Ctx, args: string[]): CommandResult {
  if (args.length > 1) return fail("usage: prosegate profile [<id>]");
  const typed = args[0];
  // Switching the profile changes what the next turn is held to, so it is the user's to do (ADR-27, ADR-30). The
  // model's own route is the select_profile tool (Phase 5). Listing the profiles is harmless and stays open.
  if (typed !== undefined && isAgentContext(ctx)) {
    log(ctx, "warn", "agent_refused", "agent context refused: profile");
    return fail(agentRefusal("profile"));
  }
  const { all, valid } = listProfileIds(ctx);
  const t = target(ctx, typed === undefined);
  if (isResult(t)) return t;
  const store = t.store;
  if (typed === undefined) {
    const active = store?.readState()?.active_profile ?? null;
    const header = active === null ? "Prosegate: profiles:" : `Prosegate: profiles (active: ${active}):`;
    return ok([header, ...valid.map((id) => `  ${id}`)].join("\n"));
  }
  const state = (store as SessionStore).readState();
  if (state === null) return fail(noSession(ctx.cwd));

  // An id, or an unambiguous slug (the name a notice shows).
  let id: string | null = all.includes(typed) ? typed : null;
  if (id === null && !typed.includes("/")) {
    const bySlug = valid.filter((v) => profileSlug(v) === typed);
    if (bySlug.length > 1) return fail(`Prosegate: "${safeInline(typed).slice(0, 60)}" matches more than one profile: ${bySlug.join(", ")}. Use the full id.`);
    id = bySlug[0] ?? (all.filter((v) => profileSlug(v) === typed).length === 1 ? (all.find((v) => profileSlug(v) === typed) as string) : null);
  }
  if (id !== null && !valid.includes(id)) return fail(MESSAGES.required(ctx.policy?.org_name ?? "your organisation"));
  if (id === null) {
    const near = nearMatch(typed, valid);
    const shown = safeInline(typed).slice(0, 60);
    const base = `Prosegate: no profile "${shown}".`;
    return fail(`${base}${near === null ? "" : ` Did you mean ${near}?`} Available: ${availableLine(valid)}.`);
  }
  try {
    const r = resolveSession(ctx, id);
    if (r.fellBack) {
      const why = r.issues.at(-1);
      return fail(`Prosegate: cannot use profile ${id}${why === undefined ? "" : ` (${issueText(why)})`}.`);
    }
  } catch (error) {
    if (error instanceof ResolutionError) return fail(error.code === "policy_requires_org_profile" ? MESSAGES.required(ctx.policy?.org_name ?? "your organisation") : error.message);
    throw error;
  }
  (store as SessionStore).updateState(
    () => state,
    (s) => selectedState(s, resolveSession(ctx, id).resolved, resolveSession(ctx, s.active_profile).resolved.trigger.sticky, false),
  );
  const chosen = resolveSession(ctx, id).resolved;
  const updated = (store as SessionStore).readState();
  rememberCwdProfile(ctx, state.cwd, chosen.trigger.sticky ? id : (updated?.previous_profile ?? state.active_profile));
  recordEvents(ctx, [profileSelectEvent({ from: state.active_profile, to: id, by: "user" })]);
  return ok(`Prosegate: profile set to ${id}; it applies from the next turn.${t.tag}`);
}

// ---- reload / status -----------------------------------------------------------------------------

function issueLines(issues: readonly Issue[]): string[] {
  const ignored = issues.filter((i) => i.ignored).map((i) => `Prosegate: ignored ${i.path ?? "a local file"} (${i.reason}).`);
  const fellBack = issues.filter((i) => i.fellBack).map((i) => `Prosegate: ${i.path ?? "the profile"} could not be used (${i.reason}); using ${"local/base"} instead.`);
  return [...ignored, ...fellBack];
}

function reloadCommand(ctx: Ctx): CommandResult {
  const t = target(ctx, false);
  if (isResult(t)) return t;
  const store = t.store as SessionStore;
  const state = store.readState();
  if (state === null) return fail(noSession(ctx.cwd));
  const loaded = resolveAndLoad(ctx, state.active_profile);
  store.writeProfileCache(loaded.resolved);
  // The integrity record (state.local_hashes) is deliberately left alone: a reload must not be a way to forget a file change (ADR-30).
  const lines = [...issueLines(loaded.issues), `Prosegate: reloaded profile ${profileSlug(loaded.resolved.id)} v${integerVersion(loaded.resolved.version)}.${t.tag}`];
  return ok(lines.join("\n"));
}

function disabledRulesIn(profile: Profile): string[] {
  return Object.entries(profile.overrides?.rules ?? {})
    .filter(([, o]) => o.enabled === false)
    .map(([id]) => id)
    .sort();
}

/** Rules switched off in local profile files, as `<rule id>  <file> (<profile id>)`. */
export function localDisables(ctx: Ctx): Array<{ rule: string; file: string; path: string; profile: string }> {
  const local = loadLocal(ctx);
  const out: Array<{ rule: string; file: string; path: string; profile: string }> = [];
  for (const [id, f] of Object.entries(local.profiles)) {
    const parsed = parseProfileYaml(f.yaml);
    if (!parsed.ok) continue;
    for (const rule of disabledRulesIn(parsed.value)) out.push({ rule, file: f.file, path: f.path, profile: id });
  }
  return out;
}

const LAST_TURN_TEXT = (l: LastTurn | null): string => {
  if (l === null) return "no reviewed turns yet";
  const n = (k: number, noun: string): string => `${k} ${noun}${k === 1 ? "" : "s"}`;
  switch (l.outcome) {
    case "clean":
      return l.revisions > 0 ? `clean after ${n(l.revisions, "revision")}${l.fixed > 0 ? `, ${l.fixed} fixed` : ""}` : "clean";
    case "revised":
      return `revising, ${n(l.findings, "finding")} flagged`;
    case "shipped":
      return `${l.remaining} remain after ${n(l.revisions, "revision")}, shipped as is`;
    case "advisory":
      return `${n(l.findings, "finding")} shown, not enforced`;
    case "too_short":
      return "not reviewed (too short)";
    case "no_prose":
      return "not reviewed (no prose to check)";
    case "budget":
      return "not reviewed (the review ran out of time)";
    case "truncated":
      return `only the first 100 KB of prose was reviewed, ${n(l.findings, "finding")}`;
    case "too_long":
      return "not reviewed (the reply is too long to check)";
    case "off":
      return "not reviewed (off)";
  }
};

function modeText(ctx: Ctx, mode: Mode, source: "profile" | "command" | "environment" | "required", orgName: string | null): string {
  if (source === "required") return `${mode} (required by ${orgName ?? "your organisation"})`;
  if (source === "command") return mode === "enforce" ? "enforce (set by you)" : `${mode} (set by you)`;
  if (source === "environment") return `${mode} (PROSEGATE_MODE)`;
  return mode === "enforce" ? "enforce" : `${mode} (the profile's setting)`;
}

function statusCommand(ctx: Ctx): CommandResult {
  const t = target(ctx, false);
  if (isResult(t)) return t;
  const store = t.store as SessionStore;
  const state = store.readState();
  if (state === null) return fail(noSession(ctx.cwd));
  const loaded = resolveAndLoad(ctx, state.active_profile);
  const { resolved } = loaded;
  const eff = effectiveMode(ctx, state, resolved);
  const lowering: Lowering = lowerFor(ctx, state, eff, loaded);
  const off: string[] = [];
  for (const pack of loaded.packs) for (const rule of pack.rules) if (!effectiveRule(resolved, rule).enabled) off.push(rule.id);
  const rulesOff = off.length === 0 ? "none" : off.length <= 4 ? off.join(", ") : `${off.slice(0, 4).join(", ")} (+${off.length - 4} more; prosegate rule list)`;
  const lowered = lowering.categoriesLowered.length > 0 && lowering.severityLowered.length > 0 ? `; severity lowered on ${lowering.categoriesLowered.join(", ")}` : "";
  const mode = `${modeText(ctx, eff.mode, eff.source, resolved.policy?.org_name ?? null)}${lowering.what === "" ? "" : ` — lowered: ${lowering.what}`}`;
  const profile = `${profileSlug(resolved.id)} v${integerVersion(resolved.version)}${loaded.fellBack ? ` [fell back from ${profileSlug(state.active_profile)}; run prosegate reload]` : ""}`;
  return ok([`Mode: ${mode}`, `Profile: ${profile}`, `Rules off: ${rulesOff}${lowered}`, `Last turn: ${LAST_TURN_TEXT(state.last_turn)}`].join("\n"));
}

// ---- rule off / on / list ----------------------------------------------------------------------------

const RULE_ID_RE = /^[a-z0-9-]{1,31}\.(?:filler|hedge|vocab|triad|structure|repetition)\.\d{3}$/;
const MANAGED_HEADER =
  "# Written by prosegate rule off / on. If you edit this file by hand, those commands stop managing it and you maintain it yourself.";

function overlayFileName(profileId: string): string {
  return `${profileId.replace("/", "--")}.overlay.yaml`;
}

/** The text of the overlay the commands manage: the minimal valid profile that disables `rules`. */
export function renderOverlay(base: Pick<Profile, "id" | "version" | "name" | "extends">, rules: readonly string[]): string {
  const lines = [MANAGED_HEADER, "schema: prosegate.profile/1", `id: ${base.id}`, `version: ${base.version}`, `name: ${JSON.stringify(base.name)}`];
  if (base.extends !== undefined) lines.push(`extends: ${base.extends}`);
  lines.push("overrides:", "  rules:");
  for (const r of [...rules].sort()) lines.push(`    ${r}: { enabled: false }`);
  return `${lines.join("\n")}\n`;
}

interface OverlayTarget {
  base: Profile;
  path: string;
  /** The key under which the file is recorded in state.local_hashes. */
  file: string;
  /** The rules the managed overlay disables now; null when the file exists but is not ours. */
  current: string[] | null;
  exists: boolean;
}

function overlayTarget(ctx: Ctx, activeProfile: string): OverlayTarget | string {
  const dir = join(ctx.home, "profiles");
  const local = loadLocal(ctx);
  const existing = local.profiles[activeProfile];
  const bundled = bundledProfileSources()[activeProfile];
  const baseYaml = bundled?.yaml ?? existing?.yaml;
  if (baseYaml === undefined) return `Prosegate: profile ${activeProfile} has no file to overlay.`;
  const parsedBase = parseProfileYaml(baseYaml);
  if (!parsedBase.ok) return `Prosegate: profile ${activeProfile} could not be read.`;
  const base = parsedBase.value;
  const name = overlayFileName(activeProfile);
  if (existing === undefined) return { base, path: join(dir, name), file: `profiles/${name}`, current: [], exists: false };
  const parsedLocal = parseProfileYaml(existing.yaml);
  if (!parsedLocal.ok) return `Prosegate: ${existing.path} could not be read.`;
  const disabled = disabledRulesIn(parsedLocal.value);
  const ours = renderOverlay(parsedLocal.value, disabled).replace(/\r\n/g, "\n") === existing.yaml.replace(/\r\n/g, "\n");
  if (!ours || bundled === undefined) return { base: parsedLocal.value, path: existing.path, file: existing.file, current: null, exists: true };
  return { base, path: existing.path, file: existing.file, current: disabled, exists: true };
}

const hash16 = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** The command changed one local file itself: record that file's new hash, and no other (ADR-30). */
function recordOwnWrite(store: SessionStore | null, file: string, text: string | null): void {
  if (store === null || store.readState() === null) return;
  const state = store.readState();
  if (state === null) return;
  store.updateState(
    () => state,
    (s) => {
      const next = { ...s.local_hashes };
      if (text === null) Reflect.deleteProperty(next, file);
      else next[file] = hash16(text);
      return { ...s, local_hashes: next };
    },
  );
}

function ruleCommand(ctx: Ctx, args: string[]): CommandResult {
  const [sub, ruleId] = args;
  const usage = "usage: prosegate rule off <id> | on <id> | list";
  if (sub === "list" && args.length === 1) {
    const disables = localDisables(ctx);
    if (disables.length === 0) return ok("Prosegate: no rules are switched off locally.");
    return ok(disables.map((d) => `${d.rule}  ${d.path} (${d.profile})`).join("\n"));
  }
  if ((sub !== "off" && sub !== "on") || ruleId === undefined || args.length !== 2) return fail(usage);
  if (sub === "off" && isAgentContext(ctx)) {
    log(ctx, "warn", "agent_refused", "agent context refused: rule off");
    return fail(agentRefusal("rule off"));
  }
  if (!RULE_ID_RE.test(ruleId)) return fail(`Prosegate: "${safeInline(ruleId).slice(0, 60)}" is not a rule id. Ids look like core.hedge.001 and appear in each finding.`);
  const t = target(ctx, true);
  if (isResult(t)) return t;
  const active = activeProfileOf(ctx, t.store);
  if (sub === "off") {
    const refusal = requiredRefusal(ctx, active);
    if (refusal !== null) return fail(refusal);
    const loaded = resolveAndLoad(ctx, active);
    if (!loaded.packs.some((p) => p.rules.some((r) => r.id === ruleId))) {
      return fail(`Prosegate: profile ${loaded.resolved.id} has no rule ${ruleId}.`);
    }
    return ruleOff(ctx, t, loaded.resolved.id, ruleId);
  }
  return ruleOn(ctx, t, active, ruleId);
}

function ruleOff(ctx: Ctx, t: Target, profileId: string, ruleId: string): CommandResult {
  const target = overlayTarget(ctx, profileId);
  if (typeof target === "string") return fail(target);
  if (target.current === null) {
    return fail(
      `Prosegate: cannot switch off ${ruleId}. ${target.path} has been edited by hand, so prosegate rule leaves it alone. Add this under overrides.rules in that file: ${ruleId}: { enabled: false }`,
    );
  }
  if (target.current.includes(ruleId)) return ok(`Prosegate: rule ${ruleId} is already off for profile ${profileId}.${t.tag}`);
  const text = renderOverlay(target.base, [...target.current, ruleId]);
  if (!parseProfileYaml(text).ok) return fail("Prosegate: could not write a valid overlay.");
  ensureDirIn(ctx.home, join(ctx.home, "profiles"), ctx.platform);
  writeFileAtomic(target.path, text);
  recordOwnWrite(t.store, target.file, text);
  recordEvents(ctx, [enforcementEvent({ decision: "allow", overrideUsed: true })]);
  return ok(`Prosegate: rule ${ruleId} is off for profile ${profileId} in every session. Run prosegate rule on ${ruleId} to restore.${t.tag}`);
}

function ruleOn(ctx: Ctx, t: Target, profileId: string, ruleId: string): CommandResult {
  const target = overlayTarget(ctx, profileId);
  if (typeof target === "string") return fail(target);
  if (target.current === null) {
    const holder = localDisables(ctx).find((d) => d.rule === ruleId && d.profile === profileId);
    if (holder === undefined) return ok(`Prosegate: rule ${ruleId} is not switched off locally.`);
    return fail(`Prosegate: ${holder.path} was edited by hand and switches ${ruleId} off. Remove that line from the file to switch the rule on.`);
  }
  if (!target.current.includes(ruleId)) return ok(`Prosegate: rule ${ruleId} is not switched off locally.`);
  const remaining = target.current.filter((r) => r !== ruleId);
  if (remaining.length === 0) {
    unlinkSync(target.path);
    recordOwnWrite(t.store, target.file, null);
  } else {
    const text = renderOverlay(target.base, remaining);
    writeFileAtomic(target.path, text);
    recordOwnWrite(t.store, target.file, text);
  }
  return ok(`Prosegate: rule ${ruleId} is on again for profile ${profileId}.${t.tag}`);
}

// ---- dispatch -----------------------------------------------------------------------------------------

export function runCommand(argv: readonly string[], ctx: Ctx): CommandResult {
  const [name, ...args] = argv;
  switch (name) {
    case "advisory":
    case "enforce":
    case "quiet":
    case "off":
      if (args.length > 0) return fail(`usage: prosegate ${name}`);
      return modeCommand(ctx, name);
    case "profile":
      return profileCommand(ctx, args);
    case "reload":
      return reloadCommand(ctx);
    case "rule":
      return ruleCommand(ctx, args);
    case "status":
      return statusCommand(ctx);
    default:
      return fail(`prosegate: unknown command "${safeInline(String(name)).slice(0, 40)}". Run prosegate --help.`);
  }
}

export { loweredNoticeLine };
