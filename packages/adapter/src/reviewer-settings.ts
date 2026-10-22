import { join } from "node:path";
import type { ReviewerProvider } from "@prosegate/schema";
import type { Ctx } from "./ctx.js";
import { ensureDirIn, readFileOrNull, writeFileAtomic } from "./fs-secure.js";

/** Explicit local consent; absent or malformed settings never enable network calls. */
export function automaticReviewer(ctx: Ctx): ReviewerProvider | null {
  try {
    const raw = readFileOrNull(join(ctx.home, "automatic-reviewer.json"));
    if (raw === null || raw.length > 1024) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    return value.v === 1 && Object.keys(value).every((k) => k === "v" || k === "provider") &&
      (value.provider === "openai" || value.provider === "anthropic") ? value.provider : null;
  } catch { return null; }
}

export function setAutomaticReviewer(ctx: Ctx, provider: ReviewerProvider | null): void {
  ensureDirIn(ctx.home, ctx.home, ctx.platform);
  writeFileAtomic(join(ctx.home, "automatic-reviewer.json"), JSON.stringify({ v: 1, provider }) + "\n");
}

export function automaticReviewerStatus(ctx: Ctx): string {
  const provider = automaticReviewer(ctx);
  return `Automatic AI reviewer: ${provider === null ? "off" : `${provider} (eligible Stop-hook drafts; uses your API account)`}`;
}
