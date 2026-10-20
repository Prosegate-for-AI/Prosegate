import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { analyse } from "@prosegate/segmenter";
import { loadCorpora, HarnessError, validateGold, validateHumanMeta, type CorpusDoc } from "../runners/rules-corpus.js";
import { BUNDLED_PROFILE_NAMES } from "../runners/rules-eval.js";
import { annotationSummary, qualified, readAnnotations } from "./annotations.js";
import { hash, json, profile, PromptSchema, within } from "./common.js";

const RubricSchema = z.strictObject({
  schema: z.literal("prosegate.rubric/1"),
  items: z.array(z.strictObject({ path: z.string(), profile: z.enum(["base", "pr-description", "design-doc", "email", "chat-reply"]), origin: z.enum(["ai", "handwritten"]), prompt_file: z.string() })),
});
export function promptFor(root: string, doc: CorpusDoc) {
  const path = doc.meta.prompt_file;
  if (typeof path !== "string") throw new HarnessError("AI item needs a saved prompt.");
  const prompt = PromptSchema.parse(json(within(root, path)));
  if (prompt.profile !== doc.profile) throw new HarnessError("Prompt and corpus profile differ.");
  return prompt;
}
export function loadRubric(root: string): CorpusDoc[] {
  const file = join(root, "rubric.json");
  if (!existsSync(file)) return [];
  const manifest = RubricSchema.parse(json(file));
  const ai = loadCorpora(root, BUNDLED_PROFILE_NAMES).ai;
  const seen = new Set<string>();
  const contents = new Set<string>();
  return manifest.items.map((item) => {
    if (!item.path.endsWith(".md") || seen.has(item.path)) throw new HarnessError("Rubric items must be unique .md paths.");
    seen.add(item.path);
    const path = within(root, item.path);
    const contentHash = hash(readFileSync(path, "utf8").normalize("NFKC").replace(/\s+/g, " ").trim());
    if (contents.has(contentHash)) throw new HarnessError("Duplicate rubric text would inflate sample size.");
    contents.add(contentHash);
    if (item.origin === "ai") {
      const doc = ai.find((d) => d.path === item.path && d.profile === item.profile);
      if (!doc || doc.meta.prompt_file !== item.prompt_file) throw new HarnessError("AI rubric item does not match the AI corpus.");
      promptFor(root, doc);
      return doc;
    }
    if (!item.path.startsWith("rubric/")) throw new HarnessError("Handwritten rubric items must live under rubric/.");
    const text = readFileSync(path, "utf8");
    const problems: string[] = [];
    const meta = json(path.replace(/\.md$/, ".meta.json"));
    validateHumanMeta(meta, item.path, problems);
    const gold = validateGold(json(path.replace(/\.md$/, ".gold.json")), text, item.path, problems);
    if (problems.length || !text.trim()) throw new HarnessError("Invalid handwritten rubric document, licence or gold.");
    const doc: CorpusDoc = { kind: "human-control", path: item.path, id: item.path, profile: item.profile, text, gold, meta: { ...(meta as Record<string, unknown>), prompt_file: item.prompt_file } };
    promptFor(root, doc);
    return doc;
  });
}
export function corpusAudit(root: string, privateCorpus = false) {
  const corpora = loadCorpora(root, BUNDLED_PROFILE_NAMES);
  const rubric = loadRubric(root);
  const all = [...corpora.humanControl, ...corpora.ai, ...corpora.advAiPassed, ...corpora.advHumanMachinelike];
  const unique = new Map<string, string>();
  for (const d of all) {
    const key = hash(d.text.normalize("NFKC").replace(/\s+/g, " ").trim());
    if (unique.has(key)) throw new HarnessError("Duplicate corpus text would inflate sample size.");
    unique.set(key, d.path);
    if (d.kind === "ai" || d.kind === "adversarial-ai-passed") promptFor(root, d);
  }
  const paired = [];
  let adjudicated = 0;
  for (const d of rubric) {
    const file = within(root, d.path);
    const records = readAnnotations(file);
    if (records.length === 2 && records[0] && records[1]) paired.push({ text: d.text, first: records[0].spans, second: records[1].spans });
    if (qualified(file, within(root, d.meta.prompt_file as string))) adjudicated++;
  }
  const byProfile = Object.fromEntries(BUNDLED_PROFILE_NAMES.map((name) => {
    const human = corpora.humanControl.filter((d) => d.profile === name);
    const ai = corpora.ai.filter((d) => d.profile === name);
    const families = [...new Set(ai.map((d) => d.meta.model))];
    const floor = profile(name).thresholds.token_floor_words;
    return [name, { human: human.length, ai: ai.length, pre_2022_human: human.filter((d) => Number(String(d.meta.date).slice(0, 4)) < 2022).length,
      models: new Set(ai.map((d) => d.meta.model)).size,
      model_versions: new Set(ai.map((d) => d.meta.model_version)).size,
      families_with_two_generations: families.filter((f) => new Set(ai.filter((d) => d.meta.model === f).map((d) => d.meta.generation).filter((g) => typeof g === "string")).size >= 2).length,
      eligible_human: human.filter((d) => { const a = analyse(d.text); return a.prose_words >= floor && a.language !== "non_en"; }).length }];
  }));
  const notes: string[] = [];
  const humanItems = [...corpora.humanControl, ...corpora.advHumanMachinelike, ...rubric.filter((d) => d.kind === "human-control")];
  if (!privateCorpus && humanItems.some((d) => {
    const permission = d.meta.redistribution as { permitted?: boolean; evidence?: string } | undefined;
    return permission?.permitted !== true || !permission.evidence;
  })) notes.push("Public corpus items require recorded redistribution permission and evidence.");
  if (Object.values(byProfile).filter((p) => p.human >= 300 && p.eligible_human >= 300).length < 3) notes.push("Need 300 eligible human-control documents for each of at least three profiles.");
  if (Object.values(byProfile).filter((p) => p.ai >= 200 && p.models >= 4 && p.model_versions >= 8 && p.families_with_two_generations >= 4).length < 3) notes.push("Need 200 AI documents per profile, covering four models across two generations, for at least three profiles.");
  if (Object.values(byProfile).filter((p) => p.eligible_human >= 300 && p.ai >= 200 && p.model_versions >= 8 && p.families_with_two_generations >= 4).length < 3) notes.push("Human and AI coverage must qualify the same three profiles.");
  if (rubric.length < 150 || adjudicated !== rubric.length || rubric.filter((d) => d.kind === "human-control").length < 30) notes.push("Need 150 adjudicated rubric drafts, including 30 handwritten drafts.");
  if (corpora.advHumanMachinelike.length < 100 || corpora.advAiPassed.length < 100) notes.push("Need 100 labelled adversarial documents of each kind.");
  const labelled = [...corpora.ai, ...corpora.advHumanMachinelike, ...corpora.advAiPassed];
  if (labelled.some((d) => !qualified(within(root, d.path), typeof d.meta.prompt_file === "string" ? within(root, d.meta.prompt_file) : undefined))) notes.push("Some AI/adversarial documents lack context-bound annotations and adjudication.");
  const uniqueAnnotated = [...new Map([...corpora.ai, ...rubric, ...corpora.advHumanMachinelike, ...corpora.advAiPassed].map((d) => [d.path, d])).values()];
  const agreements = annotationSummary(root, uniqueAnnotated).categories;
  if (Object.values(agreements).some((a) => !a.gate_eligible)) notes.push("Some categories have undefined or below-0.6 annotation agreement; revise guidelines before gating them.");
  return { result: notes.length ? "partial" : "pass", by_profile: byProfile, rubric: { drafts: rubric.length, adjudicated, paired: paired.length }, agreement: agreements, adversarial: { human: corpora.advHumanMachinelike.length, ai: corpora.advAiPassed.length }, notes };
}
