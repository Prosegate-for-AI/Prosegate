import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { HarnessError, loadCorpora } from "../runners/rules-corpus.js";
import { BUNDLED_PROFILE_NAMES } from "../runners/rules-eval.js";
import { annotationDir, qualified } from "./annotations.js";
import { hash, within } from "./common.js";
import { promptFor } from "./corpus.js";

/** Explicit admission step: no download, generated gold, licence inference or overwrite. */
export function importCorpus(source: string, destination: string, privateCorpus: boolean) {
  const corpus = loadCorpora(source, BUNDLED_PROFILE_NAMES);
  const docs = [...corpus.humanControl, ...corpus.ai, ...corpus.advHumanMachinelike, ...corpus.advAiPassed];
  if (!docs.length) throw new HarnessError("No documents to import.");
  const existing = existsSync(destination) ? loadCorpora(destination, BUNDLED_PROFILE_NAMES) : null;
  const fingerprints = new Set(existing ? [...existing.humanControl, ...existing.ai, ...existing.advHumanMachinelike, ...existing.advAiPassed].map((d) => hash(d.text.normalize("NFKC").replace(/\s+/g, " ").trim())) : []);
  const writes = new Map<string, Buffer>();
  const add = (rel: string) => {
    const target = within(destination, rel), content = readFileSync(within(source, rel));
    if (existsSync(target)) {
      if (rel.startsWith(".prompts/") && readFileSync(target).equals(content)) return;
      throw new HarnessError("Import would overwrite an existing document or different prompt.");
    }
    writes.set(target, content);
  };
  for (const d of docs) {
    const fingerprint = hash(d.text.normalize("NFKC").replace(/\s+/g, " ").trim());
    if (fingerprints.has(fingerprint)) throw new HarnessError("Duplicate text would inflate the corpus.");
    fingerprints.add(fingerprint);
    const file = within(source, d.path);
    if (d.kind === "human-control" || d.kind === "adversarial-human-machinelike") {
      const permission = d.meta.redistribution as { permitted?: boolean; evidence?: string } | undefined;
      if (!privateCorpus && (permission?.permitted !== true || !permission.evidence)) throw new HarnessError("Public import requires a recorded redistribution permission and evidence. Use a private corpus for consented private writing.");
    }
    if (d.kind !== "human-control") {
      if (!qualified(file, typeof d.meta.prompt_file === "string" ? within(source, d.meta.prompt_file) : undefined)) throw new HarnessError("Import requires two context-bound annotations and adjudicated gold.");
      const annotations = annotationDir(file);
      for (const name of readdirSync(annotations)) add(relative(source, join(annotations, name)));
    }
    if (d.kind === "ai" || d.kind === "adversarial-ai-passed") {
      promptFor(source, d);
      const promptPath = d.meta.prompt_file as string;
      if (!promptPath.startsWith(".prompts/")) throw new HarnessError("Imported prompt files must live in .prompts/.");
      add(promptPath);
    }
    add(d.path);
    add(d.path.replace(/\.md$/, ".meta.json"));
    const gold = d.path.replace(/\.md$/, ".gold.json");
    if (existsSync(within(source, gold))) add(gold);
  }
  // Every item has been validated before the first write; exclusive creates prevent overwrites.
  for (const [target, content] of writes) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { flag: "wx", mode: 0o600 });
  }
  return { result: "pass", documents: docs.length, files: writes.size, private_corpus: privateCorpus };
}
