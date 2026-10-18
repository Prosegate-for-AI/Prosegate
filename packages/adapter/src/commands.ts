// User commands (09 "Override and modes", ADR-27): advisory, enforce, quiet, off, profile <id>,
// reload, rule off|on|list, status. They act on the session named by PROSEGATE_SESSION, else on the
// most recently active session whose cwd matches. Mode-lowering commands refuse an agent's tool
// context (ADR-27) and refuse under org policy `required` (09, ADR-18).

import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { ResolutionError, bundledProfileSources, parseProfileYaml, type Profile } from "@prosegate/profiles";
import { safeInline } from "@prosegate/schema";
import { agentRefusal, isAgentContext } from "./agent-context.js";
import type { Ctx } from "./ctx.js";
import { ensureDir, writeFileAtomic } from "./fs-secure.js";
import { log } from "./log.js";
import { baseProfileId, listProfileIds, loadLocal, resolveAndLoad, resolveSession } from "./profiles.js";
import { SessionStore, defaultState, findSession, normaliseCwd, readCwdProfiles, rememberCwdProfile } from "./store.js";
import type { Mode } from "./schemas.js";
import { enforcementEvent, profileSelectEvent, recordEvents } from "./telemetry.js";

export interface CommandResult {
  code: 0 | 1;
  out: string;
  err: string;
}

const ok = (out: string): CommandResult => ({ code: 0, out: `${out}\n`, err: "" });
const fail = (err: string): CommandResult => ({ code: 1, out: "", err: `${err}\n` });

export const COMMAND_NAMES = ["advisory", "enforce", "quiet", "off", "profile", "reload", "rule", "status"] as const;

/** Messages. Where 09 gives the string it is verbatim; the others are listed in the W3.1 report for UX review. */
export const MESSAGES = {
  advisory: "Prosegate: advisory for this session. Findings will be shown, not enforced. Run prosegate enforce to restore.",
  enforce: "Prosegate: enforcement restored for this session.",
  quiet: "Prosegate: quiet for this session. Findings are still enforced; notices are hidden. Run prosegate enforce to restore.",
  off: "Prosegate: off for this session. Nothing will be reviewed. Run prosegate enforce to restore.",
  noSession: "Prosegate: no session found for this directory. Start your agent here first, or set PROSEGATE_SESSION.",
  required: (org: string) => `Enforcement is required by ${org}; ask an admin, or uninstall.`,
} as const;

function sessionOrFail(ctx: Ctx): SessionStore | null {
  return findSession(ctx);
}

/** The org-policy refusal text when `required` applies to this session, else null. */
function requiredRefusal(ctx: Ctx, activeProfile: string): string | null {
  try {
    const r = resolveSession(ctx, activeProfile);
    if (r.resolved.enforcement.required) return MESSAGES.required(r.resolved.policy?.org_name ?? "your organisation");
    return null;
  } catch (error) {
    if (error instanceof ResolutionError && error.code === "policy_requires_org_profile") return error.message;
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
  const store = sessionOrFail(ctx);
  if (store === null) return fail(MESSAGES.noSession);
  if (name === "advisory" || name === "off") {
    const refusal = requiredRefusal(ctx, activeProfileOf(ctx, store));
    if (refusal !== null) return fail(refusal);
  }
  setMode(ctx, store, name);
  if (lowering) recordEvents(ctx, [enforcementEvent({ decision: "allow", overrideUsed: true })]);
  return ok(MESSAGES[name]);
}

// ---- profile -------------------------------------------------------------------------------------

function profileCommand(ctx: Ctx, args: string[]): CommandResult {
  const id = args[0];
  if (id === undefined || args.length > 1) return fail("usage: prosegate profile <id>");
  const store = sessionOrFail(ctx);
  if (store === null) return fail(MESSAGES.noSession);
  const state = store.readState();
  if (state === null) return fail(MESSAGES.noSession);
  const valid = listProfileIds(ctx);
  if (!valid.includes(id)) {
    if (ctx.policy?.enforcement_default === "required" && valid.length === 0) {
      return fail(MESSAGES.required(ctx.policy.org_name));
    }
    return fail(`Prosegate: unknown profile "${safeInline(id).slice(0, 60)}". Valid profiles: ${valid.join(", ")}.`);
  }
  try {
    const r = resolveSession(ctx, id);
    if (r.fellBack) return fail(`Prosegate: cannot use profile ${id}. ${r.issues.at(-1) ?? ""}`.trim());
  } catch (error) {
    if (error instanceof ResolutionError) return fail(error.message);
    throw error;
  }
  store.updateState(
    () => state,
    (s) => ({ ...s, previous_profile: s.active_profile, active_profile: id, candidate: null, candidate_streak: 0 }),
  );
  rememberCwdProfile(ctx, state.cwd, id);
  recordEvents(ctx, [profileSelectEvent({ from: state.active_profile, to: id, by: "user" })]);
  return ok(`Prosegate: profile set to ${id}; it applies from the next turn.`);
}

// ---- reload / status -----------------------------------------------------------------------------

function reloadCommand(ctx: Ctx): CommandResult {
  const store = sessionOrFail(ctx);
  const state = store?.readState() ?? null;
  if (store === null || state === null) return fail(MESSAGES.noSession);
  const loaded = resolveAndLoad(ctx, state.active_profile);
  store.writeProfileCache(loaded.resolved);
  const int = loaded.resolved.version.split("+")[0] ?? loaded.resolved.version;
  const lines = [`Prosegate: reloaded profile ${loaded.resolved.id} (v${int}).`];
  for (const issue of loaded.issues.slice(0, 2)) lines.push(`Prosegate: ${issue}`);
  return ok(lines.join("\n"));
}

function disabledRulesIn(profile: Profile): string[] {
  return Object.entries(profile.overrides?.rules ?? {})
    .filter(([, o]) => o.enabled === false)
    .map(([id]) => id)
    .sort();
}

/** Rules switched off in local profile files, as `<rule id>  <file> (<profile id>)`. */
export function localDisables(ctx: Ctx): Array<{ rule: string; file: string; profile: string }> {
  const local = loadLocal(ctx);
  const out: Array<{ rule: string; file: string; profile: string }> = [];
  for (const [id, f] of Object.entries(local.profiles)) {
    const parsed = parseProfileYaml(f.yaml);
    if (!parsed.ok) continue;
    for (const rule of disabledRulesIn(parsed.value)) out.push({ rule, file: f.file, profile: id });
  }
  return out;
}

function statusCommand(ctx: Ctx): CommandResult {
  const store = sessionOrFail(ctx);
  const state = store?.readState() ?? null;
  if (store === null || state === null) return fail(MESSAGES.noSession);
  const loaded = resolveSession(ctx, state.active_profile);
  const r = loaded.resolved;
  const mode: string = r.enforcement.required ? "enforce (required)" : (state.mode ?? (r.enforcement.mode === "advisory" ? "advisory" : "enforce"));
  const disables = localDisables(ctx).map((d) => d.rule);
  const rules = disables.length === 0 ? "none" : disables.length <= 4 ? disables.join(", ") : `${disables.slice(0, 4).join(", ")} (+${disables.length - 4} more)`;
  return ok(
    [
      `Prosegate: ${mode}`,
      `Profile: ${r.id} (v${r.version})${loaded.fellBack ? ` [fell back from ${state.active_profile}]` : ""}`,
      `Rules off locally: ${rules}`,
      `Session: ${state.session_id}`,
    ].join("\n"),
  );
}

// ---- rule off / on / list ----------------------------------------------------------------------------

const RULE_ID_RE = /^[a-z0-9-]{1,31}\.(?:filler|hedge|vocab|triad|structure|repetition)\.\d{3}$/;
const MANAGED_HEADER =
  "# Managed by `prosegate rule off` and `prosegate rule on`. Edit it by hand and those commands will leave it alone.";

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
  if (existing === undefined) return { base, path: join(dir, overlayFileName(activeProfile)), current: [], exists: false };
  const parsedLocal = parseProfileYaml(existing.yaml);
  if (!parsedLocal.ok) return `Prosegate: ${existing.file} could not be read.`;
  const disabled = disabledRulesIn(parsedLocal.value);
  const ours = renderOverlay(parsedLocal.value, disabled).replace(/\r\n/g, "\n") === existing.yaml.replace(/\r\n/g, "\n");
  const path = join(ctx.home, existing.file);
  if (!ours || bundled === undefined) {
    return { base: parsedLocal.value, path, current: null, exists: true };
  }
  return { base, path, current: disabled, exists: true };
}

function ruleCommand(ctx: Ctx, args: string[]): CommandResult {
  const [sub, ruleId] = args;
  if (sub === "list" && args.length === 1) {
    const disables = localDisables(ctx);
    if (disables.length === 0) return ok("Prosegate: no rules are switched off locally.");
    return ok(disables.map((d) => `${d.rule}  ${d.file} (${d.profile})`).join("\n"));
  }
  if ((sub !== "off" && sub !== "on") || ruleId === undefined || args.length !== 2) return fail("usage: prosegate rule off <id> | rule on <id> | rule list");
  if (sub === "off" && isAgentContext(ctx)) {
    log(ctx, "warn", "agent_refused", "agent context refused: rule off");
    return fail(agentRefusal("rule off"));
  }
  if (!RULE_ID_RE.test(ruleId)) return fail(`Prosegate: "${safeInline(ruleId).slice(0, 60)}" is not a rule id such as core.hedge.001.`);
  const store = sessionOrFail(ctx);
  const active = activeProfileOf(ctx, store);
  if (sub === "off") {
    const refusal = requiredRefusal(ctx, active);
    if (refusal !== null) return fail(refusal);
    const loaded = resolveAndLoad(ctx, active);
    if (!loaded.packs.some((p) => p.rules.some((r) => r.id === ruleId))) {
      return fail(`Prosegate: profile ${loaded.resolved.id} has no rule ${ruleId}.`);
    }
    return ruleOff(ctx, loaded.resolved.id, ruleId);
  }
  return ruleOn(ctx, active, ruleId);
}

function ruleOff(ctx: Ctx, profileId: string, ruleId: string): CommandResult {
  const target = overlayTarget(ctx, profileId);
  if (typeof target === "string") return fail(target);
  if (target.current === null) {
    return fail(`Prosegate: ${profileId} is customised in a file this command does not manage. Add ${ruleId}: { enabled: false } under overrides.rules there.`);
  }
  if (target.current.includes(ruleId)) return ok(`Prosegate: rule ${ruleId} is already off for profile ${profileId}.`);
  const text = renderOverlay(target.base, [...target.current, ruleId]);
  if (!parseProfileYaml(text).ok) return fail("Prosegate: could not write a valid overlay.");
  ensureDir(join(ctx.home, "profiles"), ctx.platform);
  writeFileAtomic(target.path, text);
  recordEvents(ctx, [enforcementEvent({ decision: "allow", overrideUsed: true })]);
  return ok(`Prosegate: rule ${ruleId} is off for profile ${profileId}. Run prosegate rule on ${ruleId} to restore.`);
}

function ruleOn(ctx: Ctx, profileId: string, ruleId: string): CommandResult {
  const target = overlayTarget(ctx, profileId);
  if (typeof target === "string") return fail(target);
  if (target.current === null) {
    const holder = localDisables(ctx).find((d) => d.rule === ruleId && d.profile === profileId);
    return fail(
      holder === undefined
        ? `Prosegate: rule ${ruleId} is not switched off locally.`
        : `Prosegate: ${holder.file} switches ${ruleId} off and is not managed by this command. Edit that file.`,
    );
  }
  if (!target.current.includes(ruleId)) return ok(`Prosegate: rule ${ruleId} is not switched off locally.`);
  const remaining = target.current.filter((r) => r !== ruleId);
  if (remaining.length === 0) {
    unlinkSync(target.path);
  } else {
    writeFileAtomic(target.path, renderOverlay(target.base, remaining));
  }
  return ok(`Prosegate: rule ${ruleId} is on again for profile ${profileId}.`);
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


