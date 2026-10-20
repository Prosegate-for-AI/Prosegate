import type { ResolvedProfile } from "@prosegate/profiles";
import { idDenylistViolation, injectedTextViolation } from "@prosegate/schema";
import type { Ctx } from "./ctx.js";
import { listProfileIds, resolveSession } from "./profiles.js";
import type { SessionState } from "./schemas.js";
import { SessionStore, rememberCwdProfile } from "./store.js";
import { profileSelectEvent, recordEvents } from "./telemetry.js";

/** Only successfully resolved, policy-permitted and injection-filtered profiles reach tools or heuristics. */
export function selectableProfiles(ctx: Ctx): ResolvedProfile[] {
  const out: ResolvedProfile[] = [];
  for (const id of listProfileIds(ctx).valid) {
    if (idDenylistViolation(id) !== null) continue;
    try {
      const r = resolveSession(ctx, id);
      if (r.fellBack || r.resolved.id !== id) continue;
      const p = r.resolved;
      if (injectedTextViolation(`${p.name} ${p.trigger.description ?? ""}`, 301) !== null) continue;
      out.push(p);
    } catch {
      // Invalid or policy-forbidden profiles are not choices.
    }
  }
  return out;
}

/** Keep the durable predecessor when switching between one-shot profiles. */
export function selectedState(s: SessionState, profile: ResolvedProfile, currentSticky: boolean, notify = true): SessionState {
  return {
    ...s,
    previous_profile: s.active_profile === profile.id ? s.previous_profile : !currentSticky && s.previous_profile !== null ? s.previous_profile : s.active_profile,
    active_profile: profile.id,
    candidate: null,
    candidate_streak: 0,
    selection_notice: notify ? (s.active_profile === profile.id ? s.selection_notice : profile.id) : null,
    profile_context_pending: s.profile_context_pending === true || s.active_profile !== profile.id,
  };
}

export function selectProfile(ctx: Ctx, store: SessionStore, profile: ResolvedProfile): SessionState {
  let from = profile.id;
  const next = store.updateState(
    () => { throw new Error("session unavailable"); },
    (s) => {
      from = s.active_profile;
      const current = resolveSession(ctx, s.active_profile);
      return selectedState(s, profile, current.fellBack || current.resolved.trigger.sticky);
    },
  );
  // A one-shot must never become the next session's default.
  rememberCwdProfile(ctx, next.cwd, profile.trigger.sticky ? profile.id : (next.previous_profile ?? profile.id));
  if (from !== profile.id) recordEvents(ctx, [profileSelectEvent({ from, to: profile.id, by: "model" })]);
  store.writeProfileCache(profile);
  return next;
}
