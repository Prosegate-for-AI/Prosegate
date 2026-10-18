import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { analyse } from "@prosegate/segmenter";
import { buildBundle, pg, sessionStartInput, tmpDir, turnEndInput } from "./helpers.js";
import { doc2000 } from "./fixture.js";

// ADR-10 / 05: a cold `turn-end` with the reviewer off (spawn to exit, including Node startup, bundle
// load, profile resolution, pack compile, the review and the store writes) must take at most 400 ms
// p95 on the 2,000-word fixture on the CI runner. Runs under `pnpm test:perf`, one file at a time, on the
// RELEASE bundle (no test levers) with a scrubbed environment (no CI, no agent marker, no Prosegate switch).
//
// The 400 ms is stated for a runner whose bare `node -e 0` takes about 50 ms. A developer machine can
// have a much slower process start (Windows with a virus scanner: 200 ms and more), which says nothing
// about this code, so the assertion subtracts the bare-Node excess over that 50 ms reference, measured
// in the same attempt, exactly as the engine's own cold test does. The absolute numbers are printed.
// Three attempts are always made, and at least two must be within budget: a regression that fails two of
// three does not get through, and one noisy attempt on a shared machine does not fail the build.

const BUDGET_MS = 400;
const REFERENCE_NODE_MS = 50;
const SPAWNS = 20;
const ATTEMPTS = 3;
const SCRUBBED = ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CI", "PROSEGATE_MODE", "PROSEGATE_SESSION", "PROSEGATE_DEBUG", "PROSEGATE_TEST_HOOKS", "PROSEGATE_TIMINGS"];

let bundle = "";
let home = "";
beforeAll(async () => {
  bundle = await buildBundle();
  home = join(tmpDir(), ".prosegate");
  expect(pg(bundle, ["session-start"], { home, input: sessionStartInput() }).code).toBe(0);
}, 120_000);

const pct = (xs: number[], p: number): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)] as number;

interface Sample {
  wall: number;
  timings: Record<string, number>;
  verdict: string;
  findings: number;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const kept = Object.entries(process.env).filter(([k]) => !SCRUBBED.includes(k.toUpperCase()));
  return { ...Object.fromEntries(kept), PROSEGATE_HOME: home, PROSEGATE_TIMINGS: "1" };
}

function once(text: string, i: number): Sample {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [bundle, "turn-end"], {
    input: JSON.stringify(turnEndInput(text, { turn_id: `cold-${i}-${Math.random()}` })),
    encoding: "utf8",
    env: cleanEnv(),
  });
  const wall = performance.now() - t0;
  if (r.status !== 0) throw new Error(`turn-end failed: ${r.stderr}`);
  const line = r.stderr.split("\n").find((l) => l.startsWith("prosegate-timings "));
  if (line === undefined) throw new Error(`no timings line in: ${r.stderr}`);
  const out = JSON.parse(r.stdout) as { result: { verdict: string; findings: unknown[] } };
  return { wall, timings: JSON.parse(line.slice("prosegate-timings ".length)) as Record<string, number>, verdict: out.result.verdict, findings: out.result.findings.length };
}

function bareNode(): number {
  const t0 = performance.now();
  spawnSync(process.execPath, ["-e", "0"]);
  return performance.now() - t0;
}

describe("cold turn-end (ADR-10)", () => {
  it("the fixture is about 2,000 words of prose", () => {
    const a = analyse(doc2000());
    expect(a.prose_words).toBeGreaterThan(1700);
    expect(a.prose_words).toBeLessThan(2600);
  });

  it(`a fresh process reviewing 2,000 words: p95 within ${BUDGET_MS} ms (bare-Node excess over ${REFERENCE_NODE_MS} ms removed) in at least 2 of ${ATTEMPTS} attempts of ${SPAWNS} spawns`, () => {
    const text = doc2000();
    once(text, -1); // file cache warm-up, not counted
    const attempts: Array<{ bare: number; samples: Sample[]; adjusted: number }> = [];
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const bare = pct(Array.from({ length: 7 }, bareNode), 0.5);
      const samples = Array.from({ length: SPAWNS }, (_, i) => once(text, i));
      const wallP95 = pct(samples.map((s) => s.wall), 0.95);
      const adjusted = wallP95 - Math.max(0, bare - REFERENCE_NODE_MS);
      attempts.push({ bare, samples, adjusted });
      console.log(`cold attempt ${attempt}: wall p95 ${wallP95.toFixed(0)} ms, bare node p50 ${bare.toFixed(0)} ms, adjusted p95 ${adjusted.toFixed(0)} ms`);
    }
    const last = attempts.at(-1) as (typeof attempts)[number];
    const col = (k: string): number[] => last.samples.map((s) => s.timings[k] ?? 0);
    const line = (label: string, xs: number[]): string => `  ${label.padEnd(34)} p50 ${pct(xs, 0.5).toFixed(1).padStart(7)}  p95 ${pct(xs, 0.95).toFixed(1).padStart(7)}`;
    console.log(
      [
        `cold turn-end over ${SPAWNS} spawns (last attempt), 2,000-word fixture (ms):`,
        line("wall (spawn to exit)", last.samples.map((s) => s.wall)),
        `  ${"bare node -e 0".padEnd(34)} p50 ${last.bare.toFixed(1).padStart(7)}`,
        line("startup (Node boot + bundle load)", col("startup_ms")),
        line("parse + resolve profile", col("resolve")),
        line("load + compile packs", col("packs")),
        line("review (analyse + rules)", col("review")),
        line("store I/O", col("store")),
        line("telemetry spool", col("telemetry")),
        line("in-process total", col("total_ms")),
      ].join("\n"),
    );
    // The timing means nothing unless the review really ran: every spawn reviewed the text and found things in it.
    for (const a of attempts) {
      for (const s of a.samples) {
        expect(s.verdict).toBe("revise");
        expect(s.findings).toBeGreaterThan(0);
        expect(s.timings["review"] ?? 0).toBeGreaterThan(0);
        expect(s.timings["packs"] ?? 0).toBeGreaterThan(0);
      }
    }
    const within = attempts.filter((a) => a.adjusted <= BUDGET_MS).length;
    expect(within, `adjusted p95 per attempt: ${attempts.map((a) => a.adjusted.toFixed(0)).join(", ")} ms`).toBeGreaterThanOrEqual(2);
  }, 900_000);
});
