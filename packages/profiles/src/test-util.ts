// Shared test helpers. Not exported from index.ts.
import type { ResolutionSources } from "./resolve.js";

/** A fixture `core` 0.1.0 pack: enough of the 08 catalogue to resolve the starter profiles against. */
export const CORE_FIXTURE_YAML = String.raw`
schema: prosegate.rulepack/1
id: core
version: 0.1.0
findings_schema: 1
rules:
  - id: core.filler.001
    category: filler
    severity: block
    match: { kind: phrase, phrases: ["let's dive in", "great question"], position: sentence_start }
    instruction: { action: remove, text: "Remove. Start with the answer." }
    examples:
      hit: ["Great question! Let's dive into the cache layer."]
      miss: ["The cache layer is per tenant."]
  - id: core.filler.002
    category: filler
    severity: block
    match: { kind: phrase, phrases: ["i hope this helps", "let me know if you have any questions"], position: closing }
    instruction: { action: remove, text: "Remove. End on the last substantive point." }
    examples:
      hit: ["Let me know if you have any questions!"]
      miss: ["Reply by Thursday if the dates don't work."]
  - id: core.hedge.001
    category: hedge
    severity: block
    match: { kind: phrase, phrases: ["it's important to note", "it is worth noting"] }
    instruction: { action: remove, text: "Remove the preamble; keep the clause after it." }
    examples:
      hit: ["It's worth noting that the index is unique."]
      miss: ["The index is unique."]
  - id: core.hedge.002
    category: hedge
    severity: warn
    match: { kind: regex, pattern: '\b(somewhat|fairly|relatively|rather)\s+(\w+)', flags: i }
    instruction: { action: specify, text: "Replace the qualifier with the measurement or the plain adjective." }
    examples:
      hit: ["The query is relatively slow."]
      miss: ["The query takes 400 ms."]
  - id: core.hedge.003
    category: hedge
    severity: warn
    match: { kind: phrase, phrases: ["arguably", "generally speaking", "in many cases"] }
    instruction: { action: remove, text: "Remove the hedge or state who argues it and why." }
    examples:
      hit: ["Arguably, the retry is unnecessary."]
      miss: ["The retry is unnecessary."]
  - id: core.vocab.003
    category: vocab
    severity: warn
    match: { kind: phrase, phrases: [robust, seamless, comprehensive] }
    instruction: { action: specify, text: "Replace with the property that makes it so, or remove." }
    examples:
      hit: ["A robust and seamless integration."]
      miss: ["The integration retries on 5xx and is idempotent."]
  - id: core.triad.001
    category: triad
    severity: warn
    match: { kind: regex, pattern: '\b([a-z]+), ([a-z]+),? and ([a-z]+)\b' }
    instruction: { action: shorten, text: "Keep the one that matters, or give evidence for each." }
    examples:
      hit: ["It is fast, simple, and reliable."]
      miss: ["It is fast."]
  - id: core.structure.001
    category: structure
    severity: warn
    match: { kind: document_metric, metric: headers_per_100_words, above: 1.5, min_sentences: 8 }
    instruction: { action: restructure, text: "Remove headings; this is short enough to read as prose." }
    examples:
      hit: ["<eval corpus ref: core/structure-001-hit-01>"]
      miss: ["<eval corpus ref: core/structure-001-miss-01>"]
  - id: core.structure.002
    category: structure
    severity: warn
    match: { kind: document_metric, metric: bullet_ratio, above: 0.6, min_sentences: 8 }
    instruction: { action: restructure, text: "Rewrite as prose; keep a list only where the items are parallel." }
    examples:
      hit: ["<eval corpus ref: core/structure-002-hit-01>"]
      miss: ["<eval corpus ref: core/structure-002-miss-01>"]
  - id: core.structure.004
    category: structure
    severity: block
    match: { kind: document_metric, metric: closing_similarity, above: 0.6, min_sentences: 6 }
    instruction: { action: remove, text: "Remove the closing paragraph; it restates the opening." }
    examples:
      hit: ["<eval corpus ref: core/structure-004-hit-01>"]
      miss: ["<eval corpus ref: core/structure-004-miss-01>"]
  - id: core.structure.005
    category: structure
    severity: warn
    match: { kind: document_metric, metric: bold_per_100_words, above: 3, min_sentences: 6 }
    instruction: { action: remove, text: "Remove bold except for the one thing a reader must not miss." }
    examples:
      hit: ["<eval corpus ref: core/structure-005-hit-01>"]
      miss: ["<eval corpus ref: core/structure-005-miss-01>"]
  - id: core.repetition.001
    category: repetition
    severity: warn
    match: { kind: sentence_metric, metric: similarity_to_prior, above: 0.7 }
    instruction: { action: merge, text: "Remove this sentence or merge it with the earlier one that says the same thing." }
    examples:
      hit: ["The cache is per tenant. Each tenant has its own cache."]
      miss: ["The cache is per tenant. The queue is shared."]
`;

/** A complete rule-pack document with one rule, for schema tests that vary a single field. */
export function packYaml(ruleExtra = "", head: { id?: string; version?: string; findings?: string } = {}): string {
  return `schema: prosegate.rulepack/1
id: ${head.id ?? "core"}
version: ${head.version ?? "0.1.0"}
findings_schema: ${head.findings ?? "1"}
rules:
  - id: core.hedge.001
    category: hedge
    severity: block
    match: { kind: phrase, phrases: ["it is worth noting"] }
    instruction: { action: remove, text: "Remove." }
    examples: { hit: ["It is worth noting x."], miss: ["x."] }
${ruleExtra}`;
}

/** A pack with one rule whose instruction text is `text` (YAML-quoted via JSON). */
export function packWithInstruction(text: string): string {
  return `schema: prosegate.rulepack/1
id: core
version: 0.1.0
findings_schema: 1
rules:
  - id: core.hedge.001
    category: hedge
    severity: block
    match: { kind: phrase, phrases: ["it is worth noting"] }
    instruction: { action: remove, text: ${JSON.stringify(text)} }
    examples: { hit: ["It is worth noting x."], miss: ["x."] }
`;
}

/** A profile document: header lines plus a body (already indented as top-level YAML). */
export function profileYaml(id: string, body = "", opts: { version?: number; extends?: string; name?: string } = {}): string {
  const lines = [
    "schema: prosegate.profile/1",
    `id: ${id}`,
    `version: ${opts.version ?? 1}`,
    `name: ${opts.name ?? id}`,
  ];
  if (opts.extends !== undefined) lines.push(`extends: ${opts.extends}`);
  return `${lines.join("\n")}\n${body}\n`;
}

/** Sources with every profile signed and the given pack versions (signed) available. */
export function makeSources(
  profiles: Record<string, string>,
  packs: Record<string, string[]> = { core: ["0.1.0"] },
): ResolutionSources {
  return {
    profiles: Object.fromEntries(Object.entries(profiles).map(([id, yaml]) => [id, { yaml, signed: true }])),
    packs: Object.fromEntries(Object.entries(packs).map(([id, versions]) => [id, versions.map((version) => ({ version, signed: true }))])),
  };
}

export const CORE_PIN = "rule_packs:\n  - { id: core, version: \">=0.1.0 <1.0.0\" }";
