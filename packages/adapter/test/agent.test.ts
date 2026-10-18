import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AGENT_MARKERS } from "../src/agent-context.js";
import { SESSION, buildBundle, pg, sessionStartInput, tmpDir } from "./helpers.js";

// ADR-27, ADR-28, ADR-30 in a real process: a harness marker in the environment and a non-TTY stdin.
// The test spawns the release bundle with the marker set and a piped stdin, which is exactly what an
// agent's Bash tool does.
//
// Not closable here, and stated as such (ADR-27, ADR-30): in PowerShell, `Start-Process node prosegate.mjs off
// -WindowStyle Hidden -Wait` opens a new console whose stdin is a TTY, with CLAUDECODE still set, and a
// deliberate agent can unset every marker. The lowered-enforcement notice (lowering.test.ts) is what
// catches those: the user is told, once per session, whatever path lowered enforcement.

// Each test spawns real processes; the root run executes dozens of test files in parallel.
vi.setConfig({ testTimeout: 120_000 });

let bundle = "";
beforeAll(async () => {
  bundle = await buildBundle();
}, 120_000);

function session(): string {
  const home = tmpDir();
  expect(pg(bundle, ["session-start"], { home, input: sessionStartInput() }).code).toBe(0);
  return home;
}
function mode(home: string): string | null {
  return (JSON.parse(readFileSync(join(home, "sessions", SESSION, "state.json"), "utf8")) as { mode: string | null }).mode;
}
const TERMINAL = { PROSEGATE_SESSION: SESSION };
const AGENT = { CLAUDECODE: "1", PROSEGATE_SESSION: SESSION };
const refusal = (name: string) =>
  `Prosegate: ${name} was refused because it looks like the agent ran it. In Claude Code, a command typed after ! counts as the agent; run it in a separate terminal.\n`;

const LOWERING: Array<[string, string[]]> = [
  ["advisory", ["advisory"]],
  ["off", ["off"]],
  ["quiet", ["quiet"]],
  ["rule off", ["rule", "off", "core.hedge.001"]],
  ["profile", ["profile", "local/chat-reply"]],
];

describe("from an agent's tool context", () => {
  it.each(LOWERING)("prosegate %s refuses with the exact ADR-28 text and exit 1", (name, argv) => {
    const home = session();
    const r = pg(bundle, argv, { home, env: AGENT });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(refusal(name));
    expect(mode(home)).toBeNull();
  });

  it.each(LOWERING)("an empty CLAUDECODE= still counts as set: %s refuses", (name, argv) => {
    const home = session();
    const r = pg(bundle, argv, { home, env: { CLAUDECODE: "", PROSEGATE_SESSION: SESSION } });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(refusal(name));
    expect(mode(home)).toBeNull();
  });

  it.each(AGENT_MARKERS)("the marker %s alone is enough", (marker) => {
    const home = session();
    const r = pg(bundle, ["off"], { home, env: { [marker]: "1", PROSEGATE_SESSION: SESSION } });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(refusal("off"));
    expect(mode(home)).toBeNull();
  });

  it("`env -u CLAUDECODE` does not help while CLAUDE_CODE_CHILD_SESSION is set", () => {
    const home = session();
    // What `env -u CLAUDECODE prosegate advisory` runs: the marker removed, the others left in place.
    const r = pg(bundle, ["advisory"], { home, env: { CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ID: "abc", PROSEGATE_SESSION: SESSION } });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(refusal("advisory"));
  });

  it("the refusal is logged as a code, not as text", () => {
    const home = session();
    pg(bundle, ["off"], { home, env: AGENT });
    const logDir = join(home, "logs");
    const text = readdirSync(logDir)
      .map((f) => readFileSync(join(logDir, f), "utf8"))
      .join("\n");
    expect(text).toContain("agent_refused");
  });

  it("enforce, rule on, rule list, profile and status are always allowed", () => {
    const home = session();
    pg(bundle, ["advisory"], { home, env: TERMINAL });
    expect(pg(bundle, ["enforce"], { home, env: AGENT }).code).toBe(0);
    expect(mode(home)).toBe("enforce");
    expect(pg(bundle, ["rule", "list"], { home, env: AGENT }).code).toBe(0);
    expect(pg(bundle, ["status"], { home, env: AGENT }).code).toBe(0);
    expect(pg(bundle, ["profile"], { home, env: AGENT }).code).toBe(0);
    expect(pg(bundle, ["rule", "on", "core.hedge.001"], { home, env: AGENT }).code).toBe(0);
  });

  it("profile <id> from an agent changes nothing: the active profile and the remembered one stay as they were (N1, F16)", () => {
    const home = session();
    const profileOf = (): string => (JSON.parse(readFileSync(join(home, "sessions", SESSION, "state.json"), "utf8")) as { active_profile: string }).active_profile;
    expect(profileOf()).toBe("local/base");
    for (const id of ["local/chat-reply", "chat-reply", "no-such-profile"]) {
      const r = pg(bundle, ["profile", id], { home, env: AGENT });
      expect(r.code, id).toBe(1);
      expect(r.stderr, id).toBe(refusal("profile"));
    }
    expect(profileOf()).toBe("local/base");
    // The user's own terminal can switch it, and the list is open to both.
    expect(pg(bundle, ["profile", "local/chat-reply"], { home, env: TERMINAL }).code).toBe(0);
    expect(profileOf()).toBe("local/chat-reply");
    expect(pg(bundle, ["profile"], { home, env: AGENT }).stdout).toContain("local/chat-reply");
  });

  it("a user's terminal (no agent marker) can lower enforcement", () => {
    const home = session();
    const r = pg(bundle, ["advisory"], { home, env: TERMINAL });
    expect(r.code).toBe(0);
    expect(mode(home)).toBe("advisory");
  });
});
