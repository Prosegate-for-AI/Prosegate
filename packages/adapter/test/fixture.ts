// A deterministic 2,000-word reply for the cold-start measurement (ADR-10): headings, paragraphs,
// bullet lists, a code block, a table, inline code, bold and links, with about one sentence in
// twenty carrying a rule hit. Sentences are built from large word lists so they are almost all
// distinct (a repeating fixture would let `similarity_to_prior` exit early and hide its cost).

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const SYLLABLES = ["ka", "mo", "ri", "den", "lu", "pas", "tor", "vel", "ni", "bax", "sum", "dor", "fen", "gil", "hax", "jun", "kel", "lom", "mir", "nor", "pyl", "qua", "rex", "sol", "tav", "ulm", "vyn", "wex", "yar", "zon"];
const NOUNS = [
  "cache", "tenant", "index", "queue", "worker", "schema", "handler", "session", "token", "bucket", "replica", "shard", "payload", "endpoint", "cursor", "snapshot", "registry", "manifest", "scheduler", "lease",
  ...Array.from({ length: 300 }, (_, i) => `${SYLLABLES[i % 30]}${SYLLABLES[Math.floor(i / 30) % 30]}${SYLLABLES[(i * 7) % 30]}`),
];
const NUMS = ["two", "three", "four", "five", "twelve", "thirty", "50 ms", "200 ms", "4 KB", "1,024", "a single"];

const HITS = [
  "It's worth noting that the cache is per tenant.",
  "This makes the system fast, simple, and reliable.",
  "The design is robust and the rollout is seamless.",
  "We can leverage the existing connection pool here.",
  "This could potentially break the build on older runners.",
  "Great question! The answer depends on the tenant.",
];

type Pick = (xs: readonly string[]) => string;
const TEMPLATES: Array<(p: Pick) => string> = [
  (p) => `The ${p(NOUNS)} ${p(NOUNS)}s the ${p(NOUNS)} ${p(NOUNS)} before the ${p(NOUNS)} reaches the ${p(NOUNS)}.`,
  (p) => `We changed how the ${p(NOUNS)} handles each ${p(NOUNS)} so that the ${p(NOUNS)} no longer ${p(NOUNS)}s the ${p(NOUNS)} ${p(NOUNS)}.`,
  (p) => `Each ${p(NOUNS)} keeps ${p(NUMS)} ${p(NOUNS)} ${p(NOUNS)}s in memory and ${p(NOUNS)}s them when the ${p(NOUNS)} fills up.`,
  (p) => `A ${p(NOUNS)} ${p(NOUNS)} now ${p(NOUNS)}s the ${p(NOUNS)}.`,
  (p) => `Because the ${p(NOUNS)} ${p(NOUNS)}s the ${p(NOUNS)} twice, the ${p(NOUNS)} saw ${p(NUMS)} extra ${p(NOUNS)}s on Tuesday.`,
  (p) => `The ${p(NOUNS)} lives in \`config/${p(NOUNS)}.yaml\` and the default of ${p(NUMS)} is safe for every ${p(NOUNS)} we know of.`,
  (p) => `I ran the suite on the runner and locally, and the ${p(NOUNS)} timings agree within ten percent.`,
  (p) => `See [the ${p(NOUNS)} runbook](https://example.com/runbooks/${p(NOUNS)}) for the rollback steps of the ${p(NOUNS)} ${p(NOUNS)}.`,
  (p) => `Nothing here touches the ${p(NOUNS)}.`,
  (p) => `This was harder than it looks because the old ${p(NOUNS)} mutated the ${p(NOUNS)} in place, which broke the ${p(NOUNS)} ${p(NOUNS)} on retry.`,
];

const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

export function doc2000(words = 2000, seed = 7): string {
  const rnd = lcg(seed);
  const pick: Pick = (xs) => xs[Math.floor(rnd() * xs.length)] as string;
  const make = (): string => {
    if (rnd() < 0.05) return pick(HITS);
    const t = TEMPLATES[Math.floor(rnd() * TEMPLATES.length)] as (p: Pick) => string;
    return t(pick);
  };
  const blocks: string[] = [];
  let total = 0;
  let section = 0;
  while (total < words) {
    if (blocks.length % 7 === 0) {
      const h = `## Part ${++section}: the ${pick(NOUNS)} path`;
      blocks.push(h);
      total += wordCount(h);
    }
    const kind = rnd();
    let block: string;
    if (kind < 0.7) {
      block = Array.from({ length: 3 + Math.floor(rnd() * 4) }, make).join(" ");
    } else if (kind < 0.85) {
      block = Array.from({ length: 3 + Math.floor(rnd() * 3) }, () => `- ${make()}`).join("\n");
    } else if (kind < 0.93) {
      block = "```ts\nconst cache = new Map<string, number>();\ncache.set(tenantId, Date.now());\n```";
    } else {
      block = "| tenant | p95 before | p95 after |\n| --- | --- | --- |\n| a | 410 ms | 95 ms |\n| b | 380 ms | 90 ms |";
    }
    blocks.push(block);
    if (!block.startsWith("```") && !block.startsWith("|")) total += wordCount(block);
  }
  return `${blocks.join("\n\n")}\n`;
}
