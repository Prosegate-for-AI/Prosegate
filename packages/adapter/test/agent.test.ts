import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION, buildBundle, pg, sessionStartInput, tmpDir } from "./helpers.js";

// ADR-27 in a real process: the harness marker in the environment and a non-TTY stdin. The test
// spawns the bundle with CLAUDECODE set and a piped stdin, which is exactly what an agent's Bash tool does.

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
const AGENT = { CLAUDECODE: "1", PROSEGATE_SESSION: SESSION };
const TERMINAL = { PROSEGATE_SESSION: SESSION };

describe("from an agent's tool context", () => {
  it.each([
    ["advisory", ["advisory"]],
    ["off", ["off"]],
    ["quiet", ["quiet"]],
    ["rule off", ["rule", "off", "core.hedge.001"]],
  ])("prosegate %s refuses with the exact ADR-27 text and exit 1", (name, argv) => {
    const home = session();
    const r = pg(bundle, argv, { home, env: AGENT });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`prosegate ${name} must be run by you in a terminal, not by the agent.\n`);
    expect(mode(home)).toBeNull();
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

  it("enforce, rule on, rule list and status are always allowed", () => {
    const home = session();
    pg(bundle, ["advisory"], { home, env: TERMINAL });
    expect(pg(bundle, ["enforce"], { home, env: AGENT }).code).toBe(0);
    expect(mode(home)).toBe("enforce");
    expect(pg(bundle, ["rule", "list"], { home, env: AGENT }).code).toBe(0);
    expect(pg(bundle, ["status"], { home, env: AGENT }).code).toBe(0);
    expect(pg(bundle, ["rule", "on", "core.hedge.001"], { home, env: AGENT }).code).toBe(0);
  });

  it("a user's terminal (no agent marker) can lower enforcement", () => {
    const home = session();
    const r = pg(bundle, ["advisory"], { home, env: TERMINAL });
    expect(r.code).toBe(0);
    expect(mode(home)).toBe("advisory");
  });
});
