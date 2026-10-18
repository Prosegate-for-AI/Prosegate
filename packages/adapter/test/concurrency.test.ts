import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { StateSchema } from "../src/schemas.js";
import { SESSION, TIC_TEXT, buildBundle, json, pg, pgAsync, sessionStartInput, tmpDir, turnEndInput } from "./helpers.js";

// Hooks are separate processes. A turn-end racing a mode command (or another turn-end) must never
// corrupt state.json, and neither's change may be lost (store.ts: lock file + atomic rename).

let bundle = "";
beforeAll(async () => {
  bundle = await buildBundle();
}, 120_000);

const MODES = ["quiet", "advisory", "off", "enforce"] as const;

function readState(home: string) {
  const text = readFileSync(join(home, "sessions", SESSION, "state.json"), "utf8");
  return StateSchema.parse(JSON.parse(text));
}

function leftovers(home: string): string[] {
  return readdirSync(join(home, "sessions", SESSION)).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"));
}

describe("a turn-end racing a mode command", () => {
  it("20 iterations: state.json always parses, the command's mode and the turn's pass count both land", async () => {
    for (let i = 0; i < 20; i++) {
      const home = tmpDir();
      expect(pg(bundle, ["session-start"], { home, input: sessionStartInput() }).code).toBe(0);
      const mode = MODES[i % MODES.length] as (typeof MODES)[number];
      const [end, cmd] = await Promise.all([
        pgAsync(bundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT, { turn_id: `race-${i}` }) }),
        pgAsync(bundle, [mode], { home, env: { PROSEGATE_SESSION: SESSION } }),
      ]);
      expect(end.code, `iteration ${i}: ${end.stderr}`).toBe(0);
      expect(cmd.code, `iteration ${i}: ${cmd.stderr}`).toBe(0);
      const state = readState(home);
      expect(state.mode, `iteration ${i}`).toBe(mode);
      // The turn-end continued the model exactly when it saw an enforcing mode, and recorded it.
      const counts = Object.values(state.turns).map((t) => t.count);
      const continued = json<{ decision: string }>(end).decision === "continue";
      if (continued) expect(counts, `iteration ${i}`).toEqual([1]);
      else expect(counts.every((c) => c === 0) && counts.length <= 1, `iteration ${i}: ${JSON.stringify(counts)}`).toBe(true);
      expect(leftovers(home), `iteration ${i}`).toEqual([]);
    }
  }, 280_000);

  it("two turn-ends at once both land their turn records", async () => {
    for (let i = 0; i < 5; i++) {
      const home = tmpDir();
      pg(bundle, ["session-start"], { home, input: sessionStartInput() });
      const [a, b] = await Promise.all([
        pgAsync(bundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT, { turn_id: `a-${i}` }) }),
        pgAsync(bundle, ["turn-end"], { home, input: turnEndInput(TIC_TEXT, { turn_id: `b-${i}` }) }),
      ]);
      expect([a.code, b.code]).toEqual([0, 0]);
      expect(Object.keys(readState(home).turns)).toHaveLength(2);
      expect(leftovers(home)).toEqual([]);
    }
  }, 120_000);

  it("a stale lock file from a crashed process is broken, not waited on forever", () => {
    const home = tmpDir();
    pg(bundle, ["session-start"], { home, input: sessionStartInput() });
    const lock = join(home, "sessions", SESSION, "state.lock");
    writeFileSync(lock, "99999");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const r = pg(bundle, ["quiet"], { home, env: { PROSEGATE_SESSION: SESSION } });
    expect(r.code).toBe(0);
    expect(readState(home).mode).toBe("quiet");
    expect(existsSync(lock)).toBe(false);
  });
});
