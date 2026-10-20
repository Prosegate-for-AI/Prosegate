import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { bundledPackSources, bundledProfileSources, resolveProfile } from "@prosegate/profiles";
import type { ReviewRequest } from "@prosegate/schema";
import { BUNDLED_PROFILE_NAMES } from "../runners/rules-eval.js";
import { HarnessError } from "../runners/rules-corpus.js";

export const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
export const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8")) as unknown;
export function writeNew(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
export function within(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(resolve(root), target);
  if (isAbsolute(path) || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new HarnessError("path must stay inside corpus root");
  return target;
}
export const ProfileName = z.string().refine((s) => BUNDLED_PROFILE_NAMES.includes(s), "unknown bundled profile");
export const PromptSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  profile: ProfileName,
  system: z.string().max(8000),
  user: z.string().min(1).max(16000),
  style_constraints: z.string().max(1500),
});
export type Prompt = z.infer<typeof PromptSchema>;
export const systemFor = (prompt: Prompt): string => prompt.style_constraints ? `${prompt.system}\n\nStyle constraints:\n${prompt.style_constraints}` : prompt.system;
export function profile(name: string) {
  return resolveProfile(`local/${name}`, { profiles: bundledProfileSources(), packs: bundledPackSources() });
}
export function request(text: string, name: string, prompt: Pick<Prompt, "user" | "style_constraints">, pass: 1 | 2 = 1, prior: string[] = []): ReviewRequest {
  return { schema: "prosegate.review/1", text, context: { user_message: prompt.user, style_constraints: prompt.style_constraints, mode: "headless" }, profile_id: `local/${name}`, pass, stages: ["rules", "reviewer"], session_id: "eval", turn_id: "eval", prior_findings: prior };
}
export function report(dir: string, kind: string, data: object): string {
  let sha = "nosha";
  let dirty: boolean | null = null;
  try {
    sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== "";
  } catch { /* Detached copies still produce usable reports. */ }
  const now = new Date().toISOString();
  const path = resolve(dir, `${now.slice(0, 10)}-${sha}-${kind}-${randomUUID().slice(0, 8)}.json`);
  writeNew(path, { schema: `prosegate.eval-${kind}/1`, generated_at: now, git: { sha, dirty }, ...data });
  return path;
}
export function args(argv: string[], allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i] as string;
    if (key === "--") continue;
    if (key === "--help") { out.help = "true"; continue; }
    if (!key.startsWith("--") || !allowed.includes(key.slice(2)) || out[key.slice(2)] !== undefined) throw new HarnessError(`unknown or repeated option ${key}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new HarnessError(`${key} needs a value`);
    out[key.slice(2)] = value;
  }
  return out;
}
export function required(options: Record<string, string>, key: string): string {
  const value = options[key];
  if (!value) throw new HarnessError(`--${key} is required`);
  return value;
}
export function cliError(error: unknown): void {
  // Zod/provider exceptions can contain corpus text. Never print them wholesale.
  console.error(error instanceof HarnessError ? error.message : "Evaluation failed: invalid input or unavailable provider. Check the input schemas and run report.");
  process.exitCode = 2;
}
