// The 2,000-word latency fallback document. This is a copy of realisticDoc() from
// packages/engine/test/fixtures.ts (seed 7, 5% hit rate), the engine's own perf fixture. It is copied,
// not imported: check:deps forbids a relative import out of the package (its rule e) and the engine is
// out of scope for this item. Keep it in step with the original so the numbers stay comparable with
// packages/engine/test/perf.test.ts.
import { analyse } from "@prosegate/segmenter";

const SYLLABLES = ["ka", "mo", "ri", "den", "lu", "pas", "tor", "vel", "ni", "bax", "sum", "dor", "fen", "gil", "hax", "jun", "kel", "lom", "mir", "nor", "pyl", "qua", "rex", "sol", "tav", "ulm", "vyn", "wex", "yar", "zon"];
const NOUNS = [
  "cache", "tenant", "index", "queue", "worker", "schema", "handler", "session", "token", "bucket", "replica", "shard", "payload", "endpoint", "cursor", "snapshot", "registry", "manifest", "scheduler", "lease",
  ...Array.from({ length: 600 }, (_, i) => `${SYLLABLES[i % 30]}${SYLLABLES[Math.floor(i / 30) % 30]}${SYLLABLES[(i * 7) % 30]}`),
];
const NUMS = ["two", "three", "four", "five", "twelve", "thirty", "50 ms", "200 ms", "4 KB", "1,024", "95th percentile", "a single"];

type Pick = (xs: readonly string[]) => string;
const TEMPLATES: Array<(p: Pick) => string> = [
  (p) => `The ${p(NOUNS)} ${(p(NOUNS) + "s")} the ${p(NOUNS)} ${p(NOUNS)} before the ${p(NOUNS)} reaches the ${p(NOUNS)}.`,
  (p) => `We changed how the ${p(NOUNS)} handles each ${p(NOUNS)} so that the ${p(NOUNS)} no longer ${(p(NOUNS) + "s").replace(/s$/, "")} the ${p(NOUNS)} ${p(NOUNS)}.`,
  (p) => `Each ${p(NOUNS)} keeps ${p(NUMS)} ${p(NOUNS)} ${p(NOUNS)}s in memory and ${(p(NOUNS) + "s")} them when the ${p(NOUNS)} fills up.`,
  (p) => `A ${p(NOUNS)} ${p(NOUNS)} now ${(p(NOUNS) + "s")} the ${p(NOUNS)}.`,
  (p) => `Because the ${p(NOUNS)} ${(p(NOUNS) + "s")} the ${p(NOUNS)} twice, the ${p(NOUNS)} saw ${p(NUMS)} extra ${p(NOUNS)}s on Tuesday.`,
  (p) => `Please check the ${p(NOUNS)} path first, since that is where the ${p(NOUNS)} ${p(NOUNS)} usually hides.`,
  (p) => `The ${p(NOUNS)} lives in \`config/${p(NOUNS)}.yaml\` and the default of ${p(NUMS)} is safe for every ${p(NOUNS)} we know of.`,
  (p) => `I ran the suite on the runner and locally, and the ${p(NOUNS)} timings agree within ten percent.`,
  (p) => `See [the ${p(NOUNS)} runbook](https://example.com/runbooks/${p(NOUNS)}) for the rollback steps of the ${p(NOUNS)} ${p(NOUNS)}.`,
  (p) => `Nothing here touches the ${p(NOUNS)}.`,
  (p) => `This was harder than it looks because the old ${p(NOUNS)} mutated the ${p(NOUNS)} in place, which broke the ${p(NOUNS)} ${p(NOUNS)} on retry.`,
];

const HITS = [
  "It's worth noting that the cache is per tenant.",
  "This makes the system fast, simple, and reliable.",
  "The design is robust and the rollout is seamless.",
  "We can leverage the existing connection pool here.",
  "This could potentially break the build on older runners.",
  "Great question! The answer depends on the tenant.",
  "The result is relatively slow under load.",
  "It is not just about speed, it is about trust.",
  "There are a number of options for the eviction policy.",
  "Arguably, the retry is unnecessary.",
  "I hope this helps.",
  "This is truly a pivotal change.",
];

const HEADINGS = ["Summary", "Design", "Rollout", "Testing", "Risks", "Follow-ups", "Details", "Notes"];

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A markdown turn of at least `targetWords` prose words; `hitRate` is the share of sentences that trip a rule. */
export function realisticDoc(targetWords = 2000, hitRate = 0.05, seed = 7): string {
  const rand = prng(seed);
  const pick: Pick = (xs) => xs[Math.floor(rand() * xs.length)] as string;
  const sentence = (): string => (rand() < hitRate ? pick(HITS) : (TEMPLATES[Math.floor(rand() * TEMPLATES.length)] as (p: Pick) => string)(pick));
  const parts: string[] = [];
  let words = 0;
  let h = 0;
  const add = (block: string): void => {
    parts.push(block);
    words += analyse(block).prose_words;
  };
  add(`# ${HEADINGS[h++ % HEADINGS.length]}`);
  while (words < targetWords) {
    const kind = rand();
    if (kind < 0.55) {
      add(Array.from({ length: 3 + Math.floor(rand() * 4) }, sentence).join(" "));
    } else if (kind < 0.7) {
      add(Array.from({ length: 3 + Math.floor(rand() * 3) }, () => `- ${sentence()}`).join("\n"));
    } else if (kind < 0.8) {
      add(`## ${HEADINGS[h++ % HEADINGS.length]}`);
    } else if (kind < 0.86) {
      add("```ts\nconst cache = new TenantCache({ ttlMs: 300_000, robust: true });\nawait cache.get(tenantId, key);\n```");
    } else if (kind < 0.92) {
      add("| tenant | before | after |\n| --- | --- | --- |\n| acme | 410 ms | 95 ms |\n| globex | 380 ms | 120 ms |");
    } else if (kind < 0.96) {
      add(`**Note:** ${sentence()} ${sentence()}`);
    } else {
      add(`> ${sentence()}`);
    }
  }
  return `${parts.join("\n\n")}\n`;
}
