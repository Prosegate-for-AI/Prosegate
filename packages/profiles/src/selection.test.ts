import { describe, expect, it } from "vitest";
import { bundledPackSources, bundledProfileSources } from "./bundled.js";
import { resolveProfile } from "./resolve.js";
import { scoreProfiles, suggestProfile, type SelectionState } from "./selection.js";

const sources = { profiles: bundledProfileSources(), packs: bundledPackSources() };
const profiles = Object.keys(sources.profiles).map((id) => resolveProfile(id, sources));
const initial: SelectionState = { active_profile: "local/base", previous_profile: null, candidate: null, candidate_streak: 0 };

describe("profile trigger scoring and hysteresis", () => {
  it("asks immediately for distinct phrases or a harness hint without switching profiles", () => {
    expect(suggestProfile(initial, profiles, "Write a pull request and commit message", [])).toMatchObject({ candidate: "local/pr-description", candidate_streak: 1, inject: expect.any(String) });
    expect(suggestProfile(initial, profiles, "", ["gh_pr_create"])).toMatchObject({ candidate: "local/pr-description", inject: expect.any(String) });
    expect(initial.active_profile).toBe("local/base");
  });
  it("asks on the second consecutive weak match", () => {
    const first = suggestProfile(initial, profiles, "Write an email", []);
    expect(first).toEqual({ candidate: "local/email", candidate_streak: 1, inject: null });
    expect(suggestProfile({ ...initial, ...first }, profiles, "Another email", []).inject).toEqual(expect.any(String));
  });
  it("clears a streak when no profile matches, the active profile wins, or leaders tie", () => {
    const state = { ...initial, candidate: "local/email", candidate_streak: 1 };
    for (const message of ["Fix the cache", "Email and changelog"]) expect(suggestProfile(state, profiles, message, [])).toEqual({ candidate: null, candidate_streak: 0, inject: null });
    expect(suggestProfile({ ...state, active_profile: "local/email" }, profiles, "email", []).candidate).toBeNull();
  });
  it("a different weak candidate starts a new streak", () => {
    expect(suggestProfile({ ...initial, candidate: "local/email", candidate_streak: 1 }, profiles, "a changelog", [])).toEqual({ candidate: "local/pr-description", candidate_streak: 1, inject: null });
  });
  it("uses case-insensitive literal phrases, word boundaries, and distinct phrases", () => {
    expect(suggestProfile(initial, profiles, "EMAIL email email", []).inject).toBeNull();
    expect(suggestProfile(initial, profiles, "emailing the team", []).candidate).toBeNull();
    expect(suggestProfile(initial, profiles, "a design document", []).inject).toBeNull();
    expect(suggestProfile(initial, profiles, "a DESIGN   DOC and RFC", []).inject).not.toBeNull();
    const custom = { ...resolveProfile("local/base", sources), trigger: { description: "", patterns: [".*", ".*"], harness_hints: [], sticky: true } };
    expect(scoreProfiles([custom], "anything", [])[0]?.score).toBe(0);
    expect(scoreProfiles([custom], "literal .*", [])[0]?.score).toBe(1);
  });
});
