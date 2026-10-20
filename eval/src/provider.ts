import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { findKeyShapedStrings } from "@prosegate/schema";
import { HarnessError } from "../runners/rules-corpus.js";

export const ModelSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
  provider: z.enum(["openai", "anthropic"]),
  family: z.string().min(1).max(80),
  generation: z.string().min(1).max(80),
  input_usd_per_million: z.number().positive().finite(),
  output_usd_per_million: z.number().positive().finite(),
  pricing_checked_on: z.iso.date(),
  max_output_tokens: z.number().int().min(2048).max(16000),
});
export type Model = z.infer<typeof ModelSchema>;
export type Message = { role: "user" | "assistant"; content: string };
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const endpoint = (provider: Model["provider"]) => provider === "openai" ? "https://api.openai.com/v1/responses" : "https://api.anthropic.com/v1/messages";
const usageSchema = z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() });

/** Append the reservation before transmission. Failures/timeouts retain their full reservation.
 * The cap is conservative at the operator-supplied prices, not a provider billing guarantee. */
export class Spend {
  reserved_usd = 0;
  measured_usd = 0;
  exhausted = false;
  attempts: Array<{ model: string; response: unknown; ms: number; ok: boolean }> = [];
  constructor(readonly cap: number, readonly models: Model[], readonly ledger: string, readonly fetcher: typeof fetch = fetch) {
    if (!Number.isFinite(cap) || cap <= 0 || cap > 1000) throw new HarnessError("Cost cap must be greater than zero and at most 1000 USD.");
    for (const model of models) {
      ModelSchema.parse(model);
      const age = Date.now() - Date.parse(model.pricing_checked_on);
      if (age < -86400000 || age > 31 * 86400000) throw new HarnessError("Verify model prices and set pricing_checked_on within the last 31 days.");
    }
    if (new Set(models.map((m) => m.id)).size !== models.length) throw new HarnessError("Model IDs must be unique.");
    mkdirSync(dirname(ledger), { recursive: true });
    writeFileSync(ledger, `${JSON.stringify({ schema: "prosegate.eval-spend/1", cap_usd: cap, pricing: models })}\n`, { flag: "wx", mode: 0o600 });
  }
  fetch: typeof fetch = async (url, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const parsed = record(JSON.parse(body) as unknown);
    const model = this.models.find((m) => m.id === parsed.model);
    const output = parsed.max_output_tokens ?? parsed.max_tokens;
    if (!model || String(url) !== endpoint(model.provider) || typeof output !== "number" || !Number.isSafeInteger(output) || output < 1 || output > model.max_output_tokens) throw new HarnessError("Request does not match the priced model or output limit.");
    // UTF-8 bytes overestimate normal text tokens; 8192 covers message/schema framing.
    const inputBound = Buffer.byteLength(body, "utf8") + 8192;
    const reserve = Math.ceil((inputBound * model.input_usd_per_million + output * model.output_usd_per_million)) / 1e6;
    if (this.exhausted || this.reserved_usd + reserve > this.cap) {
      this.exhausted = true;
      throw new HarnessError("Run stopped before the next request: cost cap reached.");
    }
    appendFileSync(this.ledger, `${JSON.stringify({ event: "reserve", model: model.id, usd: reserve })}\n`);
    this.reserved_usd += reserve;
    const start = performance.now();
    let response: unknown = null;
    let ok = false;
    try {
      const signal = AbortSignal.any([AbortSignal.timeout(60000), ...(init?.signal ? [init.signal] : [])]);
      const res = await this.fetcher(url, { ...init, signal, redirect: "error" });
      if (!res.ok) { await res.body?.cancel(); throw new HarnessError("Provider request failed; response body was discarded."); }
      const reader = res.body?.getReader();
      if (!reader) throw new HarnessError("Provider returned no body.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 1024 * 1024) { await reader.cancel(); throw new HarnessError("Provider response exceeded the size limit."); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const text = Buffer.concat(chunks).toString("utf8");
      response = JSON.parse(text) as unknown;
      const usage = usageSchema.parse(record(response).usage);
      const charge = (usage.input_tokens * model.input_usd_per_million + usage.output_tokens * model.output_usd_per_million) / 1e6;
      this.measured_usd += charge;
      appendFileSync(this.ledger, `${JSON.stringify({ event: "usage", model: model.id, ...usage, usd: charge })}\n`);
      if (usage.input_tokens > inputBound || usage.output_tokens > output || charge > reserve) {
        this.exhausted = true;
        throw new HarnessError("Provider usage exceeded its reservation; run stopped.");
      }
      ok = true;
      return new Response(text, { status: res.status, headers: { "Content-Type": "application/json" } });
    } catch (e) {
      if (e instanceof HarnessError) throw e;
      throw new HarnessError("Provider transport or response validation failed; the reservation is retained.");
    } finally { this.attempts.push({ model: model.id, response, ms: performance.now() - start, ok }); }
  };
  summary() {
    return { cap_usd: this.cap, reserved_usd: this.reserved_usd, measured_usd: this.measured_usd, attempts: this.attempts.length, exhausted: this.exhausted, pricing: this.models };
  }
}
export function apiKey(model: Model, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[model.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"];
  if (!value || !/^[\x21-\x7e]{1,1000}$/.test(value)) throw new HarnessError(`Set the ${model.provider} API key in the environment before a live evaluation.`);
  return value;
}
export function rawFindings(response: unknown, provider: Model["provider"]): unknown {
  const r = record(response);
  if (provider === "anthropic") {
    if (r.stop_reason !== "tool_use" || !Array.isArray(r.content)) return null;
    const calls = r.content.filter((x) => record(x).type === "tool_use");
    return calls.length === 1 && record(calls[0]).name === "report_findings" ? record(calls[0]).input : null;
  }
  try { return JSON.parse(completionText(response, "openai")) as unknown; } catch { return null; }
}
export function completionText(response: unknown, provider: Model["provider"]): string {
  const r = record(response);
  let pieces: unknown[];
  if (provider === "openai") {
    if (r.status !== "completed" || !Array.isArray(r.output)) throw new HarnessError("Incomplete model output.");
    pieces = r.output.flatMap((item) => record(item).type === "message" && Array.isArray(record(item).content) ? record(item).content as unknown[] : []);
  } else {
    if (r.stop_reason !== "end_turn" || !Array.isArray(r.content)) throw new HarnessError("Incomplete model output.");
    pieces = r.content;
  }
  if (pieces.length !== 1 || record(pieces[0]).type !== (provider === "openai" ? "output_text" : "text") || typeof record(pieces[0]).text !== "string") throw new HarnessError("Expected one completed text response.");
  return record(pieces[0]).text as string;
}
export async function complete(model: Model, system: string, messages: Message[], spend: Spend, key = apiKey(model)): Promise<string> {
  const body = model.provider === "openai"
    ? { model: model.id, instructions: system, input: messages, max_output_tokens: model.max_output_tokens, store: false, stream: false }
    : { model: model.id, system, messages, max_tokens: model.max_output_tokens };
  const res = await spend.fetch(endpoint(model.provider), {
    method: "POST", body: JSON.stringify(body),
    headers: model.provider === "openai" ? { "Content-Type": "application/json", Authorization: `Bearer ${key}` } : { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
  const text = completionText(await res.json() as unknown, model.provider);
  if (!text.trim() || text.length > 100 * 1024 || text.includes(key) || findKeyShapedStrings(text).length) throw new HarnessError("Model output was empty, oversized or contained a credential-shaped string.");
  return text;
}
