import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { args, cliError, json, PromptSchema, required } from "../src/common.js";
import { adjudicate, annotate, marks, readAnnotations } from "../src/annotations.js";

async function main() {
  const o = args(process.argv.slice(2), ["document", "context", "annotator", "marks", "adjudicator", "note"]);
  if (o.help) {
    console.log("pnpm eval:annotate --document <file.md> --context prompt.json --annotator <id> [--marks spans.json]\nAdjudicate: --adjudicator <third-id> --marks spans.json --note <rationale>");
    return;
  }
  const file = required(o, "document");
  if (!file.endsWith(".md")) throw new Error("Expected .md document");
  const text = readFileSync(file, "utf8");
  if (o.context) {
    const prompt = PromptSchema.parse(json(o.context));
    console.log(JSON.stringify({ user_message: prompt.user, style_constraints: prompt.style_constraints, system: prompt.system, profile: prompt.profile }, null, 2));
  }
  // Deliberately omit the filename, metadata/model identity and other annotators' marks.
  console.log([...text].map((c) => {
    const n = c.codePointAt(0) ?? 0;
    return (n < 32 && c !== "\n" && c !== "\t") || (n >= 127 && n <= 159) ? "�" : c;
  }).join(""));
  if (o.adjudicator) {
    console.log(JSON.stringify(readAnnotations(file).map((r) => ({ annotator: r.annotator, spans: r.spans })), null, 2));
    adjudicate(file, o.adjudicator, json(required(o, "marks")), required(o, "note"));
  } else if (o.marks) {
    annotate(file, required(o, "annotator"), json(o.marks), o.context);
  } else {
    if (!stdin.isTTY) throw new Error("Use --marks for non-interactive annotation");
    const rl = createInterface({ input: stdin, output: stdout });
    const spans: unknown[] = [];
    try {
      console.log("Enter category start end [rule_id], using UTF-16 offsets; 'find <exact text>' shows offsets; 'done' saves; 'undo' removes the last mark. Empty marks are a completed clean annotation.");
      for (;;) {
        const line = (await rl.question("> ")).trim();
        if (line === "done") break;
        if (line === "undo") { spans.pop(); continue; }
        if (line.startsWith("find ") && line.length > 5) {
          const needle = line.slice(5);
          for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) console.log(`${at} ${at + needle.length}`);
          continue;
        }
        const [category, start, end, rule] = line.split(/\s+/);
        const mark = { category, start: Number(start), end: Number(end), ...(rule ? { rule_id: rule } : {}) };
        try { marks([mark], text); spans.push(mark); console.log(JSON.stringify(text.slice(mark.start, mark.end))); }
        catch { console.log("Invalid mark. Use category start end [rule_id]."); }
      }
      annotate(file, required(o, "annotator"), spans, o.context);
    } finally { rl.close(); }
  }
  console.log("Saved.");
}
main().catch(cliError);
