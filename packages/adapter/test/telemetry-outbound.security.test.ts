import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { KEY_PREFIXES, WireBatchSchema, findKeyShapedStrings } from "@prosegate/schema";
import { encodeBatch, enforcementEvent, errorEvent, profileSelectEvent, reviewEvent, sessionStartEvent, type TelemetryDraft } from "../src/telemetry.js";
import { CLEAN_TEXT, TIC_TEXT, buildBundle, pg, tmpDir } from "./helpers.js";

// Required in CI (plan section 8, 07 threat 5 and "Key handling"): serialise every telemetry event the
// adapter emits, from real runs of the built bundle, and grep the bytes for key prefixes and prose.
// The canaries below are names, paths, ids and words that exist only on this machine; none of them
// may appear in the spool.

let bundle = "";
let result: ReturnType<typeof run>;
beforeAll(async () => {
  bundle = await buildBundle();
  result = run();
}, 240_000);

const CANARIES = {
  session: "zz-canary-session",
  cwd: "/work/zz-canary-cwd",
  userMessage: "ZZ-CANARY-USER-MESSAGE",
  profile: "team-x/zz-canary-profile",
  profileSlug: "zz-canary-profile",
  pack: "zzcanary",
  ruleId: "zzcanary.filler.001",
  phrase: "frobnicate the widget",
  // Assembled at run time so this file carries no key-shaped literal (check:secrets).
  secret: ["sk", "-live-ZZCANARYSECRET0123456789abcdef"].join(""),
  profileName: "Canary profile name",
};

const PACK = `schema: prosegate.rulepack/1
id: ${CANARIES.pack}
version: 1.0.0
findings_schema: 1
rules:
  - id: ${CANARIES.ruleId}
    category: filler
    severity: block
    match: { kind: phrase, phrases: ["${CANARIES.phrase}"], boundary: word, case_insensitive: true }
    instruction: { action: remove, text: "Remove it." }
    examples: { hit: ["Please ${CANARIES.phrase} now."], miss: ["Leave the widget alone."] }
`;

const PROFILE = `schema: prosegate.profile/1
id: ${CANARIES.profile}
version: 1
name: ${CANARIES.profileName}
extends: local/base
rule_packs:
  - { id: ${CANARIES.pack}, version: ">=1.0.0 <2.0.0" }
`;

function run(): { spool: string; logs: string; types: Set<string>; home: string } {
  const home = join(tmpDir(), ".prosegate");
  mkdirSync(join(home, "profiles"), { recursive: true });
  mkdirSync(join(home, "packs"), { recursive: true });
  writeFileSync(join(home, "profiles", "canary.yaml"), PROFILE);
  writeFileSync(join(home, "packs", "canary.yaml"), PACK);
  const env = { PROSEGATE_SESSION: CANARIES.session };
  const start = (id: string, cwd = CANARIES.cwd) => pg(bundle, ["session-start"], { home, input: { harness: "claude-code", session_id: id, cwd, mode: "interactive" } });
  const end = (text: string, over: Record<string, unknown> = {}, e: Record<string, string> = {}) =>
    pg(bundle, ["turn-end"], {
      home,
      env: e,
      input: { session_id: CANARIES.session, turn_id: "turn-canary", assistant_text: text, user_message: "", tool_calls: [], continuation: false, ...over },
    });

  expect(start(CANARIES.session).code).toBe(0);
  expect(pg(bundle, ["profile", CANARIES.profile], { home, env }).code).toBe(0);
  expect(pg(bundle, ["turn-start"], { home, input: { session_id: CANARIES.session, user_message: CANARIES.userMessage, tool_calls_so_far: [] } }).code).toBe(0);

  const prose = `${TIC_TEXT} Please ${CANARIES.phrase} before you merge, and keep ${CANARIES.secret} out of the repository.`;
  const first = JSON.parse(end(prose).stdout) as { decision: string; feedback_text: string }; // pass 1 -> review, enforcement
  expect(first.decision).toBe("continue");
  expect(first.feedback_text, "the canary pack must really fire, or the masking checks below prove nothing").toContain(CANARIES.ruleId);
  expect(end(prose, { continuation: true }).code).toBe(0); // pass 2
  expect(end(prose, { continuation: true }).code).toBe(0); // cap check
  expect(end(CLEAN_TEXT, { turn_id: "turn-2" }).code).toBe(0); // a clean turn
  expect(end("Short.", { turn_id: "turn-3" }).code).toBe(0); // below the floor: skipped

  // pass 1 -> pass 2 clean: cleared and cleared_categories
  expect(end(prose, { turn_id: "turn-4" }).code).toBe(0);
  expect(end(CLEAN_TEXT, { turn_id: "turn-4", continuation: true }).code).toBe(0);

  // an oversize turn: the turn_budget_exceeded error event
  expect(end(`${prose} `.repeat(Math.ceil((256 * 1024 + 1) / prose.length)), { turn_id: "turn-5" }).code).toBe(0);

  // mode overrides: override_used
  expect(pg(bundle, ["advisory"], { home, env }).code).toBe(0);
  expect(end(prose, { turn_id: "turn-6" }).code).toBe(0);
  expect(pg(bundle, ["off"], { home, env }).code).toBe(0);
  expect(end(prose, { turn_id: "turn-7" }).code).toBe(0);
  expect(pg(bundle, ["enforce"], { home, env }).code).toBe(0);

  // a remembered profile that no longer exists: profile_resolution_failed
  writeFileSync(join(home, "cwd-profiles.json"), JSON.stringify({ [CANARIES.cwd + "-gone"]: { profile: "team-x/zz-canary-gone", ts: 1 } }));
  expect(start("other-session", CANARIES.cwd + "-gone").code).toBe(0);

  // malformed input that quotes a canary: nothing of it may reach the log
  pg(bundle, ["turn-end"], { home, raw: `{"canary": "${CANARIES.userMessage}" ${CANARIES.secret}` });

  const spool = readFileSync(join(home, "telemetry", "spool.jsonl"), "utf8");
  const logDir = join(home, "logs");
  const logs = readdirSync(logDir)
    .map((f) => readFileSync(join(logDir, f), "utf8"))
    .join("\n");
  const types = new Set<string>();
  for (const line of spool.split("\n").filter(Boolean)) for (const e of (JSON.parse(line) as { events: Array<{ t: string }> }).events) types.add(e.t);
  return { spool, logs, types, home };
}

describe("telemetry outbound (07 threat 5)", () => {
  it("emits every event type the adapter has", () => {
    expect([...result.types].sort()).toEqual(["enforcement", "error", "profile_select", "review", "session_start"]);
  });

  it("every spooled line is a valid strict wire batch, and every event has only allowlisted fields", () => {
    const FIELDS: Record<string, string[]> = {
      session_start: ["t", "ts", "harness", "adapter_version", "profile_count", "offline"],
      review: ["t", "ts", "profile_id", "pass", "verdict", "skipped_reason", "prose_words_bucket", "by_category", "rule_ids", "reviewer", "cleared", "cleared_categories"],
      enforcement: ["t", "ts", "decision", "enforcement_unavailable", "override_used", "notice_via_model"],
      profile_select: ["t", "ts", "from", "to", "by"],
      error: ["t", "ts", "code"],
    };
    for (const line of result.spool.split("\n").filter(Boolean)) {
      const parsed = WireBatchSchema.safeParse(JSON.parse(line));
      expect(parsed.success, line).toBe(true);
      for (const e of (JSON.parse(line) as { events: Array<Record<string, unknown>> }).events) {
        for (const k of Object.keys(e)) expect(FIELDS[e["t"] as string], `${e["t"]}.${k}`).toContain(k);
        expect((e["ts"] as number) % 60_000).toBe(0);
      }
    }
  });

  it("holds no key prefix and no key-shaped string", () => {
    for (const prefix of KEY_PREFIXES) expect(new RegExp(prefix).test(result.spool), `prefix ${prefix}`).toBe(false);
    for (const line of result.spool.split("\n").filter(Boolean)) expect(findKeyShapedStrings(JSON.parse(line))).toEqual([]);
    expect(result.spool).not.toContain("ZZCANARYSECRET");
  });

  it("holds none of the prose, names, ids or paths that exist only on this machine", () => {
    const lower = result.spool.toLowerCase();
    for (const [name, canary] of Object.entries(CANARIES)) expect(lower.includes(canary.toLowerCase()), `canary ${name}`).toBe(false);
    for (const word of ["worth noting", "great question", "catalog", "robust", "tenant", "staging", "expires", "cache"]) expect(lower, word).not.toContain(word);
  });

  it("masks every local profile id to the literal `local`, and drops rule ids of local packs", () => {
    for (const line of result.spool.split("\n").filter(Boolean)) {
      for (const e of (JSON.parse(line) as { events: Array<Record<string, unknown>> }).events) {
        for (const k of ["profile_id", "from", "to"]) if (k in e) expect(e[k], `${e["t"]}.${k}`).toBe("local");
        for (const id of (e["rule_ids"] as string[] | undefined) ?? []) expect(id.startsWith("core."), id).toBe(true);
      }
    }
    // The canary pack's rule fired (it is in the feedback the model got), yet its id is not in the spool.
    expect(result.spool).toContain('"rule_ids":["core.');
    expect(result.spool).not.toContain("zzcanary");
  });

  it("carries no finding ids, spans, offsets or lengths", () => {
    expect(result.spool).not.toMatch(/"(?:id|span|start|end|text|length|offset|session_id|turn_id|cwd)"/);
    expect(result.spool).not.toMatch(/"[0-9a-f]{10}"/);
  });

  it("the logs hold codes and fixed messages, never prose or names", () => {
    expect(result.logs.length).toBeGreaterThan(0);
    const lower = result.logs.toLowerCase();
    for (const [name, canary] of Object.entries(CANARIES)) expect(lower.includes(canary.toLowerCase()), `canary ${name}`).toBe(false);
    expect(lower).not.toContain("worth noting");
  });
});

describe("the typed constructors", () => {
  const drafts: TelemetryDraft[] = [
    sessionStartEvent({ harness: "claude-code", profileCount: 5, offline: true }),
    reviewEvent({ profileId: "team-x/secret-name", pass: 1, verdict: "revise", proseWords: 250, byCategory: { hedge: 2 }, ruleIds: ["core.hedge.001", "mypack.hedge.001"], cleared: 0, clearedCategories: [] }),
    enforcementEvent({ decision: "continue", overrideUsed: false }),
    profileSelectEvent({ from: "team-x/a", to: "team-y/b", by: "user" }),
    errorEvent("adapter_error"),
  ];

  it("encode through the one masking path: names become local, foreign rule ids are dropped, words are bucketed", () => {
    const bytes = encodeBatch(drafts, 1_700_000_000_123);
    expect(bytes).not.toContain("team-x");
    expect(bytes).not.toContain("team-y");
    expect(bytes).not.toContain("mypack");
    expect(bytes).toContain('"prose_words_bucket":200');
    expect(bytes).toContain('"ts":1699999980000');
  });

  it("refuse an unknown error code", () => {
    expect(() => errorEvent("not_a_code" as never)).toThrow();
  });
});
