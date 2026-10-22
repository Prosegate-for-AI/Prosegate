/** Trusted contextual rubric. Words and punctuation are clues, never sufficient evidence. */
// Exploratory live exception checks exposed false positives at the old 0.6 floor.
// This is a conservative operating threshold, not a calibrated probability.
export const WRITING_CONFIDENCE_MIN = 0.7;
/** The writing profile's floor also covers legacy labels, so null check_id cannot bypass it. */
export function reviewerConfidenceFloor(profileChain: readonly string[], catalogCheck = false): number {
  return catalogCheck || profileChain.includes("local/writing-review") ? WRITING_CONFIDENCE_MIN : 0.6;
}
export interface WritingCheck {
  id: string;
  defect: string;
  exception: string;
  instruction: string;
  category: "register" | "unsupported_claim";
  requiresOriginal?: boolean;
}

const check = (id: string, defect: string, exception: string, instruction: string, category: WritingCheck["category"] = "register", requiresOriginal = false): WritingCheck =>
  ({ id, defect, exception, instruction, category, requiresOriginal });

export const WRITING_CHECKS: readonly WritingCheck[] = [
  check("inflated-contrast", "Not just X but Y adds emphasis without a real distinction.", "A factual correction, exclusion or meaningful contrast.", "State the actual distinction directly; remove the inflated contrast."),
  check("slogan-fragments", "Adjacent rhythmic fragments replace a useful statement.", "Short warnings, concrete steps or independently meaningful statements.", "Connect the fragments into a concrete statement of what happens."),
  check("ornamental-triad", "Three adjectives or abstract benefits repeat one idea for rhythm.", "Three distinct requirements, effects or requested items.", "Keep the distinct information and remove the ornamental list."),
  check("negative-parallelism", "Repeated no or not constructions stage an argument without adding distinctions.", "Necessary exclusions, prohibitions or corrections.", "State the positive point directly while preserving necessary exclusions."),
  check("punctuation-rhythm", "Repeated colon, semicolon or dash beats manufacture emphasis without clarifying relationships.", "Punctuation separates real clauses, list items, contrasts or logical links.", "Simplify the punctuation and make the actual relationships explicit."),
  check("padded-enumeration", "A catalogue adds items without useful distinctions.", "Requested exhaustive lists, reference material or distinct items.", "Remove redundant items while preserving every distinct requirement."),
  check("strained-metaphor", "A metaphor obscures the operational fact or mixes incompatible images.", "A clear established domain term or an analogy that explains the mechanism.", "Replace the metaphor with the concrete action or result."),
  check("canned-empathy", "Stock empathy assumes feelings or intensity the user did not express.", "Brief specific acknowledgment of feelings the user actually expressed, even before the answer and without adding factual information. Stronger feelings than expressed are not exempt.", "Remove the assumed emotion or acknowledge only what the user expressed."),
  check("empty-balance", "Benefits and challenges are balanced rhetorically without naming a tradeoff.", "Real competing effects, conditions or uncertainty.", "Name the actual tradeoff and its conditions, or remove the balancing phrase."),
  check("manufactured-significance", "Claims of pivotal importance, legacy or trends exceed the supplied basis.", "Significance explained with specific supported consequences.", "State the supported consequence and remove the inflated significance."),
  check("promotional-tone", "Promotional praise intrudes into informational writing.", "Requested marketing copy or concrete warranted descriptions; marketing does not excuse unsupported facts.", "Replace the promotional praise with the relevant concrete property."),
  check("abstract-cluster", "Several stock abstractions obscure actors, actions or results.", "Accurate technical terms needed by the audience.", "Name who acts, what changes and the observable result."),
  check("empty-benefit", "A claim of value, impact or alignment gives no observable benefit.", "The benefit and beneficiary are recoverable from nearby context.", "Specify the observable benefit and who receives it, or remove the claim."),
  check("unsupported-causality", "An ensuring, thereby or leading-to tail asserts a causal consequence without a supplied link.", "The causal mechanism or supporting evidence is supplied, or the uncertainty is explicit.", "Preserve the fact and qualify or remove the unsupported causal consequence.", "unsupported_claim"),
  check("unattributed-authority", "Experts, research or consensus is invoked without an identifiable supplied source.", "An identifiable source in the draft or supplied evidence, a quotation, or a user assertion.", "Identify a source actually supplied, qualify the claim or remove the appeal to authority.", "unsupported_claim"),
  check("unspecified-comparison", "A comparison lacks the baseline or dimension needed to interpret it.", "The baseline and dimension are clear from context; no invented measurement is needed.", "Give the comparison baseline and dimension if known; otherwise state the limit."),
  check("missing-actor", "An actor, recipient, object or event cannot be identified because a reference has no antecedent or multiple plausible antecedents. Missing context is evidence of the defect, not a reason to abstain.", "The referent is clear from the draft or supplied context, or the pronoun is intentionally generic. Concrete task nouns and roles need not include proper names or IDs; passive voice alone is not a defect.", "Identify the unresolved referents; ask for missing details rather than inventing them."),
  check("process-for-rationale", "A description of review or alignment substitutes for the decision reason.", "The actual question concerns process, or approval is a necessary constraint.", "State the decision reason and retain any necessary approval constraint."),
  check("meaning-lost", "Compared with original_text, the revision drops or changes a material object, condition, exception, contrast, number or attribution.", "No original is supplied, the meaning is preserved (including synonyms, equivalent units and paraphrased conditions), or the user explicitly requested the omission or correction.", "Restore the material meaning from the original unless the requested revision changes it.", "register", true),
  check("undefined-concept", "A central substantive concept has no recoverable meaning in context.", "The concept is defined nearby or established for the stated audience.", "Explain the actual concept using available context; do not invent a definition."),
  check("verbal-padding", "A longer verbal construction adds no meaning over a direct one.", "A quotation, a technical term or wording whose replacement changes meaning.", "Remove the verbal padding while preserving the original meaning."),
  check("bureaucratic-circumlocution", "Administrative wording conceals a simple actor and action.", "A required formal term, quotation or precise legal distinction.", "State the actor and action directly while retaining required formal terms."),
  check("stacked-uncertainty", "Multiple hedges repeat the same uncertainty.", "Necessary uncertainty, separate uncertainty dimensions, or may expressing permission.", "Keep one accurate uncertainty statement and its reason; remove redundant hedges."),
  check("noun-chain", "Compressed abstract nouns conceal actions or relationships.", "An established domain term that the audience understands.", "Expand the noun chain into explicit actors, actions and relationships."),
  check("indirect-statement", "Reads, feels or is framed substitutes for the intended concrete statement or comparison.", "Perception, appearance or framing is itself the subject.", "State the intended change or comparison directly."),
  check("audience-jargon", "Recoverable meaning is phrased in jargon that adds difficulty without precision for this audience.", "Technical precision is useful to the stated audience; do not assume all readers are novices.", "Use audience-appropriate language and explain necessary technical terms."),
  check("overloaded-sentence", "Nesting, delayed subjects or chained negation makes a sentence hard to follow.", "A long but clear sentence, or a necessary logical or legal relationship.", "Split or reorder the sentence while preserving its conditions and logical relationships."),
  check("generic-opening", "Generic scene-setting delays the substantive answer.", "Useful scope, time frame, constraints or decision context.", "Start with the substantive point and retain useful scope."),
  check("request-echo", "The opening repeats the request without advancing it.", "A restatement narrows scope, corrects a premise or establishes needed context.", "Remove the request echo and begin with the answer."),
  check("self-announcement", "The response announces its own polished or comprehensive output.", "A meaningful statement of scope, limitations or omitted material.", "Remove the self-announcement while retaining meaningful limitations."),
  check("repeated-point", "The same proposition recurs without new evidence, implication or synthesis.", "A useful summary, comparison, reference repetition or added consequence; word overlap alone is insufficient.", "Combine the repeated point and retain new evidence or implications."),
  check("stock-closing", "A generic challenge, reassurance or future outlook is unrelated to the findings.", "An actionable next step or conclusion derived from the findings.", "End with the supported conclusion or next step; remove the stock closing."),
  check("fragmented-structure", "Headings or bullets fragment a connected short explanation without navigation benefit.", "Parallel items, steps, reference sections or a requested format.", "Join the connected explanation and retain structure that helps navigation."),
  check("mechanical-labels", "Repeated bold label-and-explanation items add no lookup distinction.", "Reference entries, distinct concepts or an explicitly requested template.", "Remove redundant labels and connect the explanation where the ideas belong together."),
];

export const WRITING_CHECK_IDS = WRITING_CHECKS.map((c) => c.id);
export function writingCheck(id: unknown): WritingCheck | undefined {
  return typeof id === "string" ? WRITING_CHECKS.find((c) => c.id === id) : undefined;
}

export const WRITING_RUBRIC = WRITING_CHECKS.map((c) =>
  `${c.id} [${c.category}, warn]: ${c.defect} EXCEPT: ${c.exception} Revision target: ${c.instruction}`,
).join("\n");
