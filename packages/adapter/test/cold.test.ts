import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { analyse } from "@prosegate/segmenter";
import { buildBundle, pg, sessionStartInput, tmpDir, turnEndInput } from "./helpers.js";
import { doc2000 } from "./fixture.js";

// ADR-10 / 05: a cold `turn-end` with the reviewer off (spawn to exit, including Node startup, bundle
// load, profile resolution, pack compile, the review and the store writes) must take at most 400 ms
// p95 on the 2,000-word fixture on the CI runner. Runs under `pnpm test:perf`, one file at a time.
//
// The 400 ms is stated for a runner whose bare `node -e 0` takes about 50 ms. A developer machine can
// have a much slower process start (Windows with a virus scanner: 200 ms and more), which says nothing
// about this code, so the assertion subtracts the bare-Node excess over that 50 ms reference, measured
// in the same attempt, exactly as the engine's own cold test does. The absolute numbers are printed.

const BUDGET_MS = 400;
const REFERENCE_NODE_MS = 50;
const SPAWNS = 20;

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
}

function once(text: string, i: number): Sample {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [bundle, "turn-end"], {
    input: JSON.stringify(turnEndInput(text, { turn_id: `cold-${i}-${Math.random()}` })),
    encoding: "utf8",
    env: { ...process.env, PROSEGATE_HOME: home, PROSEGATE_TIMINGS: "1", SYSTEMROOT: process.env["SystemRoot"] ?? process.env["SYSTEMROOT"] ?? "" },
  });
  const wall = performance.now() - t0;
  if (r.status !== 0) throw new Error(`turn-end failed: ${r.stderr}`);
  const line = r.stderr.split("\n").find((l) => l.startsWith("prosegate-timings "));
  if (line === undefined) throw new Error(`no timings line in: ${r.stderr}`);
  return { wall, timings: JSON.parse(line.slice("prosegate-timings ".length)) as Record<string, number> };
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

  it(`a fresh process reviewing 2,000 words: p95 within ${BUDGET_MS} ms (bare-Node excess over ${REFERENCE_NODE_MS} ms removed), ${SPAWNS} spawns`, () => {
    const text = doc2000();
    once(text, -1); // file cache warm-up, not counted
    let samples: Sample[] = [];
    let bare = Infinity;
    let adjusted = Infinity;
    // Up to three attempts: a shared machine shifts every spawn, and bare Node is measured in the same attempt.
    for (let attempt = 1; attempt <= 3 && adjusted > BUDGET_MS; attempt++) {
      bare = pct(Array.from({ length: 7 }, bareNode), 0.5);
      samples = Array.from({ length: SPAWNS }, (_, i) => once(text, i));
      adjusted = pct(samples.map((s) => s.wall), 0.95) - Math.max(0, bare - REFERENCE_NODE_MS);
      console.log(`cold attempt ${attempt}: wall p95 ${pct(samples.map((s) => s.wall), 0.95).toFixed(0)} ms, bare node p50 ${bare.toFixed(0)} ms, adjusted p95 ${adjusted.toFixed(0)} ms`);
    }
    const col = (k: string): number[] => samples.map((s) => s.timings[k] ?? 0);
    const line = (label: string, xs: number[]): string => `  ${label.padEnd(34)} p50 ${pct(xs, 0.5).toFixed(1).padStart(7)}  p95 ${pct(xs, 0.95).toFixed(1).padStart(7)}`;
    console.log(
      [
        `cold turn-end over ${SPAWNS} spawns, 2,000-word fixture (ms):`,
        line("wall (spawn to exit)", samples.map((s) => s.wall)),
        `  ${"bare node -e 0".padEnd(34)} p50 ${bare.toFixed(1).padStart(7)}`,
        line("startup (Node boot + bundle load)", col("startup_ms")),
        line("parse + resolve profile", col("resolve")),
        line("load + compile packs", col("packs")),
        line("review (analyse + rules)", col("review")),
        line("store I/O", col("store")),
        line("telemetry spool", col("telemetry")),
        line("in-process total", col("total_ms")),
      ].join("\n"),
    );
    expect(adjusted).toBeLessThanOrEqual(BUDGET_MS);
  }, 600_000);
});
