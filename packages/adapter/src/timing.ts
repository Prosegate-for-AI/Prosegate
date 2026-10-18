// Phase timings for the cold-start budget (ADR-10). Cheap enough to leave on; printed to stderr only
// when PROSEGATE_TIMINGS=1, which is how the cold test and the W3.1 report get their breakdown.

export const timings: Record<string, number> = {};

export function timed<T>(label: string, fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    timings[label] = (timings[label] ?? 0) + (performance.now() - start);
  }
}

export function timingsLine(startupMs: number, totalMs: number): string {
  const rounded = Object.fromEntries(Object.entries({ startup_ms: startupMs, ...timings, total_ms: totalMs }).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  return `prosegate-timings ${JSON.stringify(rounded)}`;
}
