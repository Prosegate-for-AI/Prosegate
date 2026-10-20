// Printable form of an eval:rules report: the compact per-rule table, the failures, and an honest
// statement of what was and was not measured.
import type { MetricResult } from "./rules-gates.js";
import { fmtPct } from "./rules-gates.js";
import type { Report } from "./rules-run.js";

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));

function flag(status: MetricResult["status"]): string {
  switch (status) {
    case "fail":
      return " FAIL";
    case "insufficient":
      return " (insufficient)";
    default:
      return "";
  }
}

function cell(m: MetricResult, none: string): string {
  if (m.status === "n/a") return `n/a (${none})`;
  return `${m.num}/${m.den} ${fmtPct(m.value)}${flag(m.status)}`;
}

export function formatReport(report: Report, reportPath: string): string {
  const out: string[] = [];
  const c = report.corpora;
  out.push(
    `eval:rules  engine ${report.engine.version}  corpora: human-control ${c.human_control.docs} docs, ai ${c.ai.docs} docs / ${c.ai.gold_spans} gold spans, adversarial ${c.adversarial.human_machinelike}+${c.adversarial.ai_passed}`,
  );
  for (const p of report.packs) {
    const l = p.latency;
    out.push("");
    out.push(
      `pack ${p.id}@${p.version}  ${p.rules.length} rules  examples ${p.examples.rules_pass}/${p.examples.rules_total} rules ${p.examples.status} (${p.examples.pass}/${p.examples.total} examples)  ` +
        `latency p95 ${l.p95_ms.toFixed(1)} ms (gate ${l.gate_ms}, target ${l.target_ms}${l.meets_target ? ", met" : ", NOT met"}; ${l.source}, ${l.documents} doc${l.documents === 1 ? "" : "s"}) ${l.status}`,
    );
    const rows = [["rule", "sev", "example", "FP", "precision", "recall (category)", "ms p95", "verdict"]];
    for (const r of p.rules) {
      const cat = p.categories.find((k) => k.category === r.category);
      const recall = cat === undefined ? "n/a" : cat.recall.status === "ungated" ? `${cat.recall.num}/${cat.recall.den} ${fmtPct(cat.recall.value)} (no gate)` : cell(cat.recall, "0 items");
      rows.push([
        r.id,
        r.gate_severity === r.severity ? r.severity + (r.severity_differs_by_profile ? "*" : "") : `${r.severity}>${r.gate_severity}`,
        `${r.example.hit.pass + r.example.miss.pass}/${r.example.hit.total + r.example.miss.total}${r.example.status === "fail" ? " FAIL" : ""}`,
        cell(r.false_positive, "0 items") + (r.false_positive.unfinished_docs > 0 ? ` UNFINISHED(${r.false_positive.unfinished_docs})` : ""),
        cell(r.precision, r.precision.items === 0 ? "0 items" : "0 hits"),
        recall,
        r.latency_p95_ms === null ? "-" : r.latency_p95_ms.toFixed(2),
        p.rule_verdicts[r.id] ?? "?",
      ]);
    }
    const widths = (rows[0] as string[]).map((_, i) => Math.max(...rows.map((row) => (row[i] as string).length)));
    for (const row of rows) out.push(row.map((v, i) => pad(v, widths[i] as number)).join("  ").trimEnd());
  }
  out.push("");
  out.push("verdict: PASS = example, FP and precision all measured and within budget; PARTIAL = nothing failed but a gate was n/a or insufficient (under 30 items, or under 20 hits for precision); FAIL = a gate failed.");
  out.push("sev: pack severity. warn>block = a bundled profile promotes the rule, so the pooled gate uses the strictest effective severity (and each profile with 30+ documents gates at its own). sev* = a profile softens or disables it; the report lists effective_severity per profile.");

  if (report.failures.length > 0) {
    out.push("");
    out.push(`GATE FAILURES (${report.failures.length}):`);
    for (const f of report.failures) out.push(`  FAIL [${f.metric}] ${f.message}`);
  }
  if (report.notes.length > 0) {
    out.push("");
    out.push("Notes:");
    for (const n of report.notes) out.push(`  - ${n}`);
  }

  const cov = report.metric_coverage;
  const describe = (name: string, b: Record<string, number>): string => `${name} ${Object.entries(b).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}`;
  out.push("");
  out.push(`annotations: ${report.annotations.paired}/${report.annotations.documents} paired, ${report.annotations.adjudicated} adjudicated; Cohen's kappa per category is in the JSON report.`);
  out.push(`coverage (rules; recall by category): ${describe("examples", cov.example)}; ${describe("FP", cov.false_positive)}; ${describe("precision", cov.precision)}; ${describe("recall", cov.recall)}`);
  const unmeasured = ["false_positive", "precision", "recall"].filter((k) => {
    const b = cov[k as "false_positive" | "precision" | "recall"];
    return (b["pass"] ?? 0) + (b["fail"] ?? 0) === 0;
  });
  if (report.result !== "fail" && unmeasured.length > 0) {
    out.push(`NOTE: ${unmeasured.join(", ")} could not be measured on these corpora (n/a or insufficient); this exit 0 says nothing about them.`);
  }
  out.push(`baseline: ${report.baseline.status}${report.baseline.path === null ? "" : ` (${report.baseline.entries} entries)`}`);
  const notPass = report.packs.reduce((n, p) => n + Object.values(p.rule_verdicts).filter((v) => v !== "PASS").length, 0);
  const total = report.packs.reduce((n, p) => n + p.rules.length, 0);
  const partial = report.result === "partial" ? ` (${notPass} of ${total} rules are not PASS${unmeasured.length > 0 ? `; ${unmeasured.join(", ")} not measured` : ""})` : "";
  out.push(`RESULT: ${report.result.toUpperCase()}${partial}  wall ${(report.wall_ms / 1000).toFixed(2)} s  report ${reportPath}`);
  return out.join("\n");
}
