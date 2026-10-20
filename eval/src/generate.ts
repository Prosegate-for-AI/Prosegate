import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { HarnessError } from "../runners/rules-corpus.js";
import { hash, PromptSchema, systemFor, writeNew } from "./common.js";
import { apiKey, complete, ModelSchema, Spend } from "./provider.js";

export const GenerationPlan = z.strictObject({
  schema: z.literal("prosegate.generation-plan/1"),
  models: z.array(ModelSchema).min(1).max(32),
  prompts: z.array(PromptSchema).min(1).max(1000),
  samples_per_prompt: z.number().int().min(1).max(100),
});
export async function generate(raw: unknown, output: string, spend: Spend) {
  const plan = GenerationPlan.parse(raw);
  if (existsSync(output)) throw new HarnessError("Generation output must be a new staging directory.");
  if (new Set(plan.prompts.map((p) => p.id)).size !== plan.prompts.length) throw new HarnessError("Prompt IDs must be unique.");
  // Validate every credential before the first paid request; never read the app's key store.
  const keys = new Map(plan.models.map((m) => [m.id, apiKey(m)]));
  mkdirSync(output, { recursive: true });
  for (const prompt of plan.prompts) writeNew(join(output, ".prompts", `${prompt.id}.json`), prompt);
  let documents = 0;
  let error: string | null = null;
  try {
    for (const model of plan.models) for (const prompt of plan.prompts) for (let sample = 0; sample < plan.samples_per_prompt; sample++) {
      const text = await complete(model, systemFor(prompt), [{ role: "user", content: prompt.user }], spend, keys.get(model.id));
      const stem = `${prompt.id}-${hash(model.id).slice(0, 12)}-${sample + 1}`;
      const dir = join(output, "ai", prompt.profile);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${stem}.md`), text, { flag: "wx", mode: 0o600 });
      writeNew(join(dir, `${stem}.meta.json`), { model: model.family, model_version: model.id, generation: model.generation, prompt_file: `.prompts/${prompt.id}.json`, generated_at: new Date().toISOString() });
      // No empty gold file: these documents have not been annotated.
      documents++;
    }
  } catch (e) { error = e instanceof HarnessError ? e.message : "Generation failed."; }
  return { result: error ? "fail" : "pass", documents, planned_documents: plan.models.length * plan.prompts.length * plan.samples_per_prompt, annotation_status: "pending", error, spend: spend.summary() };
}
