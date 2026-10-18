// Entry of the cold-start measurement (cold.test.ts): bundled into one file, then run in a fresh
// `node` process. It does what a process-per-event hook does with the rules stage: load the engine,
// parse and resolve the bundled profile and pack, compile `core`, review a 2,000-word text, exit.
import { readFileSync } from "node:fs";
import { BUNDLED_PACK_YAML, bundledPackSources, bundledProfileSources, parseRulePackYaml, resolveProfile } from "@prosegate/profiles";
import { compilePack, reviewRulesDetailed } from "../../src/index.js";

const loaded = performance.now(); // ms since the process started: Node startup plus module load
const text = readFileSync(process.argv[2] as string, "utf8");

const t0 = performance.now();
const parsed = parseRulePackYaml(BUNDLED_PACK_YAML["core@0.1.0"]);
if (!parsed.ok) throw new Error(parsed.error.message);
const resolved = resolveProfile("local/base", { profiles: bundledProfileSources(), packs: bundledPackSources() });
const t1 = performance.now();
const pack = compilePack(parsed.value);
const t2 = performance.now();
const { result } = reviewRulesDetailed({
  request: {
    schema: "prosegate.review/1",
    text,
    context: { user_message: "", style_constraints: "", mode: "interactive" },
    profile_id: "local/base",
    pass: 1,
    stages: ["rules"],
    session_id: "s",
    turn_id: "t",
    prior_findings: [],
  },
  resolved,
  packs: [pack],
  enforce: true,
});
const t3 = performance.now();
console.log(
  JSON.stringify({
    loaded_ms: loaded,
    parse_resolve_ms: t1 - t0,
    compile_ms: t2 - t1,
    review_ms: t3 - t2,
    rules_latency_ms: result.stats.rules_latency_ms,
    findings: result.findings.length,
    verdict: result.verdict,
  }),
);
