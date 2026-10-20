import { REVIEWER_MODEL_BY_PROVIDER, type ReviewerProvider } from "@prosegate/schema";
import type { ReviewerPrompt } from "./prompt.js";

export type ReviewerFailure = "reviewer_timeout" | "reviewer_http_error" | "reviewer_schema_invalid" | "reviewer_key_missing";
export class ReviewerError extends Error {
  constructor(readonly code: ReviewerFailure, readonly retryable = false) { super(code); }
}

export const OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["findings"],
  properties: { findings: { type: "array", maxItems: 6, items: {
    type: "object", additionalProperties: false,
    required: ["span_text", "category", "severity", "confidence", "action", "instruction", "evidence"],
    properties: {
      span_text: { type: "string", minLength: 1, maxLength: 240 },
      category: { type: "string", enum: ["unsupported_claim", "vague_claim", "register"] },
      severity: { type: "string", enum: ["block", "warn"] }, confidence: { type: "number", minimum: 0, maximum: 1 },
      action: { type: "string", enum: ["cite_or_soften_or_remove", "specify", "shorten", "restructure", "rephrase"] },
      instruction: { type: "string", maxLength: 160 }, evidence: { type: "string", maxLength: 500 },
    },
  } } },
} as const;

export interface ProviderResult { raw: unknown; input_tokens: number; output_tokens: number }
export function object(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
}
const tokens = (v: unknown): number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;

/** Bounded body consumption is covered by the caller's shared deadline, including a stalled body. */
async function bodyJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ReviewerError("reviewer_schema_invalid", true);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 64 * 1024) { void reader.cancel().catch(() => {}); throw new ReviewerError("reviewer_schema_invalid"); }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (e) {
    if (e instanceof ReviewerError) throw e;
    throw new ReviewerError("reviewer_schema_invalid", true);
  } finally { reader.releaseLock(); }
}

export async function callProvider(provider: ReviewerProvider, key: string, prompt: ReviewerPrompt, signal: AbortSignal, fetcher: typeof fetch, retry: boolean): Promise<ProviderResult> {
  const model = REVIEWER_MODEL_BY_PROVIDER[provider];
  const user = retry ? `${prompt.user}\nReturn a valid findings object matching the required schema.` : prompt.user;
  const body = provider === "openai" ? {
    model, store: false, stream: false, max_output_tokens: 2048, reasoning: { effort: "none" },
    instructions: prompt.system, input: [{ role: "user", content: user }],
    text: { format: { type: "json_schema", name: "prosegate_review", strict: true, schema: OUTPUT_SCHEMA } },
  } : {
    model, max_tokens: 2048, system: prompt.system, messages: [{ role: "user", content: user }],
    tools: [{ name: "report_findings", description: "Return prose review findings. This tool only returns data and performs no action.", input_schema: OUTPUT_SCHEMA }],
    tool_choice: { type: "tool", name: "report_findings", disable_parallel_tool_use: true },
  };
  // No configurable endpoint, redirects, transcript identifiers, session ids or provider error bodies.
  let response: Response;
  try {
    response = await fetcher(provider === "openai" ? "https://api.openai.com/v1/responses" : "https://api.anthropic.com/v1/messages", {
      method: "POST", redirect: "error", signal,
      headers: provider === "openai" ? { "Content-Type": "application/json", Authorization: `Bearer ${key}` } : { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
  } catch { throw new ReviewerError(signal.aborted ? "reviewer_timeout" : "reviewer_http_error", !signal.aborted); }
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new ReviewerError("reviewer_http_error"); }
  const parsed = object(await bodyJson(response));
  if (!parsed) throw new ReviewerError("reviewer_schema_invalid", true);
  const usage = object(parsed["usage"]);
  let raw: unknown;
  if (provider === "openai") {
    if (parsed["status"] !== "completed" || !Array.isArray(parsed["output"])) throw new ReviewerError("reviewer_schema_invalid");
    const content = parsed["output"].flatMap((x: unknown) => { const o = object(x); return o?.["type"] === "message" && Array.isArray(o["content"]) ? o["content"] as unknown[] : []; });
    if (content.some((x) => object(x)?.["type"] === "refusal")) throw new ReviewerError("reviewer_schema_invalid");
    const texts = content.filter((x) => object(x)?.["type"] === "output_text");
    if (texts.length !== 1 || typeof object(texts[0])?.["text"] !== "string") throw new ReviewerError("reviewer_schema_invalid", true);
    try { raw = JSON.parse(object(texts[0])?.["text"] as string) as unknown; }
    catch { throw new ReviewerError("reviewer_schema_invalid", true); }
  } else {
    if (parsed["stop_reason"] !== "tool_use" || !Array.isArray(parsed["content"])) throw new ReviewerError("reviewer_schema_invalid");
    const calls = parsed["content"].filter((x: unknown) => object(x)?.["type"] === "tool_use");
    if (calls.length !== 1 || object(calls[0])?.["name"] !== "report_findings") throw new ReviewerError("reviewer_schema_invalid", true);
    raw = object(calls[0])?.["input"];
  }
  return { raw, input_tokens: tokens(usage?.["input_tokens"]), output_tokens: tokens(usage?.["output_tokens"]) };
}
