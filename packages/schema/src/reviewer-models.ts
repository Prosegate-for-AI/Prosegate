/** Transport candidates, not a claim that the live rubric/latency release gates have passed. ADR-35. */
export const REVIEWER_MODELS = ["gpt-5.4-mini-2026-03-17", "claude-haiku-5-5"] as const;
export type ReviewerModel = (typeof REVIEWER_MODELS)[number];
export type ReviewerProvider = "openai" | "anthropic";
export const REVIEWER_MODEL_BY_PROVIDER: Record<ReviewerProvider, ReviewerModel> = {
  openai: REVIEWER_MODELS[0],
  anthropic: REVIEWER_MODELS[1],
};
